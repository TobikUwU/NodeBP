import path from "node:path";
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execSync } from "node:child_process";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  cloneDocument,
  dedup,
  prune,
  reorder,
  simplify,
  weld,
} from "@gltf-transform/functions";
import Busboy from "busboy";
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";
import unzipper from "unzipper";

const fsp = fs.promises;
const __dirname = import.meta.dir;

/**
 * Zajistí existenci SSL certifikátů (key.pem, cert.pem) pro HTTPS
 * a v případě potřeby vygeneruje nové (self-signed).
 */
function ensureSslCertificates() {
  const keyPath = path.join(__dirname, "key.pem");
  const certPath = path.join(__dirname, "cert.pem");

  try {
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
      console.log("SSL certifikát neexistuje, generuji nový (self-signed)...");
      const opensslCmd = `openssl req -x509 -newkey rsa:4096 -keyout "${keyPath}" -out "${certPath}" -sha256 -days 3650 -nodes -subj "/C=CZ/ST=Czechia/L=Prague/O=Development/OU=Dev/CN=localhost"`;
      execSync(opensslCmd);
      console.log(
        "Nový SSL certifikát byl úspěšně vygenerován (key.pem, cert.pem).",
      );
    } else {
      console.log("SSL certifikát již existuje.");
    }
  } catch (error) {
    console.error("Došlo k chybě při zajišťování SSL certifikátů:", error);
    // Toto může být kritické pro start HTTPS serveru
    // process.exit(1);
  }
}

// Spustí kontrolu SSL certifikátů na začátku aplikace
ensureSslCertificates();

const port = Number(process.env.PORT || 3000);
const httpsPort = Number(process.env.HTTPS_PORT || 3443);

// Konfigurace
const UPLOAD_DIR = "./tmp_uploads";
const PUBLIC_DIR = path.join(__dirname, "public");
const MODELS_DIR = path.join(__dirname, "public", "models");
const METADATA_DIR = path.join(__dirname, "public", "metadata");
const MAX_UPLOAD_SIZE = 5 * 1024 * 1024 * 1024;
const LOD_CONFIGS = [
  { name: "lod0", suffix: "", ratio: 0.45, error: 0.015 },
  { name: "lod1", suffix: ".lod1", ratio: 0.2, error: 0.03 },
  { name: "lod2", suffix: ".lod2", ratio: 0.08, error: 0.06 },
];
const uploadStatus = {
  active: false,
  phase: "idle",
  message: "Žádný aktivní upload.",
  startedAt: null,
  updatedAt: null,
  logs: [],
};

// Vytvoření potřebných složek
console.log("Vytvářím složky...");
[UPLOAD_DIR, MODELS_DIR, METADATA_DIR].forEach((dir) => {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`${dir}`);
    } else {
      console.log(`${dir} už existuje`);
    }
  } catch (err) {
    console.error(`Chyba při vytváření ${dir}:`, err.message);
  }
});

// UTILITY FUNKCE

async function getAllFiles(dirPath, arrayOfFiles = []) {
  const files = await fsp.readdir(dirPath);

  await Promise.all(
    files.map(async (file) => {
      const filePath = path.join(dirPath, file);
      const stat = await fsp.stat(filePath);
      if (stat.isDirectory()) {
        await getAllFiles(filePath, arrayOfFiles);
      } else {
        arrayOfFiles.push(filePath);
      }
    }),
  );

  return arrayOfFiles;
}

async function getDirectorySize(dirPath) {
  const files = await getAllFiles(dirPath);
  const stats = await Promise.all(files.map((filePath) => fsp.stat(filePath)));
  return stats.reduce((sum, stat) => sum + stat.size, 0);
}

