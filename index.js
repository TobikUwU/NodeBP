const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const obj2gltf = require("obj2gltf");
const gltfPipeline = require("gltf-pipeline");
const processGltf = gltfPipeline.processGltf;
const glbToGltf = gltfPipeline.glbToGltf;
const gltfToGlb = gltfPipeline.gltfToGlb;
const AdmZip = require("adm-zip");
const { exec } = require("child_process");

const app = express();
const port = 3000;

// Vytvoření dočasné složky pro upload, pokud neexistuje
const UPLOAD_DIR = "./tmp_uploads";
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
}

// Nastavení multeru pro ukládání souborů na disk
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const upload = multer({ storage: storage });

// Vytvoření složky pro veřejně dostupné modely
const MODELS_DIR = path.join(__dirname, "public", "models");
if (!fs.existsSync(MODELS_DIR)) {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
}

// Middleware pro servírování statických souborů (např. modelů) z adresáře 'public'
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json()); // Middleware pro parsování JSON těla požadavků

// Endpoint pro zabalení existujícího .gltf modelu na serveru do .glb s Draco kompresí
app.post("/pack-model", (req, res) => {
  const { inputPath } = req.body;

  if (!inputPath || typeof inputPath !== "string") {
    return res
      .status(400)
      .json({ message: "Chybí nebo je neplatná cesta k souboru (inputPath)." });
  }
  if (path.extname(inputPath).toLowerCase() !== ".gltf") {
    return res.status(400).json({ message: "Vstupní soubor musí být .gltf." });
  }
  if (!fs.existsSync(inputPath)) {
    return res
      .status(404)
      .json({ message: "Zadaný soubor na serveru neexistuje." });
  }

  const outputName = `${path.parse(inputPath).name}.glb`;
  const outputPath = path.join(MODELS_DIR, outputName);
  const resourceDir = path.dirname(inputPath);

  try {
    const gltf = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    const options = {
      resourceDirectory: resourceDir,
      dracoOptions: {
        compressionLevel: 10,
      },
    };

    console.log(`Spouštím balení a Draco kompresi pro: ${inputPath}`);

    gltfToGlb(gltf, options)
      .then(function (results) {
        fs.writeFileSync(outputPath, results.glb);
        console.log(`Model úspěšně uložen do: ${outputPath}`);
        res.json({
          success: true,
          message: `Model ${outputName} byl úspěšně vytvořen a uložen.`,
        });
      })
      .catch(function (err) {
        console.error("Chyba při balení modelu:", err);
        res.status(500).json({
          message: "Při konverzi modelu došlo k chybě.",
          error: err.message,
        });
      });
  } catch (err) {
    console.error("Chyba při čtení souboru:", err);
    res.status(500).json({
      message: "Nepodařilo se přečíst vstupní .gltf soubor.",
      error: err.message,
    });
  }
});

// Endpoint pro získání seznamu dostupných modelů
app.get("/models", (req, res) => {
  fs.readdir(MODELS_DIR, (err, files) => {
    if (err) {
      console.error("Chyba při čtení adresáře modelů:", err);
      return res.status(500).send("Chyba na straně serveru.");
    }
    // Filtrujeme jen .glb soubory a pošleme jejich názvy jako JSON pole
    const glbFiles = files.filter(
      (file) => path.extname(file).toLowerCase() === ".glb",
    );
    res.json(glbFiles);
  });
});

// Původní endpoint pro nahrání a konverzi JEDNOHO souboru
app.post("/upload", upload.single("model"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "Nebyl nahrán žádný soubor." });
  }

  const tempFilePath = req.file.path;
  console.log(`Přijat a dočasně uložen soubor: ${tempFilePath}`);

  try {
    const fileExtension = path.extname(req.file.originalname).toLowerCase();
    let gltf;

    switch (fileExtension) {
      case ".obj":
        console.log("Fáze 1: Konverze z OBJ na glTF z cesty:", tempFilePath);
        gltf = await obj2gltf(tempFilePath);
        break;
      case ".gltf":
        console.log("Fáze 1: Čtení a parsování textového glTF...");
        const gltfBuffer = fs.readFileSync(tempFilePath);
        gltf = JSON.parse(gltfBuffer.toString("utf8"));
        break;
      case ".glb":
        console.log("Fáze 1: Čtení a parsování binárního GLB na glTF...");
        const glbBuffer = fs.readFileSync(tempFilePath);
        const results = await glbToGltf(glbBuffer);
        gltf = results.gltf;
        break;
      default:
        return res
          .status(400)
          .json({ message: `Nepodporovaný typ souboru: ${fileExtension}` });
    }

    const options = {
      dracoOptions: {
        compressionLevel: 10,
      },
    };
    const results = await gltfToGlb(gltf, options);
    const glbBuffer = results.glb;

    const originalName = path.parse(req.file.originalname).name;
    const newFileName = `${originalName}.glb`;
    const outputPath = path.join(MODELS_DIR, newFileName);

    fs.writeFileSync(outputPath, glbBuffer);

    console.log(
      `Konverze úspěšná. Soubor uložen do: ${outputPath}, Velikost: ${glbBuffer.length} bytů.`,
    );

    res.json({
      message: `Model ${newFileName} byl úspěšně uložen.`,
      fileName: newFileName,
    });
  } catch (error) {
    console.error("Došlo k chybě při konverzi:", error);
    res
      .status(500)
      .json({ message: `Chyba při zpracování modelu: ${error.message}` });
  } finally {
    if (fs.existsSync(tempFilePath)) {
      fs.unlink(tempFilePath, (err) => {
        if (err)
          console.error(
            `Chyba při mazání dočasného souboru ${tempFilePath}:`,
            err,
          );
        else console.log(`Dočasný soubor ${tempFilePath} smazán.`);
      });
    }
  }
});

