# miru UI Design Guidelines

Use the same visual language for the desktop workspace and immersive VR. Give media the available space and use a neutral palette, lightweight type, and clear interaction feedback for the controls around it.

## Palette and typography

| Role | Color | Use |
| --- | --- | --- |
| Workspace | `#161616` | Desktop background, scene background, and fog |
| Surface | `#232323` | File browser, playback controls, and notices |
| Control | `#292929` | Resting buttons and cards |
| Hover | `#414141` | Buttons and cards under a pointer |
| Active | `#3a3a3a` | Selected playback controls and the Back overlay |
| Text | `#eeeeee` | Labels and text that needs attention |
| Muted text | `#bdbdbd` | Paths, playback time, and secondary messages |
| Accent | `#dedede` | Focus indicator, checked VR switch, and scene pointers and handles |
| Outline | `#585858` | Desktop control and notice borders, and the resting seek track |

Use the system sans-serif stack at weight 200, with Hiragino Sans and Yu Gothic UI as Japanese fallbacks. Set hierarchy with size, spacing, and color. Use short action labels and truncate long paths and file names with an ellipsis when the available space runs out.

## Layout and borders

Let the desktop canvas fill the viewport. Float **Fit all** and **VR mode** as separate controls in the upper-right corner so the space around and between them still belongs to the workspace. Place notices in the lower-right corner and center startup or renderer errors.

Use flat fills and spacing to define scene panels, cards, and ordinary in-window buttons. Separate the file browser header from the grid with spacing. Place the path on the left and **Close** on the right. In VR, place **Exit VR** beside **Close**.

Use a 1 CSS pixel outline for standalone desktop controls and notices, and a 1 CSS pixel accent outline for keyboard focus. Use a 5-pixel corner radius for buttons in each renderer's coordinate system. Keep strokes thin on icons, the seek control, and move and resize handles.

Use a square card grid for files and folders. Include **Up** as the first card inside a subfolder and count it as part of the grid when paginating. Keep text and cards at a consistent size in the scene as the window is resized. Add rows or columns as space allows and show page controls when there is another page to reach.

## Interaction states

Brighten a button or card with the hover fill when the mouse or VR pointer targets it. Use a pointer cursor for desktop actions, and grab or resize cursors for window edges and corners. Keep hit areas usable independently of how thin the visible strokes are.

Give persistent states their own cue. The checked **VR mode** switch uses a light fill with dark text. Active playback options use a thin, higher-contrast outline that remains visible on hover. Disabled desktop buttons use subdued text and borders.

Reveal move and resize handles when a pointer approaches an edge or corner. In a media window, include the borderless **Back** button in this group and reveal the group when a pointer targets the Back area. Keep targeted affordances at full opacity and draw the other revealed affordances at 25% opacity.

## Implementation

Define shared colors, font settings, and the base control radius in one place. The app exposes these values as CSS custom properties for the desktop overlay, and the scene imports the same values for canvas textures and WebGL. [Shared styles](src/ui-style.ts) · [Desktop styles](src/style.css)

Reuse the scene panel's button and hover behavior for new in-window actions so mouse and VR input give the same feedback. [Scene panels](src/scene-window.ts)