async function writeModelMetadata(modelName, lods, modelDir) {
  const baseLod = lods[0];
  const stats = await fsp.stat(path.join(modelDir, baseLod.file));
  const totalSize = await getDirectorySize(modelDir);
  const metadata = {
    modelName,
    type: "gltf",
    entryFile: baseLod.file,
    entryUrl: `/models/${modelName}/${baseLod.file}`,
    assetDirectory: `/models/${modelName}/`,
    lods: lods.map((lod) => ({
      name: lod.name,
      file: lod.file,
      url: `/models/${modelName}/${lod.file}`,
      ratio: lod.ratio,
      error: lod.error,
    })),
    size: totalSize,
    sizeInMB: parseFloat((totalSize / 1024 / 1024).toFixed(2)),
    created: new Date().toISOString(),
    entryModified: stats.mtime,
  };

  await fsp.writeFile(
    path.join(METADATA_DIR, `${modelName}.json`),
    JSON.stringify(metadata, null, 2),
  );

  return metadata;
}

function pushUploadLog(message, phase = uploadStatus.phase) {
  const now = new Date().toISOString();
  uploadStatus.active =
    phase !== "done" && phase !== "error" && phase !== "idle";
  uploadStatus.phase = phase;
  uploadStatus.message = message;
  uploadStatus.updatedAt = now;
  if (!uploadStatus.startedAt && uploadStatus.active) {
    uploadStatus.startedAt = now;
  }
  uploadStatus.logs.push({ time: now, phase, message });
  uploadStatus.logs = uploadStatus.logs.slice(-30);
  console.log(`[upload:${phase}] ${message}`);
}