// --- NOVÁ FUNKCE PRO ZPRACOVÁNÍ ZIP BALÍČKŮ ---

// Rekurzivní pomocná funkce pro nalezení všech souborů v adresáři
function getAllFiles(dirPath, arrayOfFiles) {
  const files = fs.readdirSync(dirPath);
  arrayOfFiles = arrayOfFiles || [];
  files.forEach(function (file) {
    if (fs.statSync(path.join(dirPath, file)).isDirectory()) {
      arrayOfFiles = getAllFiles(path.join(dirPath, file), arrayOfFiles);
    } else {
      arrayOfFiles.push(path.join(dirPath, file));
    }
  });
  return arrayOfFiles;
}

const uploadZip = multer({ storage: multer.memoryStorage() });

// Nový endpoint pro nahrání a zpracování ZIP balíčku
app.post("/upload-packaged", uploadZip.single("packageZip"), (req, res) => {
  let tempDir = null; // Sledování dočasné složky pro finální úklid

  const cleanup = () => {
    if (tempDir) {
      fs.rm(tempDir, { recursive: true, force: true }, (err) => {
        if (err) {
          console.error(`Chyba při mazání dočasného adresáře ${tempDir}:`, err);
        } else {
          console.log(`Dočasný adresář ${tempDir} smazán.`);
        }
      });
    }
  };

  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ message: "Nebyl nahrán žádný ZIP soubor." });
    }

    // Vytvoření unikátní dočasné složky
    const tempDirPrefix = path.join(UPLOAD_DIR, "zip-");
    tempDir = fs.mkdtempSync(tempDirPrefix);

    console.log(`Vytvořen dočasný adresář: ${tempDir}`);

    // Rozbalení bufferu do dočasné složky
    const zip = new AdmZip(req.file.buffer);
    zip.extractAllTo(tempDir, /*overwrite*/ true);
    console.log(`ZIP soubor úspěšně rozbalen do ${tempDir}`);

    // Nalezení .gltf souboru v rozbalené struktuře
    const allFiles = getAllFiles(tempDir);
    const gltfFilePath = allFiles.find((f) =>
      f.toLowerCase().endsWith(".gltf"),
    );

    if (!gltfFilePath) {
      cleanup(); // Úklid předčasného ukončení
      return res
        .status(400)
        .json({ message: "ZIP soubor musí obsahovat jeden .gltf soubor." });
    }

    const outputName = `${path.parse(gltfFilePath).name}.glb`;
    const outputPath = path.join(MODELS_DIR, outputName);
    const resourceDir = path.dirname(gltfFilePath);

    console.log(`Spouštím balení a kompresi pro: ${gltfFilePath}`);

    const gltf = JSON.parse(fs.readFileSync(gltfFilePath, "utf8"));
    const options = {
      resourceDirectory: resourceDir,
      dracoOptions: {
        compressionLevel: 10,
      },
    };

    gltfToGlb(gltf, options)
      .then((results) => {
        fs.writeFileSync(outputPath, results.glb);
        console.log(`Model úspěšně uložen do: ${outputPath}`);
        if (!res.headersSent) {
          res.json({
            success: true,
            message: `Model ${outputName} byl úspěšně vytvořen a uložen.`,
          });
        }
      })
      .catch((err) => {
        console.error("Chyba při konverzi modelu:", err);
        if (!res.headersSent) {
          res.status(500).json({
            message: "Při konverzi modelu došlo k chybě.",
            error: err.message,
          });
        }
      })
      .finally(() => {
        cleanup();
      });
  } catch (err) {
    console.error("Chyba při zpracování ZIP balíčku:", err);
    if (!res.headersSent) {
      res.status(500).json({
        message: "Při zpracování ZIP balíčku došlo k chybě.",
        error: err.message,
      });
    }
    cleanup(); // Úklid v případě synchronní chyby
  }
});

app.listen(port, () => {
  console.log(`Server běží na http://localhost:${port}`);
});
