const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises; // Async fs operations
const crypto = require("crypto");
const zlib = require("zlib");
const util = require("util");

// Promisify gzip functions
const gzip = util.promisify(zlib.gzip);
const gunzip = util.promisify(zlib.gunzip);

// Zkontroluj, zda jsou všechny dependencies nainstalovány
try {
  const gltfPipeline = require("gltf-pipeline");
  const AdmZip = require("adm-zip");
  const sharp = require("sharp");
  console.log("✅ Všechny dependencies načteny");
} catch (err) {
  console.error("❌ Chybí dependency:", err.message);
  console.log("\n💡 Spusť: npm install gltf-pipeline adm-zip sharp");
  process.exit(1);
}

const gltfPipeline = require("gltf-pipeline");
const gltfToGlb = gltfPipeline.gltfToGlb;
const AdmZip = require("adm-zip");
const sharp = require("sharp");

const app = express();
const port = 3000;

// Konfigurace
const UPLOAD_DIR = "./tmp_uploads";
const MODELS_DIR = path.join(__dirname, "public", "models");
const CHUNKS_DIR = path.join(__dirname, "public", "chunks");
const METADATA_DIR = path.join(__dirname, "public", "metadata");
const CHUNK_SIZE = 1024 * 1024; // 1 MB chunks

// Vytvoření potřebných složek
console.log("📁 Vytvářím složky...");
[UPLOAD_DIR, MODELS_DIR, CHUNKS_DIR, METADATA_DIR].forEach((dir) => {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`  ✅ ${dir}`);
    } else {
      console.log(`  ⏭️  ${dir} už existuje`);
    }
  } catch (err) {
    console.error(`  ❌ Chyba při vytváření ${dir}:`, err.message);
  }
});

// Middleware
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ============================================================================
// UTILITY FUNKCE
// ============================================================================

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

// ============================================================================
// CHUNKING SYSTÉM - ✅ OPRAVENO PRO GZIP HASH MISMATCH
// ============================================================================

async function createChunks(modelPath, modelName) {
  const modelDir = path.join(CHUNKS_DIR, modelName.replace(".glb", ""));

  await fsp.mkdir(modelDir, { recursive: true });

  const stats = await fsp.stat(modelPath);
  const fileSize = stats.size;
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

  console.log(`📦 Vytvářím ${totalChunks} chunků pro ${modelName}...`);

  // Načti celý soubor do paměti pro paralelní zpracování chunků
  const fileData = await fsp.readFile(modelPath);

  // Připrav všechny chunk úlohy pro paralelní zpracování
  const chunkTasks = [];
  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    chunkTasks.push(
      (async () => {
        const chunkPath = path.join(modelDir, `chunk_${chunkIndex}.bin`);
        const gzipPath = chunkPath + ".gz";

        const start = chunkIndex * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, fileSize);
        const chunk = fileData.slice(start, end);

        // Ulož nekomprimovaný chunk
        await fsp.writeFile(chunkPath, chunk);

        // GZIP komprese
        const compressed = await gzip(chunk, { level: 9 });
        await fsp.writeFile(gzipPath, compressed);

        // Hash z nekomprimovaných dat
        const chunkHash = crypto
          .createHash("sha256")
          .update(chunk)
          .digest("hex");

        if (chunkIndex % 10 === 0) {
          const savings = (
            (1 - compressed.length / chunk.length) *
            100
          ).toFixed(1);
          console.log(
            `  Chunk ${chunkIndex}: ${(chunk.length / 1024).toFixed(0)}KB → ${(compressed.length / 1024).toFixed(0)}KB (${savings}% úspora)`,
          );
        }

        return {
          index: chunkIndex,
          hash: chunkHash,
          originalSize: chunk.length,
          compressedSize: compressed.length,
        };
      })(),
    );
  }

  // Spusť všechny chunky paralelně
  const chunkResults = await Promise.all(chunkTasks);

  // Seřaď podle indexu a extrahuj data
  chunkResults.sort((a, b) => a.index - b.index);
  const chunkHashes = chunkResults.map((r) => r.hash);
  const totalOriginalSize = chunkResults.reduce(
    (sum, r) => sum + r.originalSize,
    0,
  );
  const totalCompressedSize = chunkResults.reduce(
    (sum, r) => sum + r.compressedSize,
    0,
  );

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
  console.log(`✅ Chunky vytvořeny: ${totalChunks} chunks`);
  console.log(
    `🗜️  Komprese: ${(totalOriginalSize / 1024 / 1024).toFixed(2)}MB → ${(totalCompressedSize / 1024 / 1024).toFixed(2)}MB (${compressionRatio}% úspora)`,
  );

  return metadata;
}