function resetUploadStatus() {
  uploadStatus.active = false;
  uploadStatus.phase = "idle";
  uploadStatus.message = "Žádný aktivní upload.";
  uploadStatus.startedAt = null;
  uploadStatus.updatedAt = new Date().toISOString();
  uploadStatus.logs = [];
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

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
      extensions.KHR_materials_ior?.iorTexture,
    );
    addImageIndexFromTextureInfo(
      gltf,
      dataTextureImages,
      extensions.KHR_materials_dispersion?.dispersionTexture,
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

// CHUNKING SYSTÉM JE VYPNUTÝ. Backend nyní ukládá GLTF + assety.

// OPTIMALIZACE TEXTUR

async function optimizeTextures(gltfPath, resourceDir) {
  try {
    const gltfContent = await fsp.readFile(gltfPath, "utf8");
    const gltf = JSON.parse(gltfContent);
    const dataTextureImages = collectDataTextureImageIndices(gltf);

    if (!gltf.images || gltf.images.length === 0) {
      console.log("Model neobsahuje žádné textury.");
      return gltf;
    }

    console.log(
      `Nalezeno ${gltf.images.length} textur, spouštím optimalizaci (paralelně)...`,
    );

    const textureTasks = gltf.images.map(async (image, i) => {
      if (!image.uri) {
        console.log(`Přeskakuji embedded texturu [${i}]`);
        return { originalSize: 0, optimizedSize: 0, skipped: true };
      }

      const imagePath = path.join(resourceDir, image.uri);

      try {
        await fsp.access(imagePath);
      } catch {
        console.log(`Textura nenalezena: ${imagePath}`);
        return { originalSize: 0, optimizedSize: 0, skipped: true };
      }

      const ext = path.extname(imagePath).toLowerCase();
      const baseName = path.basename(imagePath, ext);

      try {
        const stats = await fsp.stat(imagePath);
        const originalSize = stats.size;
        const imageProcessor = sharp(imagePath);
        const imgMeta = await imageProcessor.metadata();

        let maxSize;
        if (imgMeta.width > 4096 || imgMeta.height > 4096) {
          maxSize = 1024;
        } else if (imgMeta.width > 2048 || imgMeta.height > 2048) {
          maxSize = 1024;
        } else if (imgMeta.width > 1024 || imgMeta.height > 1024) {
          maxSize = 512;
        } else if (imgMeta.width > 512 || imgMeta.height > 512) {
          maxSize = 512;
        } else {
          maxSize = imgMeta.width;
        }

        const hasAlpha = imgMeta.hasAlpha === true || imgMeta.channels === 4;
        const isDataTexture = dataTextureImages.has(i);
        const useJpeg =
          !hasAlpha && !isDataTexture && (ext === ".jpg" || ext === ".jpeg");
        const outputExt = useJpeg ? ".jpg" : ".png";
        const outputMimeType = useJpeg ? "image/jpeg" : "image/png";
        const optimizedPath = path.join(
          resourceDir,
          `${baseName}_opt${outputExt}`,
        );

        let pipeline = imageProcessor.resize(maxSize, maxSize, {
          fit: "inside",
          withoutEnlargement: true,
        });

        if (useJpeg) {
          pipeline = pipeline.jpeg({
            quality: 72,
            mozjpeg: true,
            chromaSubsampling: "4:2:0",
          });
        } else {
          pipeline = pipeline.png({
            compressionLevel: 9,
            palette: true,
          });
        }

        await pipeline.toFile(optimizedPath);

        const optimizedStats = await fsp.stat(optimizedPath);
        const optimizedSize = optimizedStats.size;

        const savings = ((1 - optimizedSize / originalSize) * 100).toFixed(1);
        const origMB = (originalSize / 1024 / 1024).toFixed(2);
        const optMB = (optimizedSize / 1024 / 1024).toFixed(2);

        console.log(`${image.uri}`);
        console.log(`${origMB} MB → ${optMB} MB (úspora ${savings}%)`);

        image.uri = `${baseName}_opt${outputExt}`;
        image.mimeType = outputMimeType;

        return { originalSize, optimizedSize, skipped: false };
      } catch (err) {
        console.error(`Chyba při optimalizaci ${imagePath}:`, err.message);
        return { originalSize: 0, optimizedSize: 0, skipped: true };
      }
    });

    const results = await Promise.all(textureTasks);

    const totalOriginalSize = results.reduce(
      (sum, r) => sum + r.originalSize,
      0,
    );
    const totalOptimizedSize = results.reduce(
      (sum, r) => sum + r.optimizedSize,
      0,
    );

    if (totalOriginalSize > 0) {
      const totalSavings = (
        (1 - totalOptimizedSize / totalOriginalSize) *
        100
      ).toFixed(1);
      console.log(`\nCelková úspora textur: ${totalSavings}%`);
      console.log(
        `Původní: ${(totalOriginalSize / 1024 / 1024).toFixed(2)} MB`,
      );
      console.log(
        `Optimalizováno: ${(totalOptimizedSize / 1024 / 1024).toFixed(2)} MB\n`,
      );
    }

    await fsp.writeFile(gltfPath, JSON.stringify(gltf, null, 2));

    return gltf;
  } catch (err) {
    console.error("Chyba při optimalizaci textur:", err);
    throw err;
  }
}

async function buildStreamingPackage(modelName, gltfPath, outputDir) {
  await MeshoptEncoder.ready;
  await MeshoptSimplifier.ready;

  const sourceDocument = await io.read(gltfPath);
  const writtenLods = [];

  for (const lodConfig of LOD_CONFIGS) {
    try {
      const lodDocument = cloneDocument(sourceDocument);

      await lodDocument.transform(
        weld(),
        simplify({
          simplifier: MeshoptSimplifier,
          ratio: lodConfig.ratio,
          error: lodConfig.error,
        }),
        dedup(),
        prune(),
        reorder({ encoder: MeshoptEncoder, target: "size" }),
      );

      const fileName = `${modelName}${lodConfig.suffix}.gltf`;
      await io.write(path.join(outputDir, fileName), lodDocument);
      writtenLods.push({
        name: lodConfig.name,
        file: fileName,
        ratio: lodConfig.ratio,
        error: lodConfig.error,
      });
    } catch (error) {
      console.error(`LOD ${lodConfig.name} se nepodařilo vytvořit:`, error);
    }
  }

  if (writtenLods.length === 0) {
    throw new Error("Nepodařilo se vytvořit žádnou GLTF variantu.");
  }

  return writtenLods;
}

// BUN SERVER

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function saveUploadedZip(request, targetPath) {
  if (!request.body) {
    throw new Error("Požadavek neobsahuje upload data.");
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw new Error("Upload musí být multipart/form-data.");
  }

  const headers = Object.fromEntries(request.headers.entries());

  await new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers,
      limits: {
        files: 1,
        fileSize: MAX_UPLOAD_SIZE,
      },
    });

    let fileFound = false;
    let fileWritePromise = null;
    let uploadError = null;

    busboy.on("file", (fieldName, file, info) => {
      if (fieldName !== "modelZip") {
        file.resume();
        return;
      }

      if (fileFound) {
        uploadError = new Error("Je povolen pouze jeden ZIP soubor.");
        file.resume();
        return;
      }

      fileFound = true;

      if (info.filename && !info.filename.toLowerCase().endsWith(".zip")) {
        uploadError = new Error("Nahraný soubor musí mít příponu .zip.");
        file.resume();
        return;
      }

      file.on("limit", () => {
        uploadError = new Error("ZIP soubor je příliš velký.");
      });

      const output = fs.createWriteStream(targetPath);
      fileWritePromise = pipeline(file, output);
      fileWritePromise.catch((err) => {
        uploadError ??= err;
      });
    });

    busboy.on("filesLimit", () => {
      uploadError = new Error("Je povolen pouze jeden ZIP soubor.");
    });

    busboy.on("error", reject);

    busboy.on("close", async () => {
      try {
        if (!fileFound) {
          throw new Error("Nebyl nahrán žádný ZIP soubor.");
        }

        if (fileWritePromise) {
          await fileWritePromise;
        }

        if (uploadError) {
          throw uploadError;
        }

        resolve();
      } catch (err) {
        reject(err);
      }
    });

    pipeline(Readable.fromWeb(request.body), busboy).catch(reject);
  });
}

