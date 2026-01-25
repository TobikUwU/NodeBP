const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
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
[UPLOAD_DIR, MODELS_DIR, CHUNKS_DIR, METADATA_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Middleware
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ============================================================================
// UTILITY FUNKCE
// ============================================================================

function getAllFiles(dirPath, arrayOfFiles = []) {
  const files = fs.readdirSync(dirPath);
  files.forEach(function (file) {
    const filePath = path.join(dirPath, file);
    if (fs.statSync(filePath).isDirectory()) {
      arrayOfFiles = getAllFiles(filePath, arrayOfFiles);
    } else {
      arrayOfFiles.push(filePath);
    }
  });
  return arrayOfFiles;
}

// Výpočet hash souboru pro kontrolu integrity
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
// CHUNKING SYSTÉM
// ============================================================================

/**
 * Rozdělí model na chunky pro inkrementální download
 */
async function createChunks(modelPath, modelName) {
  const modelDir = path.join(CHUNKS_DIR, modelName.replace(".glb", ""));

  if (!fs.existsSync(modelDir)) {
    fs.mkdirSync(modelDir, { recursive: true });
  }

  const fileSize = fs.statSync(modelPath).size;
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

  console.log(`📦 Vytvářím ${totalChunks} chunků pro ${modelName}...`);

  const readStream = fs.createReadStream(modelPath, {
    highWaterMark: CHUNK_SIZE,
  });
  let chunkIndex = 0;
  const chunkHashes = [];

  return new Promise((resolve, reject) => {
    readStream.on("data", async (chunk) => {
      const chunkPath = path.join(modelDir, `chunk_${chunkIndex}.bin`);
      fs.writeFileSync(chunkPath, chunk);

      // Vypočti hash pro každý chunk
      const chunkHash = crypto.createHash("sha256").update(chunk).digest("hex");
      chunkHashes.push(chunkHash);

      chunkIndex++;
    });

    readStream.on("end", async () => {
      // Vytvoř metadata soubor
      const fileHash = await calculateFileHash(modelPath);

      const metadata = {
        modelName,
        totalChunks,
        chunkSize: CHUNK_SIZE,
        totalSize: fileSize,
        fileHash,
        chunkHashes,
        created: new Date().toISOString(),
      };

      const metadataPath = path.join(METADATA_DIR, `${modelName}.json`);
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

      console.log(`✅ Chunky vytvořeny: ${totalChunks} chunks`);
      resolve(metadata);
    });

    readStream.on("error", reject);
  });
}

// ============================================================================
// OPTIMALIZACE TEXTUR (původní funkce)
// ============================================================================

async function optimizeTextures(gltfPath, resourceDir) {
  try {
    const gltf = JSON.parse(fs.readFileSync(gltfPath, "utf8"));

    if (!gltf.images || gltf.images.length === 0) {
      console.log("Model neobsahuje žádné textury.");
      return gltf;
    }

    console.log(
      `📸 Nalezeno ${gltf.images.length} textur, spouštím optimalizaci...`,
    );

    let totalOriginalSize = 0;
    let totalOptimizedSize = 0;

    for (let i = 0; i < gltf.images.length; i++) {
      const image = gltf.images[i];

      if (!image.uri) {
        console.log(`  ⏭️  Přeskakuji embedded texturu [${i}]`);
        continue;
      }

      const imagePath = path.join(resourceDir, image.uri);

      if (!fs.existsSync(imagePath)) {
        console.log(`  ⚠️  Textura nenalezena: ${imagePath}`);
        continue;
      }

      const ext = path.extname(imagePath).toLowerCase();
      const baseName = path.basename(imagePath, ext);
      const optimizedPath = path.join(resourceDir, `${baseName}_opt.jpg`);

      try {
        const originalSize = fs.statSync(imagePath).size;
        totalOriginalSize += originalSize;

        const metadata = await sharp(imagePath).metadata();

        let maxSize;
        if (metadata.width > 4096 || metadata.height > 4096) {
          maxSize = 2048;
        } else if (metadata.width > 2048 || metadata.height > 2048) {
          maxSize = 2048;
        } else if (metadata.width > 1024 || metadata.height > 1024) {
          maxSize = 1024;
        } else {
          maxSize = metadata.width;
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

        const optimizedSize = fs.statSync(optimizedPath).size;
        totalOptimizedSize += optimizedSize;

        const savings = ((1 - optimizedSize / originalSize) * 100).toFixed(1);
        const origMB = (originalSize / 1024 / 1024).toFixed(2);
        const optMB = (optimizedSize / 1024 / 1024).toFixed(2);

        console.log(`  ✅ ${image.uri}`);
        console.log(`     ${origMB} MB → ${optMB} MB (úspora ${savings}%)`);

        image.uri = `${baseName}_opt.jpg`;
        image.mimeType = "image/jpeg";
      } catch (err) {
        console.error(`  ❌ Chyba při optimalizaci ${imagePath}:`, err.message);
      }
    }

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

    fs.writeFileSync(gltfPath, JSON.stringify(gltf, null, 2));

    return gltf;
  } catch (err) {
    console.error("❌ Chyba při optimalizaci textur:", err);
    throw err;
  }
}

// ============================================================================
// UPLOAD ENDPOINT (původní + chunking)
// ============================================================================

const uploadZip = multer({ storage: multer.memoryStorage() });

app.post("/upload-model", uploadZip.single("modelZip"), async (req, res) => {
  let tempDir = null;

  const cleanup = () => {
    if (tempDir) {
      fs.rm(tempDir, { recursive: true, force: true }, (err) => {
        if (err) console.error(`Chyba při mazání ${tempDir}:`, err);
        else console.log(`🗑️  Dočasný adresář smazán: ${tempDir}`);
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
    console.log(`📁 Dočasný adresář: ${tempDir}`);

    const zip = new AdmZip(req.file.buffer);
    zip.extractAllTo(tempDir, true);
    console.log("📂 ZIP soubor rozbalen");

    const allFiles = getAllFiles(tempDir);
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
    fs.writeFileSync(outputPath, results.glb);

    const finalSizeMB = (results.glb.length / 1024 / 1024).toFixed(2);

    // NOVÉ: Vytvoř chunky
    console.log("\n--- KROK 3: Vytváření chunků ---");
    const metadata = await createChunks(outputPath, outputName);

    console.log("\n" + "=".repeat(60));
    console.log(`✅ HOTOVO!`);
    console.log(`📦 Model: ${outputName}`);
    console.log(`💾 Velikost: ${finalSizeMB} MB`);
    console.log(`📦 Chunky: ${metadata.totalChunks}`);
    console.log(`📍 Uloženo: ${outputPath}`);
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
// NOVÉ: CHUNK ENDPOINTS
// ============================================================================

// Získat metadata modelu
app.get("/model-metadata/:modelName", (req, res) => {
  const modelName = req.params.modelName;
  const metadataPath = path.join(METADATA_DIR, `${modelName}.json`);

  if (!fs.existsSync(metadataPath)) {
    return res.status(404).json({
      success: false,
      message: "Metadata nenalezena.",
    });
  }

  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  res.json({
    success: true,
    metadata,
  });
});

// Stáhnout konkrétní chunk
app.get("/download-chunk/:modelName/:chunkIndex", (req, res) => {
  const { modelName, chunkIndex } = req.params;
  const modelDir = path.join(CHUNKS_DIR, modelName.replace(".glb", ""));
  const chunkPath = path.join(modelDir, `chunk_${chunkIndex}.bin`);

  if (!fs.existsSync(chunkPath)) {
    return res.status(404).json({
      success: false,
      message: "Chunk nenalezen.",
    });
  }

  // Přidej ETag pro caching
  const stats = fs.statSync(chunkPath);
  const etag = `"${stats.size}-${stats.mtime.getTime()}"`;

  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "public, max-age=31536000"); // 1 rok

  if (req.headers["if-none-match"] === etag) {
    return res.status(304).end();
  }

  res.sendFile(chunkPath);
});

// ============================================================================
// SEZNAM MODELŮ (vylepšený o chunk info)
// ============================================================================

app.get("/models", (req, res) => {
  fs.readdir(MODELS_DIR, (err, files) => {
    if (err) {
      console.error("Chyba při čtení modelů:", err);
      return res.status(500).json({
        success: false,
        message: "Chyba serveru.",
      });
    }

    const models = files
      .filter((file) => path.extname(file).toLowerCase() === ".glb")
      .map((file) => {
        const filePath = path.join(MODELS_DIR, file);
        const stats = fs.statSync(filePath);

        // Zkontroluj, zda existují metadata
        const metadataPath = path.join(METADATA_DIR, `${file}.json`);
        let chunked = false;
        let totalChunks = 0;

        if (fs.existsSync(metadataPath)) {
          const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
          chunked = true;
          totalChunks = metadata.totalChunks;
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
      })
      .sort((a, b) => b.modified - a.modified);

    res.json({
      success: true,
      count: models.length,
      models: models,
    });
  });
});

// ============================================================================
// PŮVODNÍ DOWNLOAD ENDPOINT (s vylepšeným cachingem)
// ============================================================================

app.get("/download-model/:modelName", (req, res) => {
  const modelName = req.params.modelName;
  const filePath = path.join(MODELS_DIR, modelName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      success: false,
      message: "Model nebyl nalezen.",
    });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const etag = `"${fileSize}-${stat.mtime.getTime()}"`;

  // ETag caching
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
});

// ============================================================================
// INFO O MODELU
// ============================================================================

app.get("/model-info/:modelName", (req, res) => {
  const modelName = req.params.modelName;
  const filePath = path.join(MODELS_DIR, modelName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      success: false,
      message: "Model nebyl nalezen.",
    });
  }

  const stats = fs.statSync(filePath);

  // Zkontroluj metadata
  const metadataPath = path.join(METADATA_DIR, `${modelName}.json`);
  let metadata = null;

  if (fs.existsSync(metadataPath)) {
    metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
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
});

// ============================================================================
// VYTVOŘENÍ CHUNKŮ PRO EXISTUJÍCÍ MODEL
// ============================================================================

app.post("/create-chunks/:modelName", async (req, res) => {
  const modelName = req.params.modelName;
  const modelPath = path.join(MODELS_DIR, modelName);

  if (!fs.existsSync(modelPath)) {
    return res.status(404).json({
      success: false,
      message: "Model nebyl nalezen.",
    });
  }

  try {
    console.log(`\n📦 Vytváření chunků pro existující model: ${modelName}`);
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
    console.error("❌ Chyba při vytváření chunků:", err);
    res.status(500).json({
      success: false,
      message: "Chyba při vytváření chunků.",
      error: err.message,
    });
  }
});

// Vytvoř chunky pro všechny existující modely bez chunků
app.post("/create-all-chunks", async (req, res) => {
  try {
    const files = fs.readdirSync(MODELS_DIR);
    const glbFiles = files.filter((f) => f.toLowerCase().endsWith(".glb"));

    const results = [];

    for (const file of glbFiles) {
      const metadataPath = path.join(METADATA_DIR, `${file}.json`);

      // Přeskoč, pokud už má chunky
      if (fs.existsSync(metadataPath)) {
        results.push({
          model: file,
          status: "skipped",
          message: "Již má chunky",
        });
        continue;
      }

      try {
        const modelPath = path.join(MODELS_DIR, file);
        console.log(`\n📦 Vytváření chunků pro: ${file}`);
        await createChunks(modelPath, file);

        results.push({
          model: file,
          status: "success",
          message: "Chunky vytvořeny",
        });
      } catch (err) {
        console.error(`❌ Chyba při vytváření chunků pro ${file}:`, err);
        results.push({
          model: file,
          status: "error",
          message: err.message,
        });
      }
    }

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
// SMAZÁNÍ MODELU (+ chunků)
// ============================================================================

app.delete("/model/:modelName", (req, res) => {
  const modelName = req.params.modelName;
  const filePath = path.join(MODELS_DIR, modelName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      success: false,
      message: "Model nebyl nalezen.",
    });
  }

  // Smaž model
  fs.unlink(filePath, (err) => {
    if (err) {
      console.error("Chyba při mazání:", err);
      return res.status(500).json({
        success: false,
        message: "Chyba při mazání modelu.",
      });
    }

    // Smaž chunky
    const modelDir = path.join(CHUNKS_DIR, modelName.replace(".glb", ""));
    if (fs.existsSync(modelDir)) {
      fs.rmSync(modelDir, { recursive: true, force: true });
    }

    // Smaž metadata
    const metadataPath = path.join(METADATA_DIR, `${modelName}.json`);
    if (fs.existsSync(metadataPath)) {
      fs.unlinkSync(metadataPath);
    }

    res.json({
      success: true,
      message: `Model ${modelName} byl smazán včetně chunků.`,
    });
  });
});

// ============================================================================
// START SERVERU
// ============================================================================

app.listen(port, "0.0.0.0", () => {
  console.log("\n" + "=".repeat(60));
  console.log(`🚀 Server běží na http://0.0.0.0:${port}`);
  console.log(`📦 Modely: http://0.0.0.0:${port}/models`);
  console.log(`💾 Chunk size: ${(CHUNK_SIZE / 1024).toFixed(0)} KB`);
  console.log("=".repeat(60) + "\n");
});