// ============================================================================
// OPTIMALIZACE TEXTUR
// ============================================================================

async function optimizeTextures(gltfPath, resourceDir) {
  try {
    const gltfContent = await fsp.readFile(gltfPath, "utf8");
    const gltf = JSON.parse(gltfContent);

    if (!gltf.images || gltf.images.length === 0) {
      console.log("Model neobsahuje žádné textury.");
      return gltf;
    }

    console.log(
      `📸 Nalezeno ${gltf.images.length} textur, spouštím optimalizaci (paralelně)...`,
    );

    // Připrav úlohy pro paralelní zpracování textur
    const textureTasks = gltf.images.map(async (image, i) => {
      if (!image.uri) {
        console.log(`  ⏭️  Přeskakuji embedded texturu [${i}]`);
        return { originalSize: 0, optimizedSize: 0, skipped: true };
      }

      const imagePath = path.join(resourceDir, image.uri);

      try {
        await fsp.access(imagePath);
      } catch {
        console.log(`  ⚠️  Textura nenalezena: ${imagePath}`);
        return { originalSize: 0, optimizedSize: 0, skipped: true };
      }

      const ext = path.extname(imagePath).toLowerCase();
      const baseName = path.basename(imagePath, ext);
      const optimizedPath = path.join(resourceDir, `${baseName}_opt.jpg`);

      try {
        const stats = await fsp.stat(imagePath);
        const originalSize = stats.size;

        const imgMeta = await sharp(imagePath).metadata();

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

        await sharp(imagePath)
          .resize(maxSize, maxSize, {
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({
            quality: 85,
            mozjpeg: true,
            chromaSubsampling: "4:2:0",
          })
          .toFile(optimizedPath);

        const optimizedStats = await fsp.stat(optimizedPath);
        const optimizedSize = optimizedStats.size;

        const savings = ((1 - optimizedSize / originalSize) * 100).toFixed(1);
        const origMB = (originalSize / 1024 / 1024).toFixed(2);
        const optMB = (optimizedSize / 1024 / 1024).toFixed(2);

        console.log(`  ✅ ${image.uri}`);
        console.log(`     ${origMB} MB → ${optMB} MB (úspora ${savings}%)`);

        // Update image reference
        image.uri = `${baseName}_opt.jpg`;
        image.mimeType = "image/jpeg";

        return { originalSize, optimizedSize, skipped: false };
      } catch (err) {
        console.error(`  ❌ Chyba při optimalizaci ${imagePath}:`, err.message);
        return { originalSize: 0, optimizedSize: 0, skipped: true };
      }
    });

    // Spusť všechny textury paralelně
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
      console.log(`\n📊 Celková úspora textur: ${totalSavings}%`);
      console.log(
        `   Původní: ${(totalOriginalSize / 1024 / 1024).toFixed(2)} MB`,
      );
      console.log(
        `   Optimalizováno: ${(totalOptimizedSize / 1024 / 1024).toFixed(2)} MB\n`,
      );
    }

    await fsp.writeFile(gltfPath, JSON.stringify(gltf, null, 2));

    return gltf;
  } catch (err) {
    console.error("❌ Chyba při optimalizaci textur:", err);
    throw err;
  }
}

// ============================================================================
// UPLOAD ENDPOINT
// ============================================================================

const uploadZip = multer({ storage: multer.memoryStorage() });

app.post("/upload-model", uploadZip.single("modelZip"), async (req, res) => {
  let tempDir = null;

  const cleanup = () => {
    if (tempDir) {
      fs.rm(tempDir, { recursive: true, force: true }, (err) => {
        if (err) console.error(`Chyba při mazání ${tempDir}:`, err);
      });
    }
  };

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Nebyl nahrán žádný ZIP soubor.",
      });
    }

    console.log("\n" + "=".repeat(60));
    console.log("📦 NOVÝ MODEL - Zpracování začíná");
    console.log("=".repeat(60));

    const tempDirPrefix = path.join(UPLOAD_DIR, "model-");
    tempDir = fs.mkdtempSync(tempDirPrefix);

    const zip = new AdmZip(req.file.buffer);
    zip.extractAllTo(tempDir, true);
    console.log("📂 ZIP soubor rozbalen");

    const allFiles = await getAllFiles(tempDir);
    const gltfFilePath = allFiles.find((f) =>
      f.toLowerCase().endsWith(".gltf"),
    );

    if (!gltfFilePath) {
      cleanup();
      return res.status(400).json({
        success: false,
        message: "ZIP musí obsahovat .gltf soubor!",
      });
    }

    console.log(`🎯 GLTF nalezen: ${path.basename(gltfFilePath)}`);

    const resourceDir = path.dirname(gltfFilePath);
    const modelName = path.parse(gltfFilePath).name;
    const outputName = `${modelName}.glb`;
    const outputPath = path.join(MODELS_DIR, outputName);

    console.log("\n--- KROK 1: Optimalizace textur ---");
    const gltf = await optimizeTextures(gltfFilePath, resourceDir);

    console.log("--- KROK 2: Draco komprese a balení ---");
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

    console.log("\n--- KROK 3: Vytváření chunků ---");
    const metadata = await createChunks(outputPath, outputName);

    console.log("\n" + "=".repeat(60));
    console.log(`✅ HOTOVO!`);
    console.log(`📦 Model: ${outputName}`);
    console.log(`💾 Velikost: ${finalSizeMB} MB`);
    console.log(`📦 Chunky: ${metadata.totalChunks}`);
    console.log("=".repeat(60) + "\n");

    cleanup();

    res.json({
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
    console.error("\n❌ CHYBA při zpracování:", err);
    cleanup();

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: "Chyba při zpracování modelu.",
        error: err.message,
      });
    }
  }
});