async function extractZipArchive(zipPath, targetDir) {
  await fs
    .createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: targetDir }))
    .promise();
}

function decodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function buildEtag(...parts) {
  return `"${parts.join("-")}"`;
}

function resolvePublicPath(pathname) {
  const normalized =
    pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_DIR, normalized);

  if (
    resolved !== PUBLIC_DIR &&
    !resolved.startsWith(`${PUBLIC_DIR}${path.sep}`)
  ) {
    return null;
  }

  return resolved;
}

async function serveStatic(pathname) {
  const resolvedPath = resolvePublicPath(pathname);

  if (!resolvedPath) {
    return jsonResponse(
      { success: false, message: "Soubor nebyl nalezen." },
      404,
    );
  }

  try {
    const stats = await fsp.stat(resolvedPath);
    if (!stats.isFile()) {
      return jsonResponse(
        { success: false, message: "Soubor nebyl nalezen." },
        404,
      );
    }

    const file = Bun.file(resolvedPath);
    const headers = new Headers({
      "Cache-Control":
        pathname === "/" ? "no-cache" : "public, max-age=31536000",
    });

    if (file.type) {
      headers.set("Content-Type", file.type);
    }

    return new Response(file, { headers });
  } catch {
    return jsonResponse(
      { success: false, message: "Soubor nebyl nalezen." },
      404,
    );
  }
}

