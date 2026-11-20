# miru

miru is a local media viewer for arranging and viewing multiple images and videos in one space. The desktop and WebXR modes share the same workspace.

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

miru generates thumbnails on first access. Video thumbnails use a frame near the midpoint, with the first frame as a fallback. Thumbnails are regenerated when their source files change. If you delete the cache folder, miru recreates it on the next access.

The file browser lists JPEG, PNG, WebP, AVIF, BMP, and GIF images, as well as MP4, M4V, WebM, OGV, and MOV videos. Playback depends on the codecs your browser supports.

## Desktop controls

| Action | How to |
| --- | --- |
| Open a window | Click empty space in the workspace. |
| View a file | Select an image or video in the window's file browser. |
| Return to the file browser | Click the back arrow in the window's title bar. |
| Move a view | Drag its title bar. |
| Adjust depth | Hold `Alt` and scroll over the view. |
| Resize a view | Drag an edge to change one dimension or a corner to change both. |
| Show view controls | Click the image or video in the view. |
| Pan zoomed media | Zoom in, then drag the image or video. |
| Loop a section of a video | Seek to each point and click `[ A` to set the start or `B ]` to set the end. |
| Fit all views on screen | Click **Fit all** at the top of the workspace. |

miru automatically saves open windows, their position, size, depth, VR orientation, current folder, and any active media settings. Each window remembers its own folder when you return to the file browser. On startup, videos seek to their loop start. When you first open a video, it starts muted so the browser can autoplay it.

## WSL2 and Quest Pro

Start the server in WSL2 and open `http://localhost:5173` in Chrome on the same Windows host. Connect your Quest Pro to Virtual Desktop Streamer on Windows and make sure Chrome can access an OpenXR runtime. Turn on **VR mode** at the top of the app. The switch becomes available when Chrome detects a supported session. [WSL localhost access](https://learn.microsoft.com/en-us/windows/wsl/networking) · [WebXR session requirements](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API/Startup_and_shutdown)

In VR, aim at empty space and pull the controller trigger to open a file browser at the cursor, about 1 m from the controller. Use the trigger to select a file, then select **Back** in the title bar to return to its folder. Drag a side or corner to resize the window. Text, buttons, and thumbnails keep their size. A wider file browser fits more columns, and a taller one fits more rows. To move and rotate a window together, aim at it and hold the squeeze (grip) button. Move and turn the controller to position the window, or tilt the thumbstick up or down while holding it to adjust the distance. Release the button to place the window. Select **Exit VR** in a file browser window or use the desktop switch to end the session.

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
