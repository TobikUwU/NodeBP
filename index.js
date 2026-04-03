const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const crypto = require("crypto");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");
const { execSync } = require("child_process");

const AdmZip = require("adm-zip");
const sharp = require("sharp");
const gltfPipeline = require("gltf-pipeline");
const http2Express = require("http2-express");

const app = http2Express(express);
const port = 3000;
const httpsPort = 3443;

const processGltf = gltfPipeline.processGltf;

const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(__dirname, "tmp_uploads");
const LIBRARY_DIR = path.join(PUBLIC_DIR, "library");

const LOD_PROFILES = [
  {
    id: "preview",
    label: "Preview",
    textureMaxSize: 512,
    dracoOptions: {
      compressionLevel: 10,
      quantizePositionBits: 8,
      quantizeNormalBits: 6,
      quantizeTexcoordBits: 8,
      quantizeColorBits: 6,
      quantizeGenericBits: 6,
      unifiedQuantization: true,
    },
  },
  {
    id: "standard",
    label: "Standard",
    textureMaxSize: 1024,
    dracoOptions: {
      compressionLevel: 9,
      quantizePositionBits: 10,
      quantizeNormalBits: 8,
      quantizeTexcoordBits: 10,
      quantizeColorBits: 8,
      quantizeGenericBits: 8,
      unifiedQuantization: true,
    },
  },
  {
    id: "full",
    label: "Full",
    textureMaxSize: 2048,
    dracoOptions: {
      compressionLevel: 8,
      quantizePositionBits: 12,
      quantizeNormalBits: 10,
      quantizeTexcoordBits: 12,
      quantizeColorBits: 8,
      quantizeGenericBits: 10,
      unifiedQuantization: true,
    },
  },
];

function ensureSslCertificates() {
  const keyPath = path.join(__dirname, "key.pem");
  const certPath = path.join(__dirname, "cert.pem");

  try {
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
      console.log("SSL certifikat neexistuje, generuji novy self-signed.");
      const opensslCmd = `openssl req -x509 -newkey rsa:4096 -keyout "${keyPath}" -out "${certPath}" -sha256 -days 3650 -nodes -subj "/C=CZ/ST=Czechia/L=Prague/O=Development/OU=Dev/CN=localhost"`;
      execSync(opensslCmd);
      console.log("SSL certifikat vytvoren.");
    }
  } catch (error) {
    console.error("Nepodarilo se zajistit SSL certifikaty:", error.message);
  }
}

ensureSslCertificates();

for (const dir of [PUBLIC_DIR, UPLOAD_DIR, LIBRARY_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const uploadZip = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 1024 * 1024 * 1024,
  },
});

app.use(express.json());

function slugifyName(name) {
  return name
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[-\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function createModelId(fileName) {
  const baseName = path.parse(fileName).name || "model";
  const slug = slugifyName(baseName) || "model";
  const suffix = crypto.randomBytes(4).toString("hex");
  return `${slug}-${suffix}`;
}

function getAssetContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".gltf": "model/gltf+json",
    ".glb": "model/gltf-binary",
    ".bin": "application/octet-stream",
    ".json": "application/json; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".ktx2": "image/ktx2",
  };

  return types[ext] || "application/octet-stream";
}

async function getAllFiles(dirPath, collected = []) {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await getAllFiles(entryPath, collected);
      continue;
    }
    collected.push(entryPath);
  }

  return collected;
}

async function copyDirectory(sourceDir, targetDir) {
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  await fsp.mkdir(targetDir, { recursive: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
      continue;
    }

    await fsp.copyFile(sourcePath, targetPath);
  }
}

async function computeDirectorySize(dirPath) {
  const files = await getAllFiles(dirPath);
  let total = 0;

  for (const filePath of files) {
    const stats = await fsp.stat(filePath);
    total += stats.size;
  }

  return total;
}

async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function gzipFile(filePath) {
  const gzipPath = `${filePath}.gz`;
  await pipeline(
    fs.createReadStream(filePath),
    zlib.createGzip({ level: 9 }),
    fs.createWriteStream(gzipPath),
  );
}

function addImageIndexFromTextureInfo(gltf, imageSet, textureInfo) {
  if (!textureInfo || !Number.isInteger(textureInfo.index)) {
    return;
  }

  const texture = gltf.textures?.[textureInfo.index];
  if (!texture || !Number.isInteger(texture.source)) {
    return;
  }

  imageSet.add(texture.source);
}