async function handleUploadModel(request) {
  let tempDir = null;
  let uploadedZipPath = null;

  const cleanup = async () => {
    if (tempDir) {
      try {
        await fsp.rm(tempDir, { recursive: true, force: true });
      } catch (err) {
        console.error(`Chyba při mazání ${tempDir}:`, err);
      }
    }
  };

  try {
    resetUploadStatus();
    pushUploadLog("Upload zahájen.", "uploading");
    console.log("\n" + "=".repeat(60));
    console.log("NOVÝ MODEL - Zpracování začíná");
    console.log("=".repeat(60));

    const tempDirPrefix = path.join(UPLOAD_DIR, "model-");
    tempDir = fs.mkdtempSync(tempDirPrefix);
    uploadedZipPath = path.join(tempDir, "upload.zip");

    await saveUploadedZip(request, uploadedZipPath);
    pushUploadLog("ZIP soubor uložen na disk, rozbaluji archiv.", "extracting");
    await extractZipArchive(uploadedZipPath, tempDir);
    console.log("ZIP soubor rozbalen");

    const allFiles = await getAllFiles(tempDir);
    const gltfFilePath = allFiles.find((file) =>
      file.toLowerCase().endsWith(".gltf"),
    );

    if (!gltfFilePath) {
      await cleanup();
      return jsonResponse(
        {
          success: false,
          message: "ZIP musí obsahovat .gltf soubor!",
        },
        400,
      );
    }

    console.log(`GLTF nalezen: ${path.basename(gltfFilePath)}`);
    pushUploadLog(
      `GLTF nalezen: ${path.basename(gltfFilePath)}. Optimalizuji textury.`,
      "optimizing",
    );

    const resourceDir = path.dirname(gltfFilePath);
    const modelName = path.parse(gltfFilePath).name;
    const outputDir = path.join(MODELS_DIR, modelName);

    console.log("\nOptimalizace textur");
    await optimizeTextures(gltfFilePath, resourceDir);
    pushUploadLog(
      "Textury hotové. Generuji čistý GLTF balíček a LOD varianty.",
      "saving",
    );
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.mkdir(outputDir, { recursive: true });
    const lods = await buildStreamingPackage(modelName, gltfFilePath, outputDir);
    const metadata = await writeModelMetadata(modelName, lods, outputDir);

    console.log("\n" + "=".repeat(60));
    console.log("HOTOVO!");
    console.log(`Model: ${modelName}`);
    console.log(`Entry GLTF: ${metadata.entryFile}`);
    console.log(`LOD varianty: ${lods.map((lod) => lod.file).join(", ")}`);
    console.log(`Velikost: ${metadata.sizeInMB} MB`);
    console.log("=".repeat(60) + "\n");

    await cleanup();
    pushUploadLog(
      `Hotovo: ${modelName}, LOD varianty ${lods.map((lod) => lod.name).join(", ")}.`,
      "done",
    );

    return jsonResponse({
      success: true,
      message: `Model ${modelName} byl úspěšně zpracován.`,
      fileName: metadata.entryFile,
      modelName,
      sizeInMB: metadata.sizeInMB,
      path: metadata.entryUrl,
      chunked: false,
      metadata,
    });
  } catch (err) {
    console.error("\nCHYBA při zpracování:", err);
    await cleanup();

    const clientErrors = new Set([
      "Nebyl nahrán žádný ZIP soubor.",
      "Nahraný soubor musí mít příponu .zip.",
      "ZIP soubor je příliš velký.",
      "Upload musí být multipart/form-data.",
      "Je povolen pouze jeden ZIP soubor.",
      "Požadavek neobsahuje upload data.",
    ]);

    pushUploadLog(
      clientErrors.has(err.message)
        ? err.message
        : "Zpracování modelu selhalo.",
      "error",
    );

    return jsonResponse(
      {
        success: false,
        message: clientErrors.has(err.message)
          ? err.message
          : "Chyba při zpracování modelu.",
        error: err.message,
      },
      clientErrors.has(err.message) ? 400 : 500,
    );
  }
}

async function handleModelMetadata(modelName) {
  const metadataPath = path.join(METADATA_DIR, `${modelName}.json`);

  try {
    const metadataContent = await fsp.readFile(metadataPath, "utf8");
    const metadata = JSON.parse(metadataContent);

    return jsonResponse({
      success: true,
      metadata,
    });
  } catch {
    return jsonResponse(
      {
        success: false,
        message: "Metadata nenalezena.",
      },
      404,
    );
  }
}

function handleUploadStatus() {
  return jsonResponse({
    success: true,
    status: uploadStatus,
  });
}

async function handleDownloadChunk(request, modelName, chunkIndex) {
  return jsonResponse(
    {
      success: false,
      message: "Chunk endpoint je vypnutý. Backend nyní ukládá GLTF + assety pro klientský streaming.",
      model: modelName,
      chunkIndex,
    },
    410,
  );
}

