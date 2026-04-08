import path from "node:path";
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execSync } from "node:child_process";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  cloneDocument,
  copyToDocument,
  dedup,
  getBounds,
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
const OVERVIEW_STAGES = [
  { id: "overview-lod0", file: "overview.lod0.glb", ratio: 0.45, error: 0.015 },
  { id: "overview-lod1", file: "overview.lod1.glb", ratio: 0.2, error: 0.03 },
  { id: "overview-lod2", file: "overview.lod2.glb", ratio: 0.08, error: 0.06 },
];
const TILE_STAGE = { id: "tile-detail", ratio: 0.75, error: 0.01 };
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

async function getRelativeFiles(dirPath) {
  const files = await getAllFiles(dirPath);
  return files.map((filePath) => path.relative(dirPath, filePath));
}

function cloneExtensions(sourceDocument, targetDocument) {
  for (const sourceExtension of sourceDocument.getRoot().listExtensionsUsed()) {
    const targetExtension = targetDocument.createExtension(
      sourceExtension.constructor,
    );
    targetExtension.setRequired(sourceExtension.isRequired());
  }
}

async function writeDocumentAsGlb(outputPath, document) {
  const glb = await io.writeBinary(document);
  await fsp.writeFile(outputPath, glb);
}

function getBoundsInfo(min, max) {
  const center = min.map((value, index) => (value + max[index]) / 2);
  const radius = Math.sqrt(
    min.reduce((sum, value, index) => {
      const delta = max[index] - value;
      return sum + delta * delta;
    }, 0),
  ) / 2;

  return {
    min,
    max,
    center,
    radius,
  };
}

function mergeBounds(boundsList) {
  if (!boundsList.length) {
    return null;
  }

  const min = [...boundsList[0].min];
  const max = [...boundsList[0].max];

  for (const bounds of boundsList.slice(1)) {
    for (let index = 0; index < 3; index += 1) {
      min[index] = Math.min(min[index], bounds.min[index]);
      max[index] = Math.max(max[index], bounds.max[index]);
    }
  }

  return getBoundsInfo(min, max);
}

function countPrimitiveTriangles(primitive) {
  const indices = primitive.getIndices();
  const positions = primitive.getAttribute("POSITION");
  const vertexCount = indices?.getCount() ?? positions?.getCount() ?? 0;

  switch (primitive.getMode()) {
    case 5:
    case 6:
      return Math.max(vertexCount - 2, 0);
    case 4:
    default:
      return Math.floor(vertexCount / 3);
  }
}

function getMeshStatsFromNode(node) {
  const mesh = node.getMesh();

  if (!mesh) {
    return {
      primitiveCount: 0,
      triangleCount: 0,
      materialCount: 0,
    };
  }

  const materials = new Set();
  let primitiveCount = 0;
  let triangleCount = 0;

  for (const primitive of mesh.listPrimitives()) {
    primitiveCount += 1;
    triangleCount += countPrimitiveTriangles(primitive);

    const material = primitive.getMaterial();
    if (material) {
      materials.add(material);
    }
  }

  return {
    primitiveCount,
    triangleCount,
    materialCount: materials.size,
  };
}

function getDocumentMeshStats(document) {
  const root = document.getRoot();
  const scene = root.getDefaultScene() || root.listScenes()[0];

  if (!scene) {
    return {
      nodeCount: 0,
      meshNodeCount: 0,
      primitiveCount: 0,
      triangleCount: 0,
      materialCount: 0,
    };
  }

  const materials = new Set();
  let nodeCount = 0;
  let meshNodeCount = 0;
  let primitiveCount = 0;
  let triangleCount = 0;

  const visit = (node) => {
    nodeCount += 1;

    const meshStats = getMeshStatsFromNode(node);
    if (meshStats.primitiveCount > 0) {
      meshNodeCount += 1;
      primitiveCount += meshStats.primitiveCount;
      triangleCount += meshStats.triangleCount;

      const mesh = node.getMesh();
      for (const primitive of mesh.listPrimitives()) {
        const material = primitive.getMaterial();
        if (material) {
          materials.add(material);
        }
      }
    }

    for (const child of node.listChildren()) {
      visit(child);
    }
  };

  for (const child of scene.listChildren()) {
    visit(child);
  }

  return {
    nodeCount,
    meshNodeCount,
    primitiveCount,
    triangleCount,
    materialCount: materials.size,
  };
}