function collectDataTextureImageIndices(gltf) {
  const dataTextureImages = new Set();

  for (const material of gltf.materials || []) {
    const pbr = material.pbrMetallicRoughness || {};
    const extensions = material.extensions || {};

    addImageIndexFromTextureInfo(
      gltf,
      dataTextureImages,
      pbr.metallicRoughnessTexture,
    );
    addImageIndexFromTextureInfo(
      gltf,
      dataTextureImages,
      material.normalTexture,
    );
    addImageIndexFromTextureInfo(
      gltf,
      dataTextureImages,
      material.occlusionTexture,
    );
    addImageIndexFromTextureInfo(
      gltf,
      dataTextureImages,
      extensions.KHR_materials_pbrSpecularGlossiness?.specularGlossinessTexture,
    );
    addImageIndexFromTextureInfo(
      gltf,
      dataTextureImages,
      extensions.KHR_materials_specular?.specularTexture,
    );
    addImageIndexFromTextureInfo(
      gltf,
      dataTextureImages,
      extensions.KHR_materials_clearcoat?.clearcoatTexture,
    );
    addImageIndexFromTextureInfo(
      gltf,
      dataTextureImages,
      extensions.KHR_materials_clearcoat?.clearcoatRoughnessTexture,
    );
    addImageIndexFromTextureInfo(
      gltf,
      dataTextureImages,
      extensions.KHR_materials_clearcoat?.clearcoatNormalTexture,
    );
    addImageIndexFromTextureInfo(
      gltf,
      dataTextureImages,
      extensions.KHR_materials_transmission?.transmissionTexture,
    );
    addImageIndexFromTextureInfo(
      gltf,
      dataTextureImages,
      extensions.KHR_materials_volume?.thicknessTexture,
    );
    addImageIndexFromTextureInfo(
      gltf,
      dataTextureImages,
      extensions.KHR_materials_anisotropy?.anisotropyTexture,
    );
    addImageIndexFromTextureInfo(
      gltf,
      dataTextureImages,
      extensions.KHR_materials_iridescence?.iridescenceTexture,
    );
    addImageIndexFromTextureInfo(
      gltf,
      dataTextureImages,
      extensions.KHR_materials_iridescence?.iridescenceThicknessTexture,
    );
  }

  return dataTextureImages;
}

async function optimizeTextures(gltfPath, resourceDir, profile) {
  const gltf = JSON.parse(await fsp.readFile(gltfPath, "utf8"));
  const dataTextureImages = collectDataTextureImageIndices(gltf);

  if (!Array.isArray(gltf.images) || gltf.images.length === 0) {
    return gltf;
  }

  for (const [index, image] of gltf.images.entries()) {
    if (!image.uri) {
      continue;
    }

    const imagePath = path.join(resourceDir, image.uri);

    try {
      await fsp.access(imagePath);
    } catch {
      continue;
    }

    const metadata = await sharp(imagePath).metadata();
    const ext = path.extname(imagePath).toLowerCase();
    const baseName = path.basename(imagePath, ext);
    const hasAlpha = metadata.hasAlpha === true || metadata.channels === 4;
    const isDataTexture = dataTextureImages.has(index);
    const useJpeg = !hasAlpha && !isDataTexture;
    const outputExt = useJpeg ? ".jpg" : ".png";
    const optimizedPath = path.join(
      resourceDir,
      `${baseName}_${profile.id}${outputExt}`,
    );

    let pipelineBuilder = sharp(imagePath).resize({
      width: profile.textureMaxSize,
      height: profile.textureMaxSize,
      fit: "inside",
      withoutEnlargement: true,
    });

    if (useJpeg) {
      pipelineBuilder = pipelineBuilder.jpeg({
        quality:
          profile.id === "preview" ? 68 : profile.id === "standard" ? 82 : 90,
        mozjpeg: true,
      });
    } else {
      pipelineBuilder = pipelineBuilder.png({
        compressionLevel: 9,
        palette: !hasAlpha,
      });
    }

    await pipelineBuilder.toFile(optimizedPath);

    image.uri = path.basename(optimizedPath);
    image.mimeType = useJpeg ? "image/jpeg" : "image/png";
  }

  await writeJson(gltfPath, gltf);
  return gltf;
}

