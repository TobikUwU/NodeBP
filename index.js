const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const gltfPipeline = require("gltf-pipeline");
const gltfToGlb = gltfPipeline.gltfToGlb;
const AdmZip = require("adm-zip");
const sharp = require("sharp"); // npm install sharp

const app = express();
const port = 3000;

// Vytvoření dočasné složky pro upload, pokud neexistuje
const UPLOAD_DIR = "./tmp_uploads";
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
}

// Vytvoření složky pro veřejně dostupné modely
const MODELS_DIR = path.join(__dirname, "public", "models");
if (!fs.existsSync(MODELS_DIR)) {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
}

// Middleware
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Rekurzivní funkce pro nalezení všech souborů
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

// FUNKCE: Optimalizace textur
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

        // Zjisti rozměry
        const metadata = await sharp(imagePath).metadata();

        // Rozhodnutí o max rozlišení podle původní velikosti
        let maxSize;
        if (metadata.width > 4096 || metadata.height > 4096) {
          maxSize = 2048; // 4K+ → 2K
        } else if (metadata.width > 2048 || metadata.height > 2048) {
          maxSize = 2048; // 2K+ → 2K
        } else if (metadata.width > 1024 || metadata.height > 1024) {
          maxSize = 1024; // 1K+ → 1K
        } else {
          maxSize = metadata.width; // Malé textury ponechat
        }

        // Komprimuj
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

        // Aktualizuj URI v GLTF
        image.uri = `${baseName}_opt.jpg`;
        image.mimeType = "image/jpeg";
      } catch (err) {
        console.error(`  ❌ Chyba při optimalizaci ${imagePath}:`, err.message);
      }
    }

    // Celková statistika
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

    // Ulož upravený GLTF
    fs.writeFileSync(gltfPath, JSON.stringify(gltf, null, 2));

    return gltf;
  } catch (err) {
    console.error("❌ Chyba při optimalizaci textur:", err);
    throw err;
  }
}

const uploadZip = multer({ storage: multer.memoryStorage() });

// HLAVNÍ ENDPOINT: Upload ZIP s GLTF + texturami
app.post("/upload-model", uploadZip.single("modelZip"), async (req, res) => {
  let tempDir = null;

  const cleanup = () => {
    if (tempDir) {
      fs.rm(tempDir, { recursive: true, force: true }, (err) => {
        if (err) {
          console.error(`Chyba při mazání ${tempDir}:`, err);
        } else {
          console.log(`🗑️  Dočasný adresář smazán: ${tempDir}`);
        }
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

    // Vytvoř dočasnou složku
    const tempDirPrefix = path.join(UPLOAD_DIR, "model-");
    tempDir = fs.mkdtempSync(tempDirPrefix);
    console.log(`📁 Dočasný adresář: ${tempDir}`);

    // Rozbal ZIP
    const zip = new AdmZip(req.file.buffer);
    zip.extractAllTo(tempDir, true);
    console.log("📂 ZIP soubor rozbalen");

    // Najdi GLTF soubor
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

    // KROK 1: Optimalizace textur
    console.log("\n--- KROK 1: Optimalizace textur ---");
    const gltf = await optimizeTextures(gltfFilePath, resourceDir);

    // KROK 2: Draco komprese + balení do GLB
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

    console.log("\n" + "=".repeat(60));
    console.log(`✅ HOTOVO!`);
    console.log(`📦 Model: ${outputName}`);
    console.log(`💾 Velikost: ${finalSizeMB} MB`);
    console.log(`📍 Uloženo: ${outputPath}`);
    console.log("=".repeat(60) + "\n");

    cleanup();

    res.json({
      success: true,
      message: `Model ${outputName} byl úspěšně zpracován.`,
      fileName: outputName,
      sizeInMB: parseFloat(finalSizeMB),
      path: `/models/${outputName}`,
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

// Endpoint: Získat seznam dostupných modelů
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
        return {
          name: file,
          size: stats.size,
          sizeInMB: parseFloat((stats.size / 1024 / 1024).toFixed(2)),
          created: stats.birthtime,
          modified: stats.mtime,
        };
      })
      .sort((a, b) => b.modified - a.modified); // Nejnovější první

    res.json({
      success: true,
      count: models.length,
      models: models,
    });
  });
});

// Endpoint: Stáhnout model (s podporou Range Requests)
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
  const range = req.headers.range;

  if (range) {
    // Partial download (resumable)
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
    });

    file.pipe(res);
  } else {
    // Full download
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": "model/gltf-binary",
      "Content-Disposition": `attachment; filename="${modelName}"`,
    });

    fs.createReadStream(filePath).pipe(res);
  }
});

// Endpoint: Info o modelu
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

  res.json({
    success: true,
    model: {
      name: modelName,
      size: stats.size,
      sizeInMB: parseFloat((stats.size / 1024 / 1024).toFixed(2)),
      created: stats.birthtime,
      modified: stats.mtime,
      downloadUrl: `/download-model/${modelName}`,
    },
  });
});

// Endpoint: Smazat model
app.delete("/model/:modelName", (req, res) => {
  const modelName = req.params.modelName;
  const filePath = path.join(MODELS_DIR, modelName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      success: false,
      message: "Model nebyl nalezen.",
    });
  }

  fs.unlink(filePath, (err) => {
    if (err) {
      console.error("Chyba při mazání:", err);
      return res.status(500).json({
        success: false,
        message: "Chyba při mazání modelu.",
      });
    }

    res.json({
      success: true,
      message: `Model ${modelName} byl smazán.`,
    });
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log("\n" + "=".repeat(60));
  console.log(`🚀 Server běží na http://0.0.0.0:${port}`);
  console.log(`📦 Modely: http://0.0.0.0:${port}/models`);
  console.log("=".repeat(60) + "\n");
});