function buildTileStreamingPlan(tiles) {
  const childMap = new Map();

  for (const tile of tiles) {
    if (!tile.parentId) {
      continue;
    }

    if (!childMap.has(tile.parentId)) {
      childMap.set(tile.parentId, []);
    }

    childMap.get(tile.parentId).push(tile.id);
  }

  const traversalOrder = [...tiles]
    .sort((left, right) => {
      if (left.depth !== right.depth) {
        return left.depth - right.depth;
      }

      if (left.bounds.radius !== right.bounds.radius) {
        return right.bounds.radius - left.bounds.radius;
      }

      if (left.size !== right.size) {
        return right.size - left.size;
      }

      return left.id.localeCompare(right.id);
    })
    .map((tile) => tile.id);

  const priorityMap = new Map(
    traversalOrder.map((tileId, index) => [tileId, index + 1]),
  );

  return {
    traversalOrder,
    tiles: tiles.map((tile) => ({
      ...tile,
      children: childMap.get(tile.id) || [],
      priority: priorityMap.get(tile.id),
      screenCoverageHint: Number(
        (tile.bounds.radius * Math.max(1, 3 - tile.depth)).toFixed(4),
      ),
    })),
  };
}

function collectTileCandidates(sourceDocument) {
  const root = sourceDocument.getRoot();
  const scene = root.getDefaultScene() || root.listScenes()[0];

  if (!scene) {
    return [];
  }

  const candidates = [];
  let index = 0;

  const visit = (node, depth, parentTileId) => {
    let currentParentTileId = parentTileId;

    if (node.getMesh()) {
      const { min, max } = getBounds(node);
      const tileId = `tile-${index++}`;
      candidates.push({
        id: tileId,
        node,
        name: node.getName() || tileId,
        depth,
        parentId: parentTileId,
        bounds: getBoundsInfo(min, max),
      });
      currentParentTileId = tileId;
    }

    for (const child of node.listChildren()) {
      visit(child, depth + 1, currentParentTileId);
    }
  };

  for (const child of scene.listChildren()) {
    visit(child, 0, null);
  }

  return candidates;
}

async function createTileDocument(sourceDocument, sourceNode) {
  const tileDocument = new Document();
  cloneExtensions(sourceDocument, tileDocument);

  const tileScene = tileDocument.createScene("TileScene");
  const map = copyToDocument(tileDocument, sourceDocument, [sourceNode]);
  const tileNode = map.get(sourceNode);

  if (!tileNode) {
    throw new Error("Nepodařilo se zkopírovat tile node.");
  }

  tileNode.setMatrix(sourceNode.getWorldMatrix());
  tileScene.addChild(tileNode);

  return tileDocument;
}

async function buildOverviewStages(sourceDocument, modelDir) {
  const overviewDir = path.join(modelDir, "overview");
  await fsp.mkdir(overviewDir, { recursive: true });

  const stages = [];

  for (const stage of OVERVIEW_STAGES) {
    try {
      const stageDocument = cloneDocument(sourceDocument);
      await stageDocument.transform(
        weld(),
        simplify({
          simplifier: MeshoptSimplifier,
          ratio: stage.ratio,
          error: stage.error,
        }),
        dedup(),
        prune(),
        reorder({ encoder: MeshoptEncoder, target: "size" }),
      );
      const meshStats = getDocumentMeshStats(stageDocument);

      const relativePath = path.join("overview", stage.file);
      const absolutePath = path.join(modelDir, relativePath);
      await writeDocumentAsGlb(absolutePath, stageDocument);
      const stats = await fsp.stat(absolutePath);

      stages.push({
        id: stage.id,
        file: relativePath,
        url: `/models/${path.basename(modelDir)}/${relativePath}`,
        size: stats.size,
        ratio: stage.ratio,
        error: stage.error,
        geometricError: Number((stage.error * 100).toFixed(4)),
        triangleCount: meshStats.triangleCount,
        primitiveCount: meshStats.primitiveCount,
        meshNodeCount: meshStats.meshNodeCount,
      });
    } catch (error) {
      console.error(`Overview stage ${stage.id} se nepodařilo vytvořit:`, error);
    }
  }

  if (stages.length === 0) {
    throw new Error("Nepodařilo se vytvořit žádný overview stage.");
  }

  return stages;
}