async function handleModelsList() {
  try {
    const files = await fsp.readdir(METADATA_DIR);
    const metadataFiles = files.filter((file) => file.toLowerCase().endsWith(".json"));

    const modelTasks = metadataFiles.map(async (file) => {
      const metadataPath = path.join(METADATA_DIR, file);
      const metadataContent = await fsp.readFile(metadataPath, "utf8");
      const metadata = JSON.parse(metadataContent);
      const stats = await fsp.stat(metadataPath);

      if (!metadata.entryFile || !metadata.entryUrl) {
        return null;
      }

      return {
        name: metadata.modelName,
        entryFile: metadata.entryFile,
        entryUrl: metadata.entryUrl,
        assetDirectory: metadata.assetDirectory,
        type: metadata.type || "gltf",
        size: metadata.size,
        sizeInMB: metadata.sizeInMB,
        created: metadata.created || stats.birthtime,
        modified: stats.mtime,
        chunked: false,
        totalChunks: 0,
      };
    });

    const models = (await Promise.all(modelTasks)).filter(Boolean);
    models.sort((a, b) => new Date(b.modified) - new Date(a.modified));

    return jsonResponse({
      success: true,
      count: models.length,
      models,
    });
  } catch (err) {
    console.error("Chyba při čtení modelů:", err);

    return jsonResponse(
      {
        success: false,
        message: "Chyba serveru.",
      },
      500,
    );
  }
}

async function handleDownloadModel(request, modelName) {
  try {
    const metadataContent = await fsp.readFile(
      path.join(METADATA_DIR, `${modelName}.json`),
      "utf8",
    );
    const metadata = JSON.parse(metadataContent);

    return Response.redirect(new URL(metadata.entryUrl, request.url), 302);
  } catch {
    return jsonResponse(
      {
        success: false,
        message: "Model nebyl nalezen.",
      },
      404,
    );
  }
}

async function handleModelInfo(modelName) {
  try {
    const metadataPath = path.join(METADATA_DIR, `${modelName}.json`);
    const metadataContent = await fsp.readFile(metadataPath, "utf8");
    const metadata = JSON.parse(metadataContent);
    const stats = await fsp.stat(metadataPath);

    return jsonResponse({
      success: true,
      model: {
        name: modelName,
        type: metadata.type || "gltf",
        entryFile: metadata.entryFile,
        entryUrl: metadata.entryUrl,
        size: metadata.size,
        sizeInMB: metadata.sizeInMB,
        created: metadata.created || stats.birthtime,
        modified: stats.mtime,
        downloadUrl: `/download-model/${modelName}`,
        chunked: false,
        metadata,
      },
    });
  } catch {
    return jsonResponse(
      {
        success: false,
        message: "Model nebyl nalezen.",
      },
      404,
    );
  }
}

async function handleCreateChunks(modelName) {
  return jsonResponse(
    {
      success: false,
      message: "Chunking je vypnutý. Backend nyní ukládá GLTF + assety pro klientský streaming.",
      model: modelName,
    },
    400,
  );
}

async function handleCreateAllChunks() {
  return jsonResponse(
    {
      success: false,
      message: "Chunking je vypnutý. Backend nyní ukládá GLTF + assety pro klientský streaming.",
      results: [],
    },
    400,
  );
}

async function handleDeleteModel(modelName) {
  const modelDir = path.join(MODELS_DIR, modelName);
  const metadataPath = path.join(METADATA_DIR, `${modelName}.json`);

  if (!(await pathExists(modelDir)) && !(await pathExists(metadataPath))) {
    return jsonResponse(
      {
        success: false,
        message: "Model nebyl nalezen.",
      },
      404,
    );
  }

  try {
    await Promise.all([
      fsp.rm(modelDir, { recursive: true, force: true }).catch(() => {}),
      fsp.unlink(metadataPath).catch(() => {}),
    ]);

    return jsonResponse({
      success: true,
      message: `Model ${modelName} byl smazán.`,
    });
  } catch (err) {
    console.error("Chyba při mazání:", err);

    return jsonResponse(
      {
        success: false,
        message: "Chyba při mazání modelu.",
      },
      500,
    );
  }
}