// ============================================================================
// CHUNK ENDPOINTS S GZIP PODPOROU
// ============================================================================

app.get("/model-metadata/:modelName", async (req, res) => {
  const modelName = req.params.modelName;
  const metadataPath = path.join(METADATA_DIR, `${modelName}.json`);

  try {
    const metadataContent = await fsp.readFile(metadataPath, "utf8");
    const metadata = JSON.parse(metadataContent);
    res.json({
      success: true,
      metadata,
    });
  } catch {
    return res.status(404).json({
      success: false,
      message: "Metadata nenalezena.",
    });
  }
});

app.get("/download-chunk/:modelName/:chunkIndex", async (req, res) => {
  const { modelName, chunkIndex } = req.params;
  const modelDir = path.join(CHUNKS_DIR, modelName.replace(".glb", ""));
  const chunkPath = path.join(modelDir, `chunk_${chunkIndex}.bin`);
  const gzipPath = chunkPath + ".gz";

  try {
    const stats = await fsp.stat(chunkPath);
    const etag = `"${stats.size}-${stats.mtime.getTime()}"`;

    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "public, max-age=31536000"); // 1 rok cache

    if (req.headers["if-none-match"] === etag) {
      return res.status(304).end();
    }

    // Zkontroluj, zda klient podporuje gzip
    const acceptEncoding = req.headers["accept-encoding"] || "";

    try {
      const gzipStats = await fsp.stat(gzipPath);
      if (acceptEncoding.includes("gzip")) {
        // Pošli komprimovaný chunk
        console.log(
          `📤 Sending compressed chunk ${chunkIndex} for ${modelName}`,
        );

        res.setHeader("Content-Encoding", "gzip");
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("X-Original-Size", stats.size);
        res.setHeader("X-Compressed-Size", gzipStats.size);

        return res.sendFile(gzipPath);
      }
    } catch {
      // Gzip neexistuje, pošli nekomprimovaný
    }

    // Pošli nekomprimovaný chunk (fallback)
    console.log(`📤 Sending uncompressed chunk ${chunkIndex} for ${modelName}`);
    res.sendFile(chunkPath);
  } catch {
    return res.status(404).json({
      success: false,
      message: "Chunk nenalezen.",
    });
  }
});

