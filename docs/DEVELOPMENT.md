# Developing miru

## Local development

Install the prerequisites listed in the README, then run these commands from the repository root. [Local setup](../README.md#run-miru-locally)

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The development server and the build preview both use `http://localhost:5173`. Stop one before starting the other. [Vite configuration](../vite.config.ts)

| Command | Purpose |
| --- | --- |
| `pnpm check` | Run the TypeScript checker. |
| `pnpm build` | Run the type check and build the client into `dist/`. |
| `pnpm preview` | Run the built client locally with the media library API. |

## Workspace and media library

Desktop and VR share a Three.js scene rendered with WebGL 2. The desktop uses a perspective camera, and windows face either the desktop camera or the headset. The workspace keeps per-library layouts in browser storage. [Scene](../src/scene.ts) · [Workspace state](../src/workspace.ts) · [UI design guidelines](UI-DESIGN.md)

A Vite plugin serves directory listings, media files, and cached thumbnails in both local server modes. It generates image and video thumbnails on first access and regenerates them when the source changes. For videos, `ffprobe` supplies the duration and `ffmpeg` extracts a frame near the midpoint, falling back to the first frame if extraction fails. [Media library plugin](../server/media-library.ts) · [Sample media and generation prompts](SAMPLE-MEDIA.md)

## WebXR video

The app requests the WebXR `layers` feature when the browser exposes `XRMediaBinding`. The local Three.js patch selects an XR projection layer only when the session enables composition layers. [Session startup](../src/main.ts) · [Three.js patch](../patches/three@0.187.0.patch)

The workspace projection, each visible native video window, and the active native panorama each consume one composition layer. Video windows use quad media layers, and the panorama uses an equirectangular media layer. Videos fall back to the WebGL scene when media layers are unavailable or the session runs out of layers. The app reallocates layers as they become available. The WebGL panorama maps each half of a side-by-side video to its corresponding eye in VR. [Video layer allocation](../src/xr-video-layers.ts) · [Panorama rendering](../src/panorama.ts)