async function handleDebugChunk(modelName, chunkIndex) {
  return jsonResponse(
    {
      success: false,
      message: "Debug chunk endpoint je vypnutý, protože chunking už není součástí pipeline.",
      model: modelName,
      chunkIndex,
    },
    410,
  );
}

async function handleRequest(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const segments = pathname.split("/").filter(Boolean);
  const method = request.method.toUpperCase();

  if (method === "POST" && pathname === "/upload-model") {
    return handleUploadModel(request);
  }

  if (method === "GET" && pathname === "/models") {
    return handleModelsList();
  }

  if (method === "GET" && pathname === "/upload-status") {
    return handleUploadStatus();
  }

  if (method === "POST" && pathname === "/create-all-chunks") {
    return handleCreateAllChunks();
  }

  if (
    method === "GET" &&
    segments[0] === "model-metadata" &&
    segments.length === 2
  ) {
    return handleModelMetadata(decodeParam(segments[1]));
  }

  if (
    method === "GET" &&
    segments[0] === "download-chunk" &&
    segments.length === 3
  ) {
    return handleDownloadChunk(
      request,
      decodeParam(segments[1]),
      decodeParam(segments[2]),
    );
  }

  if (
    method === "GET" &&
    segments[0] === "download-model" &&
    segments.length === 2
  ) {
    return handleDownloadModel(request, decodeParam(segments[1]));
  }

  if (
    method === "GET" &&
    segments[0] === "model-info" &&
    segments.length === 2
  ) {
    return handleModelInfo(decodeParam(segments[1]));
  }

  if (
    method === "POST" &&
    segments[0] === "create-chunks" &&
    segments.length === 2
  ) {
    return handleCreateChunks(decodeParam(segments[1]));
  }

  if (method === "DELETE" && segments[0] === "model" && segments.length === 2) {
    return handleDeleteModel(decodeParam(segments[1]));
  }

  if (
    method === "GET" &&
    segments[0] === "debug-chunk" &&
    segments.length === 3
  ) {
    return handleDebugChunk(decodeParam(segments[1]), decodeParam(segments[2]));
  }

  if (method === "GET") {
    return serveStatic(pathname);
  }

  return jsonResponse(
    {
      success: false,
      message: "Endpoint nebyl nalezen.",
    },
    404,
  );
}

function startServer(serverPort, options = {}) {
  try {
    Bun.serve({
      port: serverPort,
      hostname: "0.0.0.0",
      maxRequestBodySize: MAX_UPLOAD_SIZE,
      fetch: handleRequest,
      ...options,
      error(error) {
        console.error("Chyba serveru:", error);
        return jsonResponse(
          {
            success: false,
            message: "Interní chyba serveru.",
          },
          500,
        );
      },
    });

    return true;
  } catch (err) {
    console.error(
      options.tls
        ? "HTTPS server se nepodařilo spustit:"
        : "HTTP server se nepodařilo spustit:",
      err.message,
    );
    return false;
  }
}

console.log("\n" + "=".repeat(60));
const httpStarted = startServer(port);

if (httpStarted) {
  console.log(`HTTP Server běží na http://0.0.0.0:${port}`);
  console.log("=".repeat(60));
}

try {
  const tlsStarted = startServer(httpsPort, {
    tls: {
      key: fs.readFileSync(path.join(__dirname, "key.pem")),
      cert: fs.readFileSync(path.join(__dirname, "cert.pem")),
    },
  });

  if (tlsStarted) {
    console.log(`HTTPS Server běží na https://0.0.0.0:${httpsPort}`);
    console.log("=".repeat(60));
  } else {
    console.log("Server běží pouze na HTTP\n");
  }
} catch (err) {
  console.error("HTTPS server se nepodařilo spustit:", err.message);
  console.log("Server běží pouze na HTTP\n");
}