// ============================================================================
// SEZNAM MODELŮ
// ============================================================================

app.get("/models", async (req, res) => {
  try {
    const files = await fsp.readdir(MODELS_DIR);
    const glbFiles = files.filter(
      (file) => path.extname(file).toLowerCase() === ".glb",
    );

    // Zpracuj všechny modely paralelně
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
      } catch {
        // Metadata neexistují
      }

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
    models.sort((a, b) => b.modified - a.modified);

    res.json({
      success: true,
      count: models.length,
      models: models,
    });
  } catch (err) {
    console.error("Chyba při čtení modelů:", err);
    res.status(500).json({
      success: false,
      message: "Chyba serveru.",
    });
  }
});

// ============================================================================
// DOWNLOAD ENDPOINT
// ============================================================================

app.get("/download-model/:modelName", async (req, res) => {
  const modelName = req.params.modelName;
  const filePath = path.join(MODELS_DIR, modelName);

  try {
    const stat = await fsp.stat(filePath);
    const fileSize = stat.size;
    const etag = `"${fileSize}-${stat.mtime.getTime()}"`;

    res.setHeader("ETag", etag);

    if (req.headers["if-none-match"] === etag) {
      return res.status(304).end();
    }

    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = end - start + 1;

      const file = fs.createReadStream(filePath, { start, end });

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunksize,
        "Content-Type": "model/gltf-binary",
        ETag: etag,
        "Cache-Control": "public, max-age=31536000",
      });

      file.pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": "model/gltf-binary",
        "Content-Disposition": `attachment; filename="${modelName}"`,
        ETag: etag,
        "Cache-Control": "public, max-age=31536000",
      });

      fs.createReadStream(filePath).pipe(res);
    }
  } catch {
    return res.status(404).json({
      success: false,
      message: "Model nebyl nalezen.",
    });
  }
});

// ============================================================================
// MODEL INFO
// ============================================================================

app.get("/model-info/:modelName", async (req, res) => {
  const modelName = req.params.modelName;
  const filePath = path.join(MODELS_DIR, modelName);

  try {
    const stats = await fsp.stat(filePath);

    const metadataPath = path.join(METADATA_DIR, `${modelName}.json`);
    let metadata = null;

    try {
      const metadataContent = await fsp.readFile(metadataPath, "utf8");
      metadata = JSON.parse(metadataContent);
    } catch {
      // Metadata neexistují
    }

    res.json({
      success: true,
      model: {
        name: modelName,
        size: stats.size,
        sizeInMB: parseFloat((stats.size / 1024 / 1024).toFixed(2)),
        created: stats.birthtime,
        modified: stats.mtime,
        downloadUrl: `/download-model/${modelName}`,
        chunked: metadata !== null,
        metadata: metadata,
      },
    });
  } catch {
    return res.status(404).json({
      success: false,
      message: "Model nebyl nalezen.",
    });
  }
});

// ============================================================================
// VYTVOŘENÍ CHUNKŮ PRO EXISTUJÍCÍ MODELY
// ============================================================================

