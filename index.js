const express = require("express");
const multer = require("multer");
const gltfPipeline = require("gltf-pipeline");
const fs = require("fs");

const app = express();
const port = 3000;

// Nastavení multeru pro ukládání souborů do paměti
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Hlavní endpoint pro nahrání a konverzi modelu
app.post("/upload", upload.single("model"), async (req, res) => {
  if (!req.file) {
    return res.status(400).send("Nebyl nahrán žádný soubor.");
  }

  console.log(
    `Přijat soubor: ${req.file.originalname}, zahajuji konverzi na GLB s Draco kompresí...`,
  );

  const objBuffer = req.file.buffer;
  const options = {
    dracoOptions: {
      compressionLevel: 10, // Nejvyšší komprese
    },
  };

  try {
    const results = await gltfPipeline.objToGltf(objBuffer, options);
    const glbBuffer = results.glb;

    console.log("Konverze úspěšná. Velikost GLB:", glbBuffer.length, "bytů.");

    // Nastavení hlaviček pro odeslání souboru
    res.set({
      "Content-Type": "model/gltf-binary",
      "Content-Disposition": 'attachment; filename="model.glb"',
    });

    res.send(glbBuffer);
  } catch (error) {
    console.error("Došlo k chybě při konverzi:", error);
    res.status(500).send(`Chyba při zpracování modelu: ${error.message}`);
  }
});

app.listen(port, () => {
  console.log(`Server běží na http://localhost:${port}`);
  const uploadDir = "uploads";
  if (fs.existsSync(uploadDir)) {
    fs.rmSync(uploadDir, { recursive: true, force: true });
    console.log("Složka 'uploads' byla smazána, protože již není potřeba.");
  }
});