async function saveProcessedLod(gltf, resourceDir, targetDir, profile) {
  await fsp.mkdir(targetDir, { recursive: true });

  const results = await processGltf(gltf, {
    name: "scene.gltf",
    resourceDirectory: resourceDir,
    separate: true,
    separateTextures: true,
    dracoOptions: profile.dracoOptions,
  });

  const scenePath = path.join(targetDir, "scene.gltf");
  await writeJson(scenePath, results.gltf);

  for (const [relativePath, source] of Object.entries(
    results.separateResources,
  )) {
    const outputPath = path.join(targetDir, relativePath);
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    await fsp.writeFile(outputPath, source);
  }

  await gzipFile(scenePath);

  const files = await getAllFiles(targetDir);
  for (const filePath of files) {
    if (path.extname(filePath).toLowerCase() === ".bin") {
      await gzipFile(filePath);
    }
  }

  const byteSize = await computeDirectorySize(targetDir);
  return {
    id: profile.id,
    label: profile.label,
    gltf: `/model-assets/${path.basename(path.dirname(targetDir))}/${profile.id}/scene.gltf`,
    textureMaxSize: profile.textureMaxSize,
    byteSize,
  };
}

async function buildModelPackageFromZip(uploadedZipPath, originalName) {
  const modelId = createModelId(originalName);
  const packageDir = path.join(LIBRARY_DIR, modelId);
  const tempRoot = await fsp.mkdtemp(path.join(UPLOAD_DIR, "model-"));
  const extractedDir = path.join(tempRoot, "source");

  await fsp.mkdir(extractedDir, { recursive: true });

  try {
    const zip = new AdmZip(uploadedZipPath);
    zip.extractAllTo(extractedDir, true);

    const files = await getAllFiles(extractedDir);
    const gltfFilePath = files.find((filePath) =>
      filePath.toLowerCase().endsWith(".gltf"),
    );

    if (!gltfFilePath) {
      throw new Error("ZIP musi obsahovat .gltf soubor.");
    }

    const originalModelName = path.parse(gltfFilePath).name;
    await fsp.mkdir(packageDir, { recursive: true });

    const lods = [];

    for (const profile of LOD_PROFILES) {
      const variantSourceDir = path.join(tempRoot, profile.id);
      await copyDirectory(path.dirname(gltfFilePath), variantSourceDir);

      const variantGltfPath = path.join(
        variantSourceDir,
        path.basename(gltfFilePath),
      );

      const optimizedGltf = await optimizeTextures(
        variantGltfPath,
        variantSourceDir,
        profile,
      );

      const lodOutputDir = path.join(packageDir, profile.id);
      const lodInfo = await saveProcessedLod(
        optimizedGltf,
        variantSourceDir,
        lodOutputDir,
        profile,
      );
      lods.push(lodInfo);
    }

    const manifest = {
      id: modelId,
      name: originalModelName,
      sourceFile: originalName,
      createdAt: new Date().toISOString(),
      mode: "progressive-quality",
      notes:
        "LOD varianty se lisi kvalitou textur a presnosti Draco komprese. Topologie site se nemeni.",
      lods,
    };

    await writeJson(path.join(packageDir, "manifest.json"), manifest);
    await gzipFile(path.join(packageDir, "manifest.json"));

    return manifest;
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    await fsp.unlink(uploadedZipPath).catch(() => {});
  }
}

async function readManifest(modelId) {
  const manifestPath = path.join(LIBRARY_DIR, modelId, "manifest.json");
  return JSON.parse(await fsp.readFile(manifestPath, "utf8"));
}

async function listModels() {
  const entries = await fsp.readdir(LIBRARY_DIR, { withFileTypes: true });
  const models = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const manifest = await readManifest(entry.name);
      models.push({
        id: manifest.id,
        name: manifest.name,
        createdAt: manifest.createdAt,
        lodCount: manifest.lods.length,
        previewUrl: manifest.lods[0]?.gltf || null,
        totalSizeInMB: Number(
          (
            manifest.lods.reduce((sum, lod) => sum + lod.byteSize, 0) /
            1024 /
            1024
          ).toFixed(2),
        ),
      });
    } catch (error) {
      console.error(
        `Nepodarilo se nacist manifest ${entry.name}:`,
        error.message,
      );
    }
  }

  models.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return models;
}