app.post("/create-chunks/:modelName", async (req, res) => {
  const modelName = req.params.modelName;
  const modelPath = path.join(MODELS_DIR, modelName);

  try {
    await fsp.access(modelPath);
  } catch {
    return res.status(404).json({
      success: false,
      message: "Model nebyl nalezen.",
    });
  }

  try {
    console.log(`\n📦 Vytváření chunků pro: ${modelName}`);
    const metadata = await createChunks(modelPath, modelName);

    res.json({
      success: true,
      message: `Chunky vytvořeny pro ${modelName}`,
      metadata: {
        totalChunks: metadata.totalChunks,
        chunkSize: metadata.chunkSize,
        fileHash: metadata.fileHash,
      },
    });
  } catch (err) {
    console.error("❌ Chyba:", err);
    res.status(500).json({
      success: false,
      message: "Chyba při vytváření chunků.",
      error: err.message,
    });
  }
});

app.post("/create-all-chunks", async (req, res) => {
  try {
    const files = await fsp.readdir(MODELS_DIR);
    const glbFiles = files.filter((f) => f.toLowerCase().endsWith(".glb"));

    // Připrav úlohy pro paralelní zpracování
    const tasks = glbFiles.map(async (file) => {
      const metadataPath = path.join(METADATA_DIR, `${file}.json`);

      try {
        await fsp.access(metadataPath);
        return {
          model: file,
          status: "skipped",
          message: "Již má chunky",
        };
      } catch {
        // Metadata neexistují, pokračuj
      }

      try {
        const modelPath = path.join(MODELS_DIR, file);
        console.log(`\n📦 Vytváření chunků pro: ${file}`);
        await createChunks(modelPath, file);

        return {
          model: file,
          status: "success",
          message: "Chunky vytvořeny",
        };
      } catch (err) {
        console.error(`❌ Chyba při vytváření chunků pro ${file}:`, err);
        return {
          model: file,
          status: "error",
          message: err.message,
        };
      }
    });

    // Spusť všechny úlohy paralelně
    const results = await Promise.all(tasks);

    res.json({
      success: true,
      message: `Zpracováno ${glbFiles.length} modelů`,
      results,
    });
  } catch (err) {
    console.error("❌ Chyba:", err);
    res.status(500).json({
      success: false,
      message: "Chyba při vytváření chunků.",
      error: err.message,
    });
  }
});

// ============================================================================
// SMAZÁNÍ MODELU
// ============================================================================

app.delete("/model/:modelName", async (req, res) => {
  const modelName = req.params.modelName;
  const filePath = path.join(MODELS_DIR, modelName);

  try {
    await fsp.access(filePath);
  } catch {
    return res.status(404).json({
      success: false,
      message: "Model nebyl nalezen.",
    });
  }

  try {
    // Připrav všechny cesty k souborům
    const modelDir = path.join(CHUNKS_DIR, modelName.replace(".glb", ""));
    const metadataPath = path.join(METADATA_DIR, `${modelName}.json`);

    // Smaž vše paralelně
    const deleteOps = [
      fsp.unlink(filePath),
      fsp.rm(modelDir, { recursive: true, force: true }).catch(() => {}),
      fsp.unlink(metadataPath).catch(() => {}),
    ];

    await Promise.all(deleteOps);

    res.json({
      success: true,
      message: `Model ${modelName} byl smazán.`,
    });
  } catch (err) {
    console.error("Chyba při mazání:", err);
    res.status(500).json({
      success: false,
      message: "Chyba při mazání modelu.",
    });
  }
});

// ============================================================================
// ADMIN ENDPOINTS
// ============================================================================

