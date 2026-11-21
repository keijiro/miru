# miru

miru is a local media viewer for arranging and viewing multiple images and videos in one space. It is designed for WebXR and has a desktop fallback that uses the same WebGL 2 workspace.

See the [UI design guidelines](UI-DESIGN.md) for the shared desktop and VR styles and interaction rules.

## Getting started

You need Node.js 20.19 or later in the 20.x series, or Node.js 22.12 or later. Use the pnpm version pinned in `package.json`. Both `ffmpeg` and `ffprobe` must be on your `PATH`.

- To install pnpm, run `npm install --global pnpm@12.21.0`.
- On macOS with Homebrew, run `brew install ffmpeg`.
- On Ubuntu or Debian under WSL2, run `sudo apt install ffmpeg`.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173/) in your browser. On first launch, the workspace is empty. Click empty space to open a file browser window. The default library contains the bundled samples. To run the production build locally, stop the development server, then run `pnpm build` followed by `pnpm preview`. The local Vite server serves the media files.

## Library configuration

Set the media folder and thumbnail cache paths in `miru.config.json`. Relative paths are resolved from the folder containing the configuration file. Restart the server to apply changes. [Configuration file](miru.config.json)

```json
{
  "mediaRoot": "/mnt/d/Media",
  "thumbnailCache": "./.miru-cache"
}
```

The example uses a folder on the Windows D drive from WSL2. On macOS, you can use a path such as `/Users/yourname/Movies` or `/Volumes/Media`. The file browser lists regular files and folders.

The file browser fits each thumbnail inside a square file tile. miru generates thumbnails on first access. Video thumbnails use a frame near the midpoint, with the first frame as a fallback. Thumbnails are regenerated when their source files change. If you delete the cache folder, miru recreates it on the next access.

The file browser lists JPEG, PNG, WebP, AVIF, BMP, and GIF images, as well as MP4, M4V, WebM, OGV, and MOV videos. Playback depends on the codecs your browser supports.

## Desktop controls

The desktop camera uses perspective projection. Windows turn to face it just as they face the headset in VR.

| Action | How to |
| --- | --- |
| Open a window | Click empty space in the workspace. |
| View a file | Select an image or video in the window's file browser. |
| Browse a folder | Select a folder tile. Use **Previous** and **Next** to change pages, or select the **Up** tile to open the parent folder. |
| Return to the file browser | Hover near the upper-left corner inside the media window to reveal **Back**, then click it. |
| Close a window | Click **Close** in the file browser. |
| Move a view | Hover near any edge and drag the bar that appears. |
| Adjust depth | Hold `Alt` and scroll over the view. |
| Resize a view | Hover near any corner and drag the handle that appears. |
| Show video controls | Click the video in the view. |
| Toggle the panorama background | Select **180° Panorama** in the video controls, or **Panorama** in a narrow window. |
| Pan cropped media | Drag the image or video along the cropped axis. |
| Loop a section of a video | Seek to each point and click `[ A` to set the start or `B ]` to set the end. |
| Fit all views on screen | Click **Fit all** at the top of the workspace. |

Hover near a move bar, resize handle, or **Back** to reveal all available controls of this kind on that window. The control under the pointer is highlighted.

Images and videos fill their views while keeping their aspect ratio. miru automatically saves open windows, their position, size, depth, current folder, and any active media settings. Each window remembers its own folder when you return to the file browser. On startup, videos seek to their loop start. When you first open a video, it starts muted so the browser can autoplay it.

Panorama projection expects a 180° equirectangular video packed side by side, with the left eye first. In VR, the panorama centers on your heading when you enable it and stays in place as you look around. On desktop, it shows the left-eye image facing forward. The background and source window share playback, including pause, seek, and loops. Enabling another video switches the background to that video. Use **Back** in the source window to clear the projection, or toggle **180° Panorama** off.

In Quest Browser VR, each visible video window uses a WebXR media layer. The workspace and an active panorama each use one layer as well. When the session reaches its layer limit, affected windows display a warning and show the video when a layer becomes available.

## WSL2 and Quest Pro