async function buildDetailTiles(
  sourceDocument,
  modelDir,
  tileCandidates = collectTileCandidates(sourceDocument),
) {
  const tilesDir = path.join(modelDir, "tiles");
  await fsp.mkdir(tilesDir, { recursive: true });

  const tiles = [];

  for (const candidate of tileCandidates) {
    try {
      const tileDocument = await createTileDocument(sourceDocument, candidate.node);
      await tileDocument.transform(
        weld(),
        simplify({
          simplifier: MeshoptSimplifier,
          ratio: TILE_STAGE.ratio,
          error: TILE_STAGE.error,
        }),
        dedup(),
        prune(),
        reorder({ encoder: MeshoptEncoder, target: "size" }),
      );
      const meshStats = getDocumentMeshStats(tileDocument);

      const relativePath = path.join("tiles", `${candidate.id}.glb`);
      const absolutePath = path.join(modelDir, relativePath);
      await writeDocumentAsGlb(absolutePath, tileDocument);
      const stats = await fsp.stat(absolutePath);

      tiles.push({
        id: candidate.id,
        parentId: candidate.parentId,
        name: candidate.name,
        depth: candidate.depth,
        refinement: "replace",
        format: "glb",
        file: relativePath,
        url: `/models/${path.basename(modelDir)}/${relativePath}`,
        size: stats.size,
        ratio: TILE_STAGE.ratio,
        error: TILE_STAGE.error,
        geometricError: Number((candidate.bounds.radius * TILE_STAGE.error).toFixed(4)),
        bounds: candidate.bounds,
        triangleCount: meshStats.triangleCount,
        primitiveCount: meshStats.primitiveCount,
        meshNodeCount: meshStats.meshNodeCount,
      });
    } catch (error) {
      console.error(`Tile ${candidate.id} se nepodařilo vytvořit:`, error);
    }
  }

  return tiles;
}