// Compression stats
app.get("/admin/compression-stats", async (req, res) => {
  try {
    const files = await fsp.readdir(METADATA_DIR);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));

    // Načti všechny metadata paralelně
    const metadataTasks = jsonFiles.map(async (file) => {
      try {
        const content = await fsp.readFile(
          path.join(METADATA_DIR, file),
          "utf8",
        );
        return JSON.parse(content);
      } catch {
        return null;
      }
    });

    const allMetadata = await Promise.all(metadataTasks);

    const stats = [];
    let totalOriginal = 0;
    let totalCompressed = 0;

    allMetadata.forEach((metadata) => {
      if (metadata && metadata.compressionStats) {
        stats.push({
          model: metadata.modelName,
          original: metadata.compressionStats.originalSize,
          compressed: metadata.compressionStats.compressedSize,
          ratio: metadata.compressionStats.ratio,
        });

        totalOriginal += metadata.compressionStats.originalSize;
        totalCompressed += metadata.compressionStats.compressedSize;
      }
    });

    res.json({
      success: true,
      models: stats,
      total: {
        originalMB: (totalOriginal / 1024 / 1024).toFixed(2),
        compressedMB: (totalCompressed / 1024 / 1024).toFixed(2),
        savedMB: ((totalOriginal - totalCompressed) / 1024 / 1024).toFixed(2),
        ratio: ((1 - totalCompressed / totalOriginal) * 100).toFixed(1) + "%",
      },
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Precompress all existing chunks
app.post("/admin/precompress-chunks", async (req, res) => {
  try {
    console.log("\n🗜️  Spouštím předkompresi všech chunků (paralelně)...\n");

    const modelDirs = await fsp.readdir(CHUNKS_DIR);

    // Připrav úlohy pro všechny modely paralelně
    const modelTasks = modelDirs.map(async (modelDir) => {
      const modelPath = path.join(CHUNKS_DIR, modelDir);

      const dirStat = await fsp.stat(modelPath);
      if (!dirStat.isDirectory()) {
        return { compressed: 0, originalSize: 0, compressedSize: 0 };
      }

      const allFiles = await fsp.readdir(modelPath);
      const chunks = allFiles.filter((f) => f.endsWith(".bin"));

      console.log(`📦 Komprimuji ${chunks.length} chunků pro ${modelDir}...`);

      // Komprimuj všechny chunky daného modelu paralelně
      const chunkTasks = chunks.map(async (chunk) => {
        const chunkPath = path.join(modelPath, chunk);
        const gzipPath = chunkPath + ".gz";

        try {
          await fsp.access(gzipPath);
          return { compressed: 0, originalSize: 0, compressedSize: 0 };
        } catch {
          // Gzip neexistuje, pokračuj
        }

        const originalData = await fsp.readFile(chunkPath);
        const compressedData = await gzip(originalData, { level: 9 });

        await fsp.writeFile(gzipPath, compressedData);

        return {
          compressed: 1,
          originalSize: originalData.length,
          compressedSize: compressedData.length,
        };
      });

      const chunkResults = await Promise.all(chunkTasks);

      const result = chunkResults.reduce(
        (acc, r) => ({
          compressed: acc.compressed + r.compressed,
          originalSize: acc.originalSize + r.originalSize,
          compressedSize: acc.compressedSize + r.compressedSize,
        }),
        { compressed: 0, originalSize: 0, compressedSize: 0 },
      );

      console.log(
        `  ✅ ${modelDir}: ${result.compressed} chunků zkomprimováno`,
      );
      return result;
    });

    // Spusť všechny modely paralelně
    const modelResults = await Promise.all(modelTasks);

    const totals = modelResults.reduce(
      (acc, r) => ({
        compressed: acc.compressed + r.compressed,
        originalSize: acc.originalSize + r.originalSize,
        compressedSize: acc.compressedSize + r.compressedSize,
      }),
      { compressed: 0, originalSize: 0, compressedSize: 0 },
    );

    const totalCompressed = totals.compressed;
    const totalOriginalSize = totals.originalSize;
    const totalCompressedSize = totals.compressedSize;

    const savings = (
      (1 - totalCompressedSize / totalOriginalSize) *
      100
    ).toFixed(1);

    console.log(`\n✅ Předkomprese dokončena!`);
    console.log(`📊 Zpracováno: ${totalCompressed} chunků`);
    console.log(
      `💾 Úspora: ${savings}% (${((totalOriginalSize - totalCompressedSize) / 1024 / 1024).toFixed(2)} MB)\n`,
    );

    res.json({
      success: true,
      chunksCompressed: totalCompressed,
      originalMB: (totalOriginalSize / 1024 / 1024).toFixed(2),
      compressedMB: (totalCompressedSize / 1024 / 1024).toFixed(2),
      savedMB: (
        (totalOriginalSize - totalCompressedSize) /
        1024 /
        1024
      ).toFixed(2),
      ratio: savings + "%",
    });
  } catch (err) {
    console.error("❌ Chyba:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "running",
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

// 🆕 DEBUG ENDPOINT - Ověř hash konkrétního chunku
app.get("/debug-chunk/:modelName/:chunkIndex", async (req, res) => {
  const { modelName, chunkIndex } = req.params;
  const modelDir = path.join(CHUNKS_DIR, modelName.replace(".glb", ""));
  const chunkPath = path.join(modelDir, `chunk_${chunkIndex}.bin`);
  const gzipPath = chunkPath + ".gz";

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

      // Dekomprimuj GZIP a spočítej hash
      const decompressed = await gunzip(gzipData);
      decompressedHash = crypto
        .createHash("sha256")
        .update(decompressed)
        .digest("hex");
    } catch {
      // Gzip neexistuje
    }

    // Načti metadata
    const metadataPath = path.join(METADATA_DIR, `${modelName}.json`);
    let metadataHash = null;

    try {
      const metadataContent = await fsp.readFile(metadataPath, "utf8");
      const metadata = JSON.parse(metadataContent);
      metadataHash = metadata.chunkHashes[parseInt(chunkIndex)];
    } catch {
      // Metadata neexistují
    }

    res.json({
      chunkIndex: parseInt(chunkIndex),
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
      return res.status(404).json({ error: "Chunk not found" });
    }
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// START SERVERU
// ============================================================================

// HTTP/1.1 server (pro kompatibilitu)
app.listen(port, "0.0.0.0", () => {
  console.log("\n" + "=".repeat(60));
  console.log(`🚀 HTTP/1.1 Server běží na http://0.0.0.0:${port}`);
  console.log(`📦 Modely: http://0.0.0.0:${port}/models`);
  console.log("=".repeat(60));
});

// HTTP/2 server (pro lepší výkon)
const http2Port = 3443;
try {
  const http2 = require("http2");
  const https = require("https");

  // Načti SSL certifikáty
  const sslOptions = {
    key: fs.readFileSync(path.join(__dirname, "key.pem")),
    cert: fs.readFileSync(path.join(__dirname, "cert.pem")),
    allowHTTP1: true, // Fallback na HTTP/1.1 pokud klient nepodporuje HTTP/2
  };

  // Vytvoř HTTP/2 server
  const http2Server = http2.createSecureServer(sslOptions, app);

  http2Server.listen(http2Port, "0.0.0.0", () => {
    console.log(`⚡ HTTP/2 Server běží na https://0.0.0.0:${http2Port}`);
    console.log(`💾 Chunk size: ${(CHUNK_SIZE / 1024).toFixed(0)} KB`);
    console.log(`🏥 Health check: https://0.0.0.0:${http2Port}/health`);
    console.log("=".repeat(60) + "\n");
    console.log("💡 Pro Android: Použij https://192.168.50.96:3443");
    console.log("   (Self-signed cert - bude potřeba trust v aplikaci)");
    console.log("=".repeat(60) + "\n");
  });
} catch (err) {
  console.error("⚠️  HTTP/2 server se nepodařilo spustit:", err.message);
  console.log("   Server běží pouze na HTTP/1.1\n");
}
