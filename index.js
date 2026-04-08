import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { execSync } from "node:child_process";
import gltfPipeline from "gltf-pipeline";
import AdmZip from "adm-zip";
import sharp from "sharp";

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

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const { gltfToGlb } = gltfPipeline;

const port = Number(process.env.PORT || 3000);
const httpsPort = Number(process.env.HTTPS_PORT || 3443);

// Konfigurace
const UPLOAD_DIR = "./tmp_uploads";
const PUBLIC_DIR = path.join(__dirname, "public");
const MODELS_DIR = path.join(__dirname, "public", "models");
const CHUNKS_DIR = path.join(__dirname, "public", "chunks");
const METADATA_DIR = path.join(__dirname, "public", "metadata");
const CHUNK_SIZE = 1024 * 1024; // 1 MB chunks

// Vytvoření potřebných složek
console.log("Vytvářím složky...");
[UPLOAD_DIR, MODELS_DIR, CHUNKS_DIR, METADATA_DIR].forEach((dir) => {
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

function calculateFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);

    stream.on("data", (data) => hash.update(data));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
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

// CHUNKING SYSTÉM

async function createChunks(modelPath, modelName) {
  const modelDir = path.join(CHUNKS_DIR, modelName.replace(".glb", ""));

  await fsp.rm(modelDir, { recursive: true, force: true });
  await fsp.mkdir(modelDir, { recursive: true });

  const stats = await fsp.stat(modelPath);
  const fileSize = stats.size;
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

  console.log(`Vytvářím ${totalChunks} chunků pro ${modelName}...`);

  const chunkHashes = [];
  let totalOriginalSize = 0;
  let totalCompressedSize = 0;
  const fileHandle = await fsp.open(modelPath, "r");

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const chunkPath = path.join(modelDir, `chunk_${chunkIndex}.bin`);
    const gzipPath = chunkPath + ".gz";
    const start = chunkIndex * CHUNK_SIZE;
    const bytesToRead = Math.min(CHUNK_SIZE, fileSize - start);
    const chunkBuffer = Buffer.allocUnsafe(bytesToRead);

    try {
      const { bytesRead } = await fileHandle.read(
        chunkBuffer,
        0,
        bytesToRead,
        start,
      );
      const chunk =
        bytesRead === bytesToRead
          ? chunkBuffer
          : chunkBuffer.subarray(0, bytesRead);

      await fsp.writeFile(chunkPath, chunk);

      const compressed = await gzip(chunk, { level: 9 });
      await fsp.writeFile(gzipPath, compressed);

      const chunkHash = crypto.createHash("sha256").update(chunk).digest("hex");

      chunkHashes.push(chunkHash);
      totalOriginalSize += chunk.length;
      totalCompressedSize += compressed.length;

      if (chunkIndex % 10 === 0) {
        const savings = ((1 - compressed.length / chunk.length) * 100).toFixed(
          1,
        );
        console.log(
          `  Chunk ${chunkIndex}: ${(chunk.length / 1024).toFixed(0)}KB → ${(compressed.length / 1024).toFixed(0)}KB (${savings}% úspora)`,
        );
      }
    } catch (err) {
      await fileHandle.close();
      throw err;
    }
  }

  await fileHandle.close();

  const fileHash = await calculateFileHash(modelPath);

  const metadata = {
    modelName,
    totalChunks,
    chunkSize: CHUNK_SIZE,
    totalSize: fileSize,
    fileHash,
    chunkHashes,
    compressed: true,
    compressionStats: {
      originalSize: totalOriginalSize,
      compressedSize: totalCompressedSize,
      ratio: ((1 - totalCompressedSize / totalOriginalSize) * 100).toFixed(1),
    },
    created: new Date().toISOString(),
  };

  const metadataPath = path.join(METADATA_DIR, `${modelName}.json`);
  await fsp.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

  const compressionRatio = (
    (1 - totalCompressedSize / totalOriginalSize) *
    100
  ).toFixed(1);
  console.log(`Chunky vytvořeny: ${totalChunks} chunks`);
  console.log(
    `Komprese: ${(totalOriginalSize / 1024 / 1024).toFixed(2)}MB → ${(totalCompressedSize / 1024 / 1024).toFixed(2)}MB (${compressionRatio}% úspora)`,
  );

  return metadata;
}

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
          maxSize = 2048;
        } else if (imgMeta.width > 2048 || imgMeta.height > 2048) {
          maxSize = 2048;
        } else if (imgMeta.width > 1024 || imgMeta.height > 1024) {
          maxSize = 1024;
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
            quality: 85,
            mozjpeg: true,
            chromaSubsampling: "4:2:0",
          });
        } else {
          pipeline = pipeline.png({
            compressionLevel: 9,
            palette: !hasAlpha,
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

function emptyResponse(status, headers = {}) {
  return new Response(null, { status, headers });
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
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
  const normalized = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_DIR, normalized);

  if (resolved !== PUBLIC_DIR && !resolved.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    return null;
  }

  return resolved;
}

async function serveStatic(pathname) {
  const resolvedPath = resolvePublicPath(pathname);

  if (!resolvedPath) {
    return jsonResponse({ success: false, message: "Soubor nebyl nalezen." }, 404);
  }

  try {
    const stats = await fsp.stat(resolvedPath);
    if (!stats.isFile()) {
      return jsonResponse({ success: false, message: "Soubor nebyl nalezen." }, 404);
    }

    const file = Bun.file(resolvedPath);
    const headers = new Headers({
      "Cache-Control": pathname === "/" ? "no-cache" : "public, max-age=31536000",
    });

    if (file.type) {
      headers.set("Content-Type", file.type);
    }

    return new Response(file, { headers });
  } catch {
    return jsonResponse({ success: false, message: "Soubor nebyl nalezen." }, 404);
  }
}

async function handleUploadModel(request) {
  let tempDir = null;

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
    const formData = await request.formData();
    const uploadedZip = formData.get("modelZip");

    if (!(uploadedZip instanceof File)) {
      return jsonResponse(
        {
          success: false,
          message: "Nebyl nahrán žádný ZIP soubor.",
        },
        400,
      );
    }

    console.log("\n" + "=".repeat(60));
    console.log("NOVÝ MODEL - Zpracování začíná");
    console.log("=".repeat(60));

    const tempDirPrefix = path.join(UPLOAD_DIR, "model-");
    tempDir = fs.mkdtempSync(tempDirPrefix);

    const zipBuffer = Buffer.from(await uploadedZip.arrayBuffer());
    const zip = new AdmZip(zipBuffer);
    zip.extractAllTo(tempDir, true);
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

    const resourceDir = path.dirname(gltfFilePath);
    const modelName = path.parse(gltfFilePath).name;
    const outputName = `${modelName}.glb`;
    const outputPath = path.join(MODELS_DIR, outputName);

    console.log("\nOptimalizace textur");
    const gltf = await optimizeTextures(gltfFilePath, resourceDir);

    console.log("Draco komprese a balení");
    const options = {
      resourceDirectory: resourceDir,
      dracoOptions: {
        compressionLevel: 10,
        quantizePositionBits: 11,
        quantizeNormalBits: 8,
        quantizeTexcoordBits: 10,
        quantizeColorBits: 8,
        quantizeGenericBits: 8,
        unifiedQuantization: true,
      },
    };

    const results = await gltfToGlb(gltf, options);
    await fsp.writeFile(outputPath, results.glb);

    const finalSizeMB = (results.glb.length / 1024 / 1024).toFixed(2);

    console.log("\nVytváření chunků");
    const metadata = await createChunks(outputPath, outputName);

    console.log("\n" + "=".repeat(60));
    console.log("HOTOVO!");
    console.log(`Model: ${outputName}`);
    console.log(`Velikost: ${finalSizeMB} MB`);
    console.log(`Chunky: ${metadata.totalChunks}`);
    console.log("=".repeat(60) + "\n");

    await cleanup();

    return jsonResponse({
      success: true,
      message: `Model ${outputName} byl úspěšně zpracován.`,
      fileName: outputName,
      sizeInMB: parseFloat(finalSizeMB),
      path: `/models/${outputName}`,
      chunked: true,
      metadata: {
        totalChunks: metadata.totalChunks,
        chunkSize: metadata.chunkSize,
        fileHash: metadata.fileHash,
      },
    });
  } catch (err) {
    console.error("\nCHYBA při zpracování:", err);
    await cleanup();

    return jsonResponse(
      {
        success: false,
        message: "Chyba při zpracování modelu.",
        error: err.message,
      },
      500,
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

async function handleDownloadChunk(request, modelName, chunkIndex) {
  const modelDir = path.join(CHUNKS_DIR, modelName.replace(".glb", ""));
  const chunkPath = path.join(modelDir, `chunk_${chunkIndex}.bin`);
  const gzipPath = `${chunkPath}.gz`;

  try {
    const stats = await fsp.stat(chunkPath);
    const acceptEncoding = request.headers.get("accept-encoding") || "";
    let responsePath = chunkPath;
    let responseStats = stats;
    let useGzip = false;

    if (acceptEncoding.includes("gzip") && (await pathExists(gzipPath))) {
      responsePath = gzipPath;
      responseStats = await fsp.stat(gzipPath);
      useGzip = true;
      console.log(`Sending compressed chunk ${chunkIndex} for ${modelName}`);
    }

    const etag = buildEtag(
      responseStats.size,
      responseStats.mtime.getTime(),
      useGzip ? "gzip" : "identity",
    );

    if (request.headers.get("if-none-match") === etag) {
      return emptyResponse(304, {
        ETag: etag,
        Vary: "Accept-Encoding",
        "Cache-Control": "public, max-age=31536000",
      });
    }

    console.log(
      `Sending ${useGzip ? "compressed" : "uncompressed"} chunk ${chunkIndex} for ${modelName}`,
    );

    const headers = new Headers({
      ETag: etag,
      Vary: "Accept-Encoding",
      "Cache-Control": "public, max-age=31536000",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(responseStats.size),
      "X-Original-Size": String(stats.size),
      "X-Chunk-Compressed": useGzip ? "true" : "false",
    });

    if (useGzip) {
      headers.set("Content-Encoding", "gzip");
      headers.set("X-Compressed-Size", String(responseStats.size));
    }

    return new Response(Bun.file(responsePath), { headers });
  } catch {
    return jsonResponse(
      {
        success: false,
        message: "Chunk nenalezen.",
      },
      404,
    );
  }
}

async function handleModelsList() {
  try {
    const files = await fsp.readdir(MODELS_DIR);
    const glbFiles = files.filter(
      (file) => path.extname(file).toLowerCase() === ".glb",
    );

    const modelTasks = glbFiles.map(async (file) => {
      const filePath = path.join(MODELS_DIR, file);
      const stats = await fsp.stat(filePath);

      const metadataPath = path.join(METADATA_DIR, `${file}.json`);
      let chunked = false;
      let totalChunks = 0;

      try {
        const metadataContent = await fsp.readFile(metadataPath, "utf8");
        const metadata = JSON.parse(metadataContent);
        chunked = true;
        totalChunks = metadata.totalChunks;
      } catch {}

      return {
        name: file,
        size: stats.size,
        sizeInMB: parseFloat((stats.size / 1024 / 1024).toFixed(2)),
        created: stats.birthtime,
        modified: stats.mtime,
        chunked,
        totalChunks,
      };
    });

    const models = await Promise.all(modelTasks);
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

function parseRange(rangeHeader, fileSize) {
  if (!rangeHeader?.startsWith("bytes=")) {
    return null;
  }

  const [startRaw, endRaw] = rangeHeader.replace("bytes=", "").split("-");
  const start = Number.parseInt(startRaw, 10);
  const end = endRaw ? Number.parseInt(endRaw, 10) : fileSize - 1;

  if (
    Number.isNaN(start) ||
    Number.isNaN(end) ||
    start < 0 ||
    end < start ||
    end >= fileSize
  ) {
    return null;
  }

  return { start, end };
}

async function handleDownloadModel(request, modelName) {
  const filePath = path.join(MODELS_DIR, modelName);

  try {
    const stat = await fsp.stat(filePath);
    const fileSize = stat.size;
    const etag = buildEtag(fileSize, stat.mtime.getTime());

    if (request.headers.get("if-none-match") === etag) {
      return emptyResponse(304, { ETag: etag });
    }

    const range = parseRange(request.headers.get("range"), fileSize);
    const file = Bun.file(filePath);

    if (request.headers.get("range") && !range) {
      return emptyResponse(416, {
        "Content-Range": `bytes */${fileSize}`,
        ETag: etag,
      });
    }

    if (range) {
      const { start, end } = range;
      const chunkSize = end - start + 1;

      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(chunkSize),
          "Content-Type": "model/gltf-binary",
          ETag: etag,
          "Cache-Control": "public, max-age=31536000",
        },
      });
    }

    return new Response(file, {
      headers: {
        "Content-Length": String(fileSize),
        "Content-Type": "model/gltf-binary",
        "Content-Disposition": `attachment; filename="${modelName}"`,
        ETag: etag,
        "Cache-Control": "public, max-age=31536000",
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

async function handleModelInfo(modelName) {
  const filePath = path.join(MODELS_DIR, modelName);

  try {
    const stats = await fsp.stat(filePath);

    const metadataPath = path.join(METADATA_DIR, `${modelName}.json`);
    let metadata = null;

    try {
      const metadataContent = await fsp.readFile(metadataPath, "utf8");
      metadata = JSON.parse(metadataContent);
    } catch {}

    return jsonResponse({
      success: true,
      model: {
        name: modelName,
        size: stats.size,
        sizeInMB: parseFloat((stats.size / 1024 / 1024).toFixed(2)),
        created: stats.birthtime,
        modified: stats.mtime,
        downloadUrl: `/download-model/${modelName}`,
        chunked: metadata !== null,
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
  const modelPath = path.join(MODELS_DIR, modelName);

  if (!(await pathExists(modelPath))) {
    return jsonResponse(
      {
        success: false,
        message: "Model nebyl nalezen.",
      },
      404,
    );
  }

  try {
    console.log(`\nVytváření chunků pro: ${modelName}`);
    const metadata = await createChunks(modelPath, modelName);

    return jsonResponse({
      success: true,
      message: `Chunky vytvořeny pro ${modelName}`,
      metadata: {
        totalChunks: metadata.totalChunks,
        chunkSize: metadata.chunkSize,
        fileHash: metadata.fileHash,
      },
    });
  } catch (err) {
    console.error("Chyba:", err);

    return jsonResponse(
      {
        success: false,
        message: "Chyba při vytváření chunků.",
        error: err.message,
      },
      500,
    );
  }
}

async function handleCreateAllChunks() {
  try {
    const files = await fsp.readdir(MODELS_DIR);
    const glbFiles = files.filter((file) => file.toLowerCase().endsWith(".glb"));

    const results = [];

    for (const file of glbFiles) {
      const metadataPath = path.join(METADATA_DIR, `${file}.json`);

      if (await pathExists(metadataPath)) {
        results.push({
          model: file,
          status: "skipped",
          message: "Již má chunky",
        });
        continue;
      }

      try {
        const modelPath = path.join(MODELS_DIR, file);
        console.log(`\nVytváření chunků pro: ${file}`);
        await createChunks(modelPath, file);

        results.push({
          model: file,
          status: "success",
          message: "Chunky vytvořeny",
        });
      } catch (err) {
        console.error(`Chyba při vytváření chunků pro ${file}:`, err);
        results.push({
          model: file,
          status: "error",
          message: err.message,
        });
      }
    }

    return jsonResponse({
      success: true,
      message: `Zpracováno ${glbFiles.length} modelů`,
      results,
    });
  } catch (err) {
    console.error("Chyba:", err);

    return jsonResponse(
      {
        success: false,
        message: "Chyba při vytváření chunků.",
        error: err.message,
      },
      500,
    );
  }
}

async function handleDeleteModel(modelName) {
  const filePath = path.join(MODELS_DIR, modelName);

  if (!(await pathExists(filePath))) {
    return jsonResponse(
      {
        success: false,
        message: "Model nebyl nalezen.",
      },
      404,
    );
  }

  try {
    const modelDir = path.join(CHUNKS_DIR, modelName.replace(".glb", ""));
    const metadataPath = path.join(METADATA_DIR, `${modelName}.json`);

    await Promise.all([
      fsp.unlink(filePath),
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
  const modelDir = path.join(CHUNKS_DIR, modelName.replace(".glb", ""));
  const chunkPath = path.join(modelDir, `chunk_${chunkIndex}.bin`);
  const gzipPath = `${chunkPath}.gz`;

  try {
    const originalData = await fsp.readFile(chunkPath);
    const originalHash = crypto
      .createHash("sha256")
      .update(originalData)
      .digest("hex");

    let gzipData = null;
    let decompressedHash = null;

    try {
      gzipData = await fsp.readFile(gzipPath);
      const decompressed = await gunzip(gzipData);
      decompressedHash = crypto
        .createHash("sha256")
        .update(decompressed)
        .digest("hex");
    } catch {}

    const metadataPath = path.join(METADATA_DIR, `${modelName}.json`);
    let metadataHash = null;

    try {
      const metadataContent = await fsp.readFile(metadataPath, "utf8");
      const metadata = JSON.parse(metadataContent);
      metadataHash = metadata.chunkHashes[Number.parseInt(chunkIndex, 10)];
    } catch {}

    return jsonResponse({
      chunkIndex: Number.parseInt(chunkIndex, 10),
      originalSize: originalData.length,
      originalHash,
      gzipSize: gzipData?.length || null,
      decompressedHash,
      metadataHash,
      hashesMatch: originalHash === metadataHash,
      explanation: {
        originalHash: "Hash z nekomprimovaného .bin souboru",
        decompressedHash:
          "Hash z dekomprimovaného .gz souboru (měl by se rovnat originalHash)",
        metadataHash: "Hash uložený v metadata.json",
        hashesMatch:
          "Zda se originalHash shoduje s metadataHash (mělo by být true)",
      },
    });
  } catch (err) {
    if (err.code === "ENOENT") {
      return jsonResponse({ error: "Chunk not found" }, 404);
    }

    return jsonResponse({ error: err.message }, 500);
  }
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

  if (method === "POST" && pathname === "/create-all-chunks") {
    return handleCreateAllChunks();
  }

  if (method === "GET" && segments[0] === "model-metadata" && segments.length === 2) {
    return handleModelMetadata(decodeParam(segments[1]));
  }

  if (method === "GET" && segments[0] === "download-chunk" && segments.length === 3) {
    return handleDownloadChunk(
      request,
      decodeParam(segments[1]),
      decodeParam(segments[2]),
    );
  }

  if (method === "GET" && segments[0] === "download-model" && segments.length === 2) {
    return handleDownloadModel(request, decodeParam(segments[1]));
  }

  if (method === "GET" && segments[0] === "model-info" && segments.length === 2) {
    return handleModelInfo(decodeParam(segments[1]));
  }

  if (method === "POST" && segments[0] === "create-chunks" && segments.length === 2) {
    return handleCreateChunks(decodeParam(segments[1]));
  }

  if (method === "DELETE" && segments[0] === "model" && segments.length === 2) {
    return handleDeleteModel(decodeParam(segments[1]));
  }

  if (method === "GET" && segments[0] === "debug-chunk" && segments.length === 3) {
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