async function buildStreamingPackage(modelName, sourceDocument, modelDir) {
  await MeshoptEncoder.ready;
  await MeshoptSimplifier.ready;

  const tileCandidates = collectTileCandidates(sourceDocument);
  const sourceStats = getDocumentMeshStats(sourceDocument);
  const sceneBounds = mergeBounds(tileCandidates.map((candidate) => candidate.bounds));
  const overviewStages = await buildOverviewStages(sourceDocument, modelDir);
  const rawDetailTiles = await buildDetailTiles(
    sourceDocument,
    modelDir,
    tileCandidates,
  );
  const detailTilePlan = buildTileStreamingPlan(rawDetailTiles);
  const detailTiles = detailTilePlan.tiles;
  const entryStage =
    overviewStages[overviewStages.length - 1] || overviewStages[0] || null;
  const rootTiles = detailTiles
    .filter((tile) => tile.parentId === null)
    .map((tile) => tile.id);
  const upgradeOrder = [...overviewStages].reverse().map((stage) => stage.id);

  const allFiles = await getRelativeFiles(modelDir);
  const referencedFiles = new Set([
    ...overviewStages.map((stage) => stage.file),
    ...detailTiles.map((tile) => tile.file),
  ]);

  const sharedResources = await Promise.all(
    allFiles
      .filter((file) => !referencedFiles.has(file))
      .map(async (file) => {
        const absolutePath = path.join(modelDir, file);
        const stats = await fsp.stat(absolutePath);
        return {
          path: file,
          url: `/models/${modelName}/${file}`,
          size: stats.size,
          type: path.extname(file).toLowerCase().slice(1) || "bin",
        };
      }),
  );

  const manifest = {
    version: 3,
    strategy: "hybrid_overview_tiles",
    modelName,
    delivery: {
      transport: "http-pull",
      bootstrapFormat: "json",
      overviewFormat: "glb",
      tileFormat: "glb",
    },
    renderer: "filament",
    intendedClient: "mobile",
    acceptedUploadFormats: ["zip:gltf-package", "zip:glb-package", "glb"],
    entryStage: entryStage?.id || null,
    upgradeOrder,
    bootstrap: {
      url: `/stream-bootstrap/${modelName}`,
      firstFrameStageId: entryStage?.id || null,
      firstFrameUrl: entryStage?.url || null,
      firstFrameSize: entryStage?.size || 0,
      overviewUpgradeOrder: upgradeOrder,
      rootTileCount: rootTiles.length,
    },
    scene: {
      bounds: sceneBounds,
      stats: sourceStats,
    },
    overview: {
      activeStageLimit: 1,
      stages: overviewStages.map((stage) => ({
        ...stage,
        firstFrameCandidate: stage.id === entryStage?.id,
      })),
    },
    tiles: detailTiles,
    rootTiles,
    tileTraversalOrder: detailTilePlan.traversalOrder,
    sharedResources,
    clientBudgets: {
      recommendedMaxResidentOverviewStages: 1,
      recommendedMaxActiveTiles: Math.min(Math.max(rootTiles.length * 4, 12), 48),
      recommendedConcurrentTileRequests: 4,
    },
    hints: {
      notes: [
        "Load the lightest overview stage first for fastest first frame.",
        "Keep a single overview stage resident while detail tiles progressively replace visible regions.",
        "Prioritize root tiles first, then descend into children using camera distance, bounds radius and screen coverage.",
      ],
    },
    generatedAt: new Date().toISOString(),
  };

  await fsp.writeFile(
    path.join(modelDir, "stream.manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  return manifest;
}

async function writeModelMetadata(modelName, modelDir, manifest) {
  const entryStage =
    manifest.overview.stages.find((stage) => stage.id === manifest.entryStage) ||
    manifest.overview.stages[manifest.overview.stages.length - 1] ||
    manifest.overview.stages[0];
  const stats = await fsp.stat(path.join(modelDir, entryStage.file));
  const totalSize = await getDirectorySize(modelDir);
  const metadata = {
    modelName,
    type: "mesh-stream-package",
    entryFile: entryStage.file,
    entryUrl: entryStage.url,
    assetDirectory: `/models/${modelName}/`,
    manifestUrl: `/models/${modelName}/stream.manifest.json`,
    bootstrapUrl: `/stream-bootstrap/${modelName}`,
    streamingStrategy: manifest.strategy,
    entryStage: manifest.entryStage,
    upgradeOrder: manifest.upgradeOrder,
    overviewStages: manifest.overview.stages,
    tileCount: manifest.tiles.length,
    sceneBounds: manifest.scene.bounds,
    sceneStats: manifest.scene.stats,
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

// Legacy chunk endpointy jsou vypnuté. Backend nyní generuje overview + detail tiles.

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

async function saveUploadedSource(request, targetDir) {
  if (!request.body) {
    throw new Error("Požadavek neobsahuje upload data.");
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw new Error("Upload musí být multipart/form-data.");
  }

  const headers = Object.fromEntries(request.headers.entries());

  return new Promise((resolve, reject) => {
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
    let uploadedFilePath = null;
    let uploadedFileName = null;

    busboy.on("file", (fieldName, file, info) => {
      if (fieldName !== "modelZip") {
        file.resume();
        return;
      }

      if (fileFound) {
        uploadError = new Error("Je povolen pouze jeden soubor modelu.");
        file.resume();
        return;
      }

      fileFound = true;

      const extension = path.extname(info.filename || "").toLowerCase();
      if (extension !== ".zip" && extension !== ".glb") {
        uploadError = new Error(
          "Nahraný soubor musí mít příponu .zip nebo .glb.",
        );
        file.resume();
        return;
      }

      uploadedFileName = info.filename || `upload${extension}`;
      uploadedFilePath = path.join(targetDir, uploadedFileName);

      file.on("limit", () => {
        uploadError = new Error("Nahraný soubor je příliš velký.");
      });

      const output = fs.createWriteStream(uploadedFilePath);
      fileWritePromise = pipeline(file, output);
      fileWritePromise.catch((err) => {
        uploadError ??= err;
      });
    });

    busboy.on("filesLimit", () => {
      uploadError = new Error("Je povolen pouze jeden soubor modelu.");
    });

    busboy.on("error", reject);

    busboy.on("close", async () => {
      try {
        if (!fileFound) {
          throw new Error("Nebyl nahrán žádný soubor modelu.");
        }

        if (fileWritePromise) {
          await fileWritePromise;
        }

        if (uploadError) {
          throw uploadError;
        }

        resolve({
          filePath: uploadedFilePath,
          fileName: uploadedFileName,
          extension: path.extname(uploadedFileName).toLowerCase(),
        });
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

async function normalizeSourceToGltfPackage(sourcePath, workspaceDir) {
  const extension = path.extname(sourcePath).toLowerCase();

  if (extension === ".gltf") {
    return sourcePath;
  }

  if (extension !== ".glb") {
    throw new Error("Nepodporovaný vstupní formát modelu.");
  }

  const modelName = path.parse(sourcePath).name;
  const normalizedPath = path.join(workspaceDir, `${modelName}.gltf`);
  const document = await io.read(sourcePath);
  await io.write(normalizedPath, document);
  return normalizedPath;
}

function decodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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
  let uploadedSource = null;

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

    uploadedSource = await saveUploadedSource(request, tempDir);

    let gltfFilePath = null;

    if (uploadedSource.extension === ".zip") {
      pushUploadLog(
        "ZIP soubor uložen na disk, rozbaluji archiv.",
        "extracting",
      );
      await extractZipArchive(uploadedSource.filePath, tempDir);
      console.log("ZIP soubor rozbalen");

      const allFiles = await getAllFiles(tempDir);
      const sourceModelPath =
        allFiles.find((file) => file.toLowerCase().endsWith(".gltf")) ||
        allFiles.find((file) => file.toLowerCase().endsWith(".glb"));

      if (!sourceModelPath) {
        await cleanup();
        return jsonResponse(
          {
            success: false,
            message: "ZIP musí obsahovat .gltf nebo .glb soubor!",
          },
          400,
        );
      }

      if (sourceModelPath.toLowerCase().endsWith(".glb")) {
        pushUploadLog(
          `GLB nalezen: ${path.basename(sourceModelPath)}. Převádím ho na GLTF package.`,
          "converting",
        );
      }

      gltfFilePath = await normalizeSourceToGltfPackage(sourceModelPath, tempDir);
    } else {
      pushUploadLog(
        `GLB soubor uložen na disk: ${uploadedSource.fileName}. Převádím ho na GLTF package.`,
        "converting",
      );
      gltfFilePath = await normalizeSourceToGltfPackage(
        uploadedSource.filePath,
        tempDir,
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
    const sourceDocument = await io.read(gltfFilePath);
    pushUploadLog(
      "Textury hotové. Generuji overview stages, detail tiles a klientský bootstrap manifest.",
      "saving",
    );
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.mkdir(outputDir, { recursive: true });
    const manifest = await buildStreamingPackage(
      modelName,
      sourceDocument,
      outputDir,
    );
    const metadata = await writeModelMetadata(modelName, outputDir, manifest);

    console.log("\n" + "=".repeat(60));
    console.log("HOTOVO!");
    console.log(`Model: ${modelName}`);
    console.log(`Entry Stage: ${metadata.entryStage}`);
    console.log(
      `Overview stages: ${manifest.overview.stages.map((stage) => stage.file).join(", ")}`,
    );
    console.log(`Detail tiles: ${manifest.tiles.length}`);
    console.log(`Velikost: ${metadata.sizeInMB} MB`);
    console.log("=".repeat(60) + "\n");

    await cleanup();
    pushUploadLog(
      `Hotovo: ${modelName}, overview stages ${manifest.overview.stages.length}, detail tiles ${manifest.tiles.length}.`,
      "done",
    );

    return jsonResponse({
      success: true,
      message: `Model ${modelName} byl úspěšně zpracován.`,
      fileName: metadata.entryFile,
      modelName,
      sizeInMB: metadata.sizeInMB,
      path: metadata.entryUrl,
      manifestUrl: metadata.manifestUrl,
      chunked: false,
      metadata,
    });
  } catch (err) {
    console.error("\nCHYBA při zpracování:", err);
    await cleanup();

    const clientErrors = new Set([
      "Nebyl nahrán žádný soubor modelu.",
      "Nahraný soubor musí mít příponu .zip nebo .glb.",
      "Nahraný soubor je příliš velký.",
      "Upload musí být multipart/form-data.",
      "Je povolen pouze jeden soubor modelu.",
      "Požadavek neobsahuje upload data.",
      "Nepodporovaný vstupní formát modelu.",
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

async function handleStreamManifest(modelName) {
  try {
    const manifestContent = await fsp.readFile(
      path.join(MODELS_DIR, modelName, "stream.manifest.json"),
      "utf8",
    );

    return new Response(manifestContent, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=31536000",
      },
    });
  } catch {
    return jsonResponse(
      {
        success: false,
        message: "Streaming manifest nenalezen.",
      },
      404,
    );
  }
}

async function handleStreamBootstrap(modelName) {
  try {
    const [metadataContent, manifestContent] = await Promise.all([
      fsp.readFile(path.join(METADATA_DIR, `${modelName}.json`), "utf8"),
      fsp.readFile(path.join(MODELS_DIR, modelName, "stream.manifest.json"), "utf8"),
    ]);

    const metadata = JSON.parse(metadataContent);
    const manifest = JSON.parse(manifestContent);

    return jsonResponse({
      success: true,
      modelName,
      bootstrap: {
        strategy: manifest.strategy,
        metadata,
        manifest,
      },
    });
  } catch {
    return jsonResponse(
      {
        success: false,
        message: "Streaming bootstrap nenalezen.",
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
      message: "Legacy chunk endpoint je vypnutý. Použij stream manifest a detail tiles z custom mesh streaming pipeline.",
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
        manifestUrl: metadata.manifestUrl,
        bootstrapUrl: metadata.bootstrapUrl,
        streamingStrategy: metadata.streamingStrategy,
        upgradeOrder: metadata.upgradeOrder || [],
        overviewStageCount: (metadata.overviewStages || []).length,
        tileCount: metadata.tileCount || 0,
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
        manifestUrl: metadata.manifestUrl,
        bootstrapUrl: metadata.bootstrapUrl,
        streamingStrategy: metadata.streamingStrategy,
        size: metadata.size,
        sizeInMB: metadata.sizeInMB,
        created: metadata.created || stats.birthtime,
        modified: stats.mtime,
        downloadUrl: `/download-model/${modelName}`,
        chunked: false,
        overviewStageCount: (metadata.overviewStages || []).length,
        tileCount: metadata.tileCount || 0,
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
      message: "Legacy chunking je vypnutý. Použij stream manifest, overview stages a detail tiles.",
      model: modelName,
    },
    400,
  );
}

async function handleCreateAllChunks() {
  return jsonResponse(
    {
      success: false,
      message: "Legacy chunking je vypnutý. Použij stream manifest, overview stages a detail tiles.",
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
      message: "Debug chunk endpoint je vypnutý, protože pipeline nyní používá overview stages a detail tiles.",
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
    segments[0] === "stream-bootstrap" &&
    segments.length === 2
  ) {
    return handleStreamBootstrap(decodeParam(segments[1]));
  }

  if (
    method === "GET" &&
    segments[0] === "stream-manifest" &&
    segments.length === 2
  ) {
    return handleStreamManifest(decodeParam(segments[1]));
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
let tlsStarted = false;

if (httpStarted) {
  console.log(`HTTP Server běží na http://0.0.0.0:${port}`);
  console.log("=".repeat(60));
}

try {
  tlsStarted = startServer(httpsPort, {
    tls: {
      key: fs.readFileSync(path.join(__dirname, "key.pem")),
      cert: fs.readFileSync(path.join(__dirname, "cert.pem")),
    },
  });

  if (tlsStarted) {
    console.log(`HTTPS Server běží na https://0.0.0.0:${httpsPort}`);
    console.log("=".repeat(60));
  }
} catch (err) {
  console.error("HTTPS server se nepodařilo spustit:", err.message);
}

if (httpStarted && !tlsStarted) {
  console.log("Server běží pouze na HTTP\n");
} else if (!httpStarted && tlsStarted) {
  console.log("Server běží pouze na HTTPS\n");
} else if (!httpStarted && !tlsStarted) {
  console.log("Server se nepodařilo spustit na HTTP ani HTTPS\n");
}