async function streamAsset(req, res, filePath) {
  const stats = await fsp.stat(filePath);
  const etag = `"${stats.size}-${stats.mtimeMs}"`;

  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return;
  }

  const acceptsGzip = (req.headers["accept-encoding"] || "").includes("gzip");
  const gzipPath = `${filePath}.gz`;
  let responsePath = filePath;
  let responseStats = stats;
  let compressed = false;

  if (acceptsGzip) {
    try {
      responseStats = await fsp.stat(gzipPath);
      responsePath = gzipPath;
      compressed = true;
    } catch {}
  }

  res.setHeader("ETag", etag);
  res.setHeader("Vary", "Accept-Encoding");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("Content-Type", getAssetContentType(filePath));
  res.setHeader("Content-Length", responseStats.size);

  if (compressed) {
    res.setHeader("Content-Encoding", "gzip");
  }

  await pipeline(fs.createReadStream(responsePath), res);
}

app.post("/upload-model", uploadZip.single("modelZip"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "Nebyl nahran zadny ZIP soubor.",
    });
  }

  try {
    console.log(`Zpracovavam ${req.file.originalname}`);
    const manifest = await buildModelPackageFromZip(
      req.file.path,
      req.file.originalname,
    );

    res.json({
      success: true,
      message: `Model ${manifest.name} byl zpracovan.`,
      model: manifest,
    });
  } catch (error) {
    console.error("Chyba pri uploadu:", error);
    await fsp.unlink(req.file.path).catch(() => {});

    res.status(500).json({
      success: false,
      message: error.message || "Chyba pri zpracovani modelu.",
    });
  }
});

app.get("/api/models", async (req, res) => {
  try {
    const models = await listModels();
    res.json({
      success: true,
      count: models.length,
      models,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.get("/api/models/:modelId/manifest", async (req, res) => {
  try {
    const manifest = await readManifest(req.params.modelId);
    res.json({
      success: true,
      model: manifest,
    });
  } catch {
    res.status(404).json({
      success: false,
      message: "Manifest nenalezen.",
    });
  }
});

app.delete("/api/models/:modelId", async (req, res) => {
  const packageDir = path.join(LIBRARY_DIR, req.params.modelId);

  try {
    await fsp.access(path.join(packageDir, "manifest.json"));
  } catch {
    return res.status(404).json({
      success: false,
      message: "Model nebyl nalezen.",
    });
  }

  try {
    await fsp.rm(packageDir, { recursive: true, force: true });
    res.json({
      success: true,
      message: "Model byl smazan.",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.get(/^\/model-assets\/([^/]+)\/([^/]+)\/(.+)$/, async (req, res) => {
  const [, modelId, lodId, fileName] = req.params;
  const packageDir = path.resolve(LIBRARY_DIR, modelId);
  const assetPath = path.resolve(packageDir, lodId, fileName);

  if (!assetPath.startsWith(`${packageDir}${path.sep}`)) {
    return res.status(400).json({
      success: false,
      message: "Neplatna cesta assetu.",
    });
  }

  try {
    await streamAsset(req, res, assetPath);
  } catch (error) {
    if (!res.headersSent) {
      res.status(404).json({
        success: false,
        message: "Asset nenalezen.",
      });
    }
    if (!["ENOENT", "ERR_STREAM_PREMATURE_CLOSE"].includes(error.code)) {
      console.error("Chyba pri streamovani assetu:", error.message);
    }
  }
});

app.get("/model-assets/:modelId/manifest.json", async (req, res) => {
  const manifestPath = path.join(
    LIBRARY_DIR,
    req.params.modelId,
    "manifest.json",
  );

  try {
    await streamAsset(req, res, manifestPath);
  } catch {
    res.status(404).json({
      success: false,
      message: "Manifest nenalezen.",
    });
  }
});

app.use(express.static(PUBLIC_DIR));

app.listen(port, "0.0.0.0", () => {
  console.log(`HTTP/1.1 server bezi na http://0.0.0.0:${port}`);
});

try {
  const http2 = require("http2");
  const sslOptions = {
    key: fs.readFileSync(path.join(__dirname, "key.pem")),
    cert: fs.readFileSync(path.join(__dirname, "cert.pem")),
    allowHTTP1: true,
  };

  const http2Server = http2.createSecureServer(sslOptions, app);
  http2Server.listen(httpsPort, "0.0.0.0", () => {
    console.log(`HTTPS/HTTP2 server bezi na https://0.0.0.0:${httpsPort}`);
  });
} catch (error) {
  console.error("HTTPS server se nepodarilo spustit:", error.message);
}
