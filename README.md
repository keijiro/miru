# miru

miru is a local media viewer for arranging images, videos, and audio in a 3D workspace. Use it in a desktop browser or with a WebXR headset.

## Run miru locally

You need a browser with WebGL 2, a supported Node.js version, and pnpm. Use Node.js 20.19 or later in the 20.x series, or Node.js 22.12 or later. Both `ffmpeg` and `ffprobe` must be on your `PATH` to generate thumbnails. [Node.js and pnpm version requirements](package.json)

- To install pnpm, run `npm install --global pnpm@12.21.0`.
- On macOS with Homebrew, run `brew install ffmpeg`.
- On Ubuntu or Debian under WSL2, run `sudo apt install ffmpeg`.

From the miru folder, install the dependencies, build the app, and start the local server.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm preview
```

Once the server starts, open miru in your browser. [http://localhost:5173](http://localhost:5173/)

On first launch, the workspace is empty. Press and hold in empty space for half a second to open a file browser window. Select one of the bundled samples to try miru.

## Library configuration

Set the media folder and thumbnail cache paths in `miru.config.json`. Relative paths are resolved from the folder containing the configuration file. Restart the server to apply changes. [Configuration file](miru.config.json)

```json
{
  "mediaRoot": "/mnt/d/Media",
  "thumbnailCache": "./.miru-cache"
}
```

The example uses a folder on the Windows D drive from WSL2. On macOS, you can use a path such as `/Users/yourname/Movies` or `/Volumes/Media`.

miru creates and caches image and video thumbnails as you browse. If you delete the cache folder, miru recreates it on the next access. Audio tiles show a music note.

The file browser lists JPEG, PNG, WebP, AVIF, BMP, and GIF images, as well as MP4, M4V, WebM, OGV, and MOV videos. Audio extensions include `.wav`, `.mp3`, `.m4a`, `.aac`, `.flac`, `.ogg`, `.oga`, `.opus`, and `.weba`. Playback depends on the codecs your browser supports.

## Desktop controls

| Action | How to |
| --- | --- |
| Open a window | Press and hold in empty space for half a second. A window outline and a circular progress indicator show where it will open. |
| Open a file | Select a file in the window's file browser. |
| Browse a folder | Select a folder tile. Use **Previous** and **Next** to change pages, or select the **Up** tile to open the parent folder. |
| Return to the file browser | Hover near the upper-left corner inside the media window to reveal **Back**, then click it. |
| Close a window | Click **Close** in the file browser. |
| Move a view | Hover near any edge and drag the bar that appears. |
| Adjust depth | Hold `Alt` and scroll over the view. |
| Resize a view | Hover near any corner and drag the handle that appears. |
| Show playback controls | Click inside an audio or video window. |
| Toggle the panorama background | Select the hemisphere icon in the video controls. |
| Pan cropped media | Drag the image or video along the cropped axis. |
| Loop a section of an audio or video file | Seek to each point and click `[ A` to set the start or `B ]` to set the end. |
| Fit all views on screen | Click **Fit all** at the top of the workspace. |

Hover near a move bar, resize handle, or **Back** to reveal the window's move and resize handles and its **Back** button, when available. The control under the pointer is highlighted.

Images and videos fill their windows while keeping their aspect ratio. Audio windows show the file name in the center. miru automatically saves the workspace layout, each window's current folder, and media settings. When you reopen miru, audio and video seek to their saved loop start. Newly opened audio and video files start unmuted. If the browser blocks autoplay, open the playback controls and press Play.

## VR controls

Connect your headset and select **VR mode** at the top of the app. The switch becomes available when the browser detects a supported immersive session. [WebXR session requirements](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API/Startup_and_shutdown)

If you run miru in WSL2 and use a Quest Pro with Virtual Desktop, open `http://localhost:5173` in Chrome on the same Windows host. Connect the headset to Virtual Desktop Streamer and make sure Chrome can access an OpenXR runtime. [WSL localhost access](https://learn.microsoft.com/en-us/windows/wsl/networking)

| Action | How to |
| --- | --- |
| Open a window | Aim at empty space and hold the trigger for half a second. The outline and progress indicator appear where you first aimed, about 1 m from the controller. |
| Browse and select | Aim at a tile or button and press the trigger. Aim inside the upper-left corner of a media window to reveal **Back** and return to its folder. Select **Close** in the file browser to close the window. |
| Move a window | Aim near an edge and grab the bar with the trigger. Tilt the thumbstick up or down while holding the trigger to adjust the distance. |
| Resize a window | Aim near a corner and grab its handle. The file browser adds rows or columns as space allows. |
| Pan cropped media | Hold the trigger on the image or video and drag along the cropped axis. |
| Show playback controls | Tap the trigger inside an audio or video window. |
| Exit VR | Select **Exit VR** in a file browser window or use the desktop **VR mode** switch. |

Windows turn to face the headset as you move. VR video playback requires WebXR media layers. Windows show a warning if the browser or runtime cannot provide a layer. If the session reaches its layer limit, affected windows show video when a layer becomes available.

## 180° video backgrounds

Open a 180° equirectangular video packed side by side with the left eye first. Select the hemisphere icon in the video controls to project it behind the workspace. In VR, the panorama centers on your heading when you enable it and stays in place as you look around. On desktop, it shows the left-eye image facing forward.

The background and its source window share playback, including pause, seek, and A/B loops. Enable the panorama in another video to switch sources. Select the hemisphere icon again or use **Back** in the source window to clear the background.

[Developer documentation](docs/DEVELOPMENT.md)
