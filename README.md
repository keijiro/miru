# miru

miru is a local media viewer built for WebXR headsets. Arrange images, videos, and audio in a 3D workspace.

## Run miru locally

You’ll need a WebGL 2 browser, Node.js, and pnpm. Video thumbnails use `ffmpeg` and `ffprobe` from your `PATH`. [Node.js and pnpm versions](package.json)

From the repository root, run the following commands.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm preview
```

The default library includes sample media. Open [http://localhost:5173](http://localhost:5173/).

## Library configuration

To use your own media folder, set `mediaRoot` and restart the server. [miru.config.json](miru.config.json)

A directory symlink directly under `mediaRoot` can point outside the library if you list its name and absolute target in `externalLinks`. For example, if `/var/www/html/e` points to `/mnt/e`, use this configuration and restart the server:

```json
{
  "mediaRoot": "/var/www/html",
  "thumbnailCache": "./.miru-cache",
  "externalLinks": {
    "e": "/mnt/e"
  }
}
```

Miru shows `e` when it resolves to the configured directory. Paths opened through `e` must resolve within that directory.

## VR controls

Connect your WebXR headset and select **VR mode**. Video playback in VR requires WebXR media layers.

- Aim at empty space and hold the trigger for half a second to open a file browser.
- Drag a window’s edge with the trigger to move it or a corner to resize it. Move the thumbstick up or down while dragging an edge to adjust distance.
- Point at the upper-left corner of a media window to reveal **Back**. Tap the trigger inside an audio or video window to show playback controls.

## 180° video backgrounds

Open a side-by-side 180° equirectangular video (left eye first) and select the hemisphere icon in the video controls to use it as the background.
