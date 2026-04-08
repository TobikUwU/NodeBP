Requirements:
- Bun 1.3+
- OpenSSL

Run:

```bash
bun install
bun run start
```

Development with reload:

```bash
bun run dev
```

Optional environment variables:
- `PORT` for the HTTP server, default `3000`
- `HTTPS_PORT` for the TLS server, default `3443`

Notes:
- The backend runs on Bun with ESM modules and a Bun-native `Bun.serve` server.
- Uploads are streamed to disk through multipart parsing instead of buffering the whole payload in memory.
- The upload body limit is currently `5 GB`.
- Accepted ingest formats are a `ZIP` package containing `.gltf` or `.glb`, or a direct `.glb` upload.
- The processing pipeline converts the source package into a custom hybrid mesh streaming bundle for a mobile Filament client.
- Output contains overview stages (`overview/*.glb`), detail tiles (`tiles/*.glb`), and a `stream.manifest.json`.
- The current preset is mobile-first: more aggressive mesh simplification and smaller texture targets (`1024` / `512`) are used by default.
- Each processed model gets a `stream.manifest.json` describing `hybrid_overview_tiles` loading order plus a `/stream-bootstrap/:modelName` bootstrap endpoint for the client.
- The current delivery model is custom `overview + detail tiles` over regular HTTP fetches. It is closer to video-like progressive refinement than plain whole-model downloads, but it is not USD streaming and not the full Cesium `3D Tiles` standard.
- `USD/USDZ` ingest is not implemented in this repo yet. That requires an external conversion toolchain such as Pixar USD tools or Blender running headless.
- HTTPS uses `key.pem` and `cert.pem`. If they are missing, the server generates self-signed certificates with OpenSSL on startup.