Start the server in WSL2 and open `http://localhost:5173` in Chrome on the same Windows host. Connect your Quest Pro to Virtual Desktop Streamer on Windows and make sure Chrome can access an OpenXR runtime. Turn on **VR mode** at the top of the app. The switch becomes available when Chrome detects a supported session. [WSL localhost access](https://learn.microsoft.com/en-us/windows/wsl/networking) · [WebXR session requirements](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API/Startup_and_shutdown)

In VR, aim at empty space and pull the controller trigger to open a file browser at the cursor, about 1 m from the controller. Windows turn to face the headset as you move. Aim near any edge and hold the trigger on the bar that appears to move the window. Tilt the thumbstick up or down while holding the trigger to adjust the distance. Aim near a corner and grab its handle to resize.

Use the trigger to select a file. Aim inside the upper-left corner of the media window to reveal **Back**, then select it to return to the file's folder. Select **Close** in the file browser to close the window. Hold the trigger on an image or video and drag along the cropped axis to pan. Tap the trigger on a video to show its playback controls. Text, buttons, and thumbnails keep their size as you resize. A wider file browser fits more columns, and a taller one fits more rows. Select **Exit VR** in a file browser window or use the desktop switch to end the session.

WebXR support is implemented. The Quest Pro, Virtual Desktop, and Windows Chrome setup still needs hardware testing.

## Sample media

The bundled samples are landscape images generated with the built-in ImageGen tool. The MP4 videos apply a slow zoom to the still images.

| File | Prompt summary |
| --- | --- |
| `samples/Aurora Over Lofoten.mp4` | A night photograph of an emerald aurora over a Lofoten fjord, lighting the mountains and reflecting on the water. |
| `samples/Icelandic Coast.mp4`, `samples/Field Notes/Reynisfjara.jpg` | An aerial photograph of turquoise waves breaking against a black volcanic beach and basalt sea stacks in Iceland. |
| `samples/Namib Dunes.jpg` | A landscape photograph of curved red dunes and deep shadows in the Namib Desert at dusk. |
| `samples/The Dolomites.jpg` | A landscape photograph of snow-dusted Dolomite peaks under a blue sky, with an alpine meadow lit from the side. |

<details>
<summary>Exact ImageGen prompts</summary>

**Aurora Over Lofoten**

> Generate a single full-bleed 16:9 landscape photograph, realistic fine-art night photography from the shore of a fjord in Lofoten, Norway. Huge flowing vivid green aurora curtains across a midnight indigo starry sky, a low jagged mountain silhouette in the bottom quarter, a calm dark teal lake reflecting the green aurora. Elegant, natural, high-end photographic detail, sharp, subtly grainy, immersive. Strong green arcs and a sense of scale. No people or human structures, no text, no collage, no borders, no graphic elements. Usable desktop media viewer sample.

**Icelandic Coast / Reynisfjara**

> Generate a single landscape 16:9 realistic cinematic aerial photograph of dark rugged basalt at the Reynisfjara Iceland coastline, foamy turquoise surf sweeping diagonally onto the black volcanic beach, cliffs emerging from the dark water, early morning blue gray mist with detailed ocean currents. Rich ocean blues and atmospheric highlights, high-end documentary photo. No words, no people, no borders. Full-bleed desktop media viewer sample.

**Namib Dunes**

> Generate a single landscape 16:9 real fine art photograph of sinuous amber red Namib Desert sand dunes in the last light of the day, simple wave-like ripples in the sand, deep burgundy shadows and golden crests, empty and pure with no people, very pale violet hazy sky along the upper quarter. Minimal cinematic terrestrial landscape photo, fine film texture. No words, no people, no borders. Full-bleed desktop media viewer sample.

**The Dolomites**

> Generate a single landscape 16:9 realistic color photograph of the Italian Dolomites, three striking sharp snow-dusted rocky pinnacles across the central horizon, rolling golden olive alpine meadow and warm late-afternoon light in the foreground, soft scattered clouds in clear pale azure sky. Golden sunlit ochre green slope contrasted with blue gray mountains. Fine art travel photography, natural true colors with subtly soft contrast and a distinct low horizon. Full bleed landscape media-viewer sample, no words no borders no people no graphic elements.

</details>
