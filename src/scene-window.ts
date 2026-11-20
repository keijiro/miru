import {
  BackSide, CanvasTexture, DoubleSide, Group, Mesh, MeshBasicMaterial, Plane, PlaneGeometry,
  Quaternion, SRGBColorSpace, Texture, Vector3, VideoTexture, type Intersection, type Ray,
} from 'three'
import { mediaUrl, type DirectoryListing, type LibraryEntry } from './media-api'
import {
  clamp, formatTime, limits, mediaOverflow, panned, resizedDimensions, viewHeight, windowDefaults,
  type MediaRuntime, type View, type Workspace,
} from './workspace'

const ink = '#eeeeee'
const muted = '#b0b0b0'
export const accent = '#dedede'
const surface = '#232323'
const line = '#484848'
const uiPixelsPerMetre = 720 / windowDefaults.width
const metres = (pixels: number) => pixels / uiPixelsPerMetre
const gripThickness = metres(7)
const gripOffset = metres(16)
const gripInset = metres(13)
const cornerLength = metres(37)
const cornerHandleLength = cornerLength + metres(8)
export const windowGripReach = metres(42)
const chromeGap = windowGripReach + metres(4)
const backWidth = 114
const backHeight = 52
const backMargin = metres(24)
const backReach = metres(5)
const dimOpacity = 0.38
const gripDirections = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
  [-1, -1], [1, -1], [-1, 1], [1, 1],
] as const

const browserMargin = 30
const cardSize = 186
const columnGap = 14
const rowGap = 10
const gridTop = 105
const compactHeaderExtra = 48
const browserFooter = 74
const browserMinimum = {
  minWidth: metres(383),
  minHeight: metres(gridTop + compactHeaderExtra + cardSize + browserFooter),
}

const seekX = 25
const seekY = 22
const compactControlsWidth = 570

export type Face = Mesh<PlaneGeometry, MeshBasicMaterial>
export type Hit = Intersection<Face>
export interface Grab {
  update(ray: Ray, depth: number): void
  finish?(commit: boolean): void
}
interface Grip {
  x: -1 | 0 | 1
  y: -1 | 0 | 1
  horizontal?: Face
  vertical?: Face
}
type Affordance = Grip | 'back'
export type WindowPart = Affordance | 'body' | 'controls'
type Action = () => void
interface ButtonArea {
  x: number
  y: number
  w: number
  h: number
  run: Action
}

function face(group: Group, color: string | number, geometry = new PlaneGeometry()) {
  const mesh = new Mesh(geometry, new MeshBasicMaterial({ color, toneMapped: false }))
  group.add(mesh)
  return mesh
}

function gripFace(group: Group) {
  const mesh = face(group, accent)
  mesh.material.transparent = true
  mesh.material.depthWrite = false
  mesh.visible = false
  return mesh
}

function place(mesh: Face, width: number, height: number, y: number) {
  mesh.scale.set(width, height, 1)
  mesh.position.set(0, y, 0)
}

function surround(group: Group, color: string) {
  const geometry = new PlaneGeometry(1, 1, 3, 3)
  const indices = Array.from(geometry.index!.array)
  indices.splice(4 * 6, 6) // Remove the centre quad to leave a rectangular opening.
  geometry.setIndex(indices)
  return face(group, color, geometry)
}

function cutout(mesh: Face, width: number, height: number, x: number, y: number) {
  const left = (x - mesh.position.x - width / 2) / mesh.scale.x
  const right = (x - mesh.position.x + width / 2) / mesh.scale.x
  const top = (y - mesh.position.y + height / 2) / mesh.scale.y
  const bottom = (y - mesh.position.y - height / 2) / mesh.scale.y
  const columns = [-0.5, left, right, 0.5]
  const rows = [0.5, top, bottom, -0.5]
  const positions = mesh.geometry.getAttribute('position')
  for (const [row, py] of rows.entries()) {
    for (const [column, px] of columns.entries()) positions.setXY(row * columns.length + column, px, py)
  }
  positions.needsUpdate = true
}

class Panel {
  #canvas = document.createElement('canvas')
  #context = this.#canvas.getContext('2d')!
  #texture?: CanvasTexture
  #buttons: ButtonArea[] = []
  readonly mesh: Face
  width = 0
  height = 0

  constructor(group: Group, private readonly transparent = false) {
    this.mesh = face(group, 0xffffff)
    if (transparent) {
      this.mesh.material.transparent = true
      this.mesh.material.depthWrite = false
    }
  }

  layout(width: number, height: number, y: number) {
    this.width = Math.round(width * uiPixelsPerMetre)
    this.height = Math.round(height * uiPixelsPerMetre)
    place(this.mesh, width, height, y)
  }

  paint(draw: (ctx: CanvasRenderingContext2D) => void) {
    // Keep logical UI sizes independent of the raster resolution. Allocating in steps
    // avoids replacing the GPU texture for every pixel of a resize.
    const resolution = (size: number) => Math.min(2048, Math.ceil(size / 64) * 64)
    const width = resolution(this.width)
    const height = resolution(this.height)
    if (!this.#texture || width !== this.#canvas.width || height !== this.#canvas.height) {
      this.#texture?.dispose()
      this.#canvas.width = width
      this.#canvas.height = height
      this.#texture = new CanvasTexture(this.#canvas)
      this.#texture.colorSpace = SRGBColorSpace
      this.mesh.material.map = this.#texture
      this.mesh.material.needsUpdate = true
    }
    const ctx = this.#context
    ctx.setTransform(width / this.width, 0, 0, height / this.height, 0, 0)
    if (this.transparent) ctx.clearRect(0, 0, this.width, this.height)
    else {
      ctx.fillStyle = surface
      ctx.fillRect(0, 0, this.width, this.height)
    }
    this.#buttons = []
    draw(ctx)
    this.#texture.needsUpdate = true
  }

  button(label: string, x: number, y: number, w: number, h: number, run: Action, active = false) {
    chip(this.#context, label, x, y, w, h, active)
    this.action(x, y, w, h, run)
  }

  action(x: number, y: number, w: number, h: number, run: Action) {
    this.#buttons.push({ x, y, w, h, run })
  }

  press(x: number, y: number) {
    const button = this.#buttons.find(({ x: left, y: top, w, h }) => x >= left && x <= left + w && y >= top && y <= top + h)
    button?.run()
    return Boolean(button)
  }

  dispose() { this.#texture?.dispose() }
}

function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, radius = 0) {
  ctx.fillStyle = color
  if (radius) {
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, radius)
    ctx.fill()
  } else {
    ctx.fillRect(x, y, w, h)
  }
}

function text(
  ctx: CanvasRenderingContext2D, value: string, x: number, y: number,
  size: number, color = ink, weight = 500, max = Infinity,
) {
  ctx.font = `${weight} ${size}px system-ui, sans-serif`
  ctx.fillStyle = color
  ctx.textBaseline = 'middle'
  if (ctx.measureText(value).width > max) {
    const letters = Array.from(value)
    while (letters.length && ctx.measureText(letters.join('') + '…').width > max) letters.pop()
    value = letters.join('') + '…'
  }
  ctx.fillText(value, x, y)
}

function chip(
  ctx: CanvasRenderingContext2D, label: string, x: number, y: number, w: number, h: number,
  active = false, fontSize = 22,
) {
  rect(ctx, x, y, w, h, active ? '#575757' : '#373737', 8)
  ctx.textAlign = 'center'
  text(ctx, label, x + w / 2, y + h / 2 + 1, fontSize, ink, 620, w - 8)
  ctx.textAlign = 'left'
}

function slider(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, progress: number) {
  const position = x + w * clamp(progress, 0, 1)
  rect(ctx, x, y - 3, w, 6, line, 3)
  rect(ctx, x, y - 3, position - x, 6, accent, 3)
  ctx.fillStyle = accent
  ctx.beginPath()
  ctx.arc(position, y, 8, 0, Math.PI * 2)
  ctx.fill()
}

function cropMedia(mesh: Face, view: View) {
  const { x, y } = mediaOverflow(view)
  const cropX = x / (view.width + x)
  const cropY = y / (viewHeight(view) + y)
  const left = (1 - view.panX) * cropX / 2
  const right = 1 - (1 + view.panX) * cropX / 2
  const bottom = (1 - view.panY) * cropY / 2
  const top = 1 - (1 + view.panY) * cropY / 2
  const uv = mesh.geometry.getAttribute('uv')
  uv.setXY(0, left, top)
  uv.setXY(1, right, top)
  uv.setXY(2, left, bottom)
  uv.setXY(3, right, bottom)
  uv.needsUpdate = true
}

function panelPlane(point: Vector3, orientation: Quaternion) {
  const normal = new Vector3(0, 0, 1).applyQuaternion(orientation)
  return new Plane().setFromNormalAndCoplanarPoint(normal, point)
}

function xyDrag(
  point: Vector3, orientation: Quaternion, apply: (dx: number, dy: number) => void,
  threshold = 0.001, finish?: (moved: boolean) => void,
): Grab {
  const plane = panelPlane(point, orientation)
  const inverse = orientation.clone().invert()
  const intersect = new Vector3()
  let moved = false
  return {
    update(ray) {
      if (!ray.intersectPlane(plane, intersect)) return
      const { x: dx, y: dy } = intersect.sub(point).applyQuaternion(inverse)
      moved ||= Math.hypot(dx, dy) >= threshold
      if (moved) apply(dx, dy)
    },
    finish(commit) { if (commit) finish?.(moved) },
  }
}

export class SceneWindow {
  readonly group = new Group()
  #view: View
  #back = face(this.group, surface)
  #screen = surround(this.group, surface)
  #media = face(this.group, 0xffffff)
  #hitbox = face(this.group, 0xffffff)
  #controls = new Panel(this.group)
  #message = new Panel(this.group)
  #returnButton = new Panel(this.group, true)
  #grips: Grip[] = gripDirections.map(([x, y]) => ({
    x, y,
    horizontal: y ? gripFace(this.group) : undefined,
    vertical: x ? gripFace(this.group) : undefined,
  }))
  #highlighted = new Set<Affordance>()
  readonly targets = [this.#hitbox, this.#controls.mesh]
  #browser?: FileBrowser
  #runtime?: MediaRuntime
  #texture?: Texture
  #immersive = true
  #lastControls = ''
  #lastMessage = ''

  constructor(private readonly workspace: Workspace, view: View, private readonly end: Action) {
    this.#view = view
    this.#hitbox.material.visible = false
    this.#message.mesh.visible = false
    this.#media.visible = false
    // A controller can reach the back of a window even when it faces the headset.
    this.#back.material.side = BackSide
    this.#hitbox.material.side = DoubleSide
    const button = this.#returnButton.mesh
    button.visible = false
    // Draw over the coplanar media without moving the button's hit area forward.
    button.material.polygonOffset = true
    button.material.polygonOffsetFactor = -1
    button.material.polygonOffsetUnits = -1
    this.#layout()
    this.#returnButton.paint(ctx => chip(ctx, '← Back', 0, 0, backWidth, backHeight, true, 26))
  }

  get id() { return this.#view.id }
  get runtime() { return this.#runtime }

  get radius() {
    const { width, height } = this.#size
    const bottom = this.#controls.mesh.visible
      ? -this.#controls.mesh.position.y + this.#controls.mesh.scale.y / 2
      : height / 2 + windowGripReach
    return Math.hypot(width / 2 + windowGripReach, bottom)
  }

  get #size() {
    const { width, media } = this.#view
    const height = viewHeight(this.#view)
    return media ? { width, height } : {
      width: Math.max(width, browserMinimum.minWidth),
      height: Math.max(height, browserMinimum.minHeight),
    }
  }

  sync(view: View, runtime: MediaRuntime | undefined, immersive: boolean) {
    const runtimeChanged = runtime !== this.#runtime
    const createBrowser = !runtime && !this.#browser
    if (createBrowser) this.#browser = new FileBrowser(this.group, this.workspace, view.id, this.end)
    if (runtimeChanged) {
      this.#runtime = runtime
      this.#texture?.dispose()
      this.#texture = undefined
      this.#media.material.map = null
      this.#lastControls = ''
    }
    const relayout = view !== this.#view || runtimeChanged || createBrowser || immersive !== this.#immersive
    if (relayout) {
      this.#view = view
      this.#immersive = immersive
      this.#layout()
    }
    if (this.#browser) this.#browser.mesh.visible = !runtime
    if (!runtime) {
      this.#screen.visible = false
      this.#media.visible = false
      this.#message.mesh.visible = false
      this.#browser?.sync(view.browser, immersive)
      return
    }
    const media = runtime.snapshot()
    if (media.ready && !this.#texture) {
      const texture = runtime.video ? new VideoTexture(runtime.video) : new Texture(runtime.element)
      texture.colorSpace = SRGBColorSpace
      texture.needsUpdate = true
      this.#texture = texture
      this.#media.material.map = texture
      this.#media.material.needsUpdate = true
    }
    const mediaVisible = Boolean(this.#texture) && !media.error
    this.#screen.visible = !mediaVisible
    this.#media.visible = mediaVisible
    this.#message.mesh.visible = !mediaVisible
    const message = media.error ? 'Could not display the file' : 'Loading…'
    const messageWidth = this.#message.width
    const messageSignature = `${messageWidth}:${message}`
    if (this.#message.mesh.visible && messageSignature !== this.#lastMessage) {
      this.#lastMessage = messageSignature
      this.#message.paint(ctx => {
        ctx.textAlign = 'center'
        text(ctx, message, messageWidth / 2, 33, 23, muted, 500, messageWidth - 16)
        ctx.textAlign = 'left'
      })
    }
    if (this.#controls.mesh.visible) this.#paintControls(runtime)
  }

  part(hit: Hit): WindowPart | undefined {
    if (hit.object === this.#controls.mesh) return 'controls'
    const uv = hit.uv!
    const { width, height } = this.#size
    const x = (uv.x - 0.5) * this.#hitbox.scale.x
    const y = (uv.y - 0.5) * this.#hitbox.scale.y
    const button = this.#returnButton.mesh
    if (this.#view.media && Math.abs(x - button.position.x) <= button.scale.x / 2 + backReach
      && Math.abs(y - button.position.y) <= button.scale.y / 2 + backReach) return 'back'

    const dx = Math.abs(x) - width / 2
    const dy = Math.abs(y) - height / 2
    const nearX = dx >= -gripInset
    const nearY = dy >= -gripInset
    if (!nearX && !nearY) return 'body'
    const xSide = nearX || dx >= -cornerLength ? Math.sign(x) : 0
    const ySide = nearY || dy >= -cornerLength ? Math.sign(y) : 0
    return this.#grips.find(grip => grip.x === xSide && grip.y === ySide)
  }

  highlight(part: WindowPart) {
    if (part === 'back' || typeof part !== 'string') this.#highlighted.add(part)
  }

  updateAffordances() {
    const visible = this.#highlighted.size > 0
    for (const grip of this.#grips) {
      const opacity = this.#highlighted.has(grip) ? 1 : dimOpacity
      if (grip.horizontal) {
        grip.horizontal.visible = visible
        grip.horizontal.material.opacity = opacity
      }
      if (grip.vertical) {
        grip.vertical.visible = visible
        grip.vertical.material.opacity = opacity
      }
    }
    const button = this.#returnButton.mesh
    button.visible = visible && Boolean(this.#view.media)
    button.material.opacity = this.#highlighted.has('back') ? 1 : dimOpacity
    this.#highlighted.clear()
  }

  press(part: WindowPart, hit: Hit, ray: Ray) {
    this.#focus()
    if (typeof part !== 'string') {
      return part.x && part.y ? this.#resize(hit, part.x, part.y) : this.#move(hit)
    }
    if (part === 'body') return this.#body(hit)
    if (part === 'controls') return this.#control(hit, ray)
    if (part === 'back') this.workspace.back(this.id)
  }

  dispose() {
    this.group.removeFromParent()
    this.#texture?.dispose()
    this.#browser?.dispose()
    for (const panel of [this.#returnButton, this.#controls, this.#message]) panel.dispose()
    for (const child of this.group.children as Face[]) {
      child.geometry.dispose()
      child.material.dispose()
    }
  }

  #layout() {
    const view = this.#view
    const { width, height } = this.#size
    const compactControls = Math.round(width * uiPixelsPerMetre) < compactControlsWidth
    const controls = metres(compactControls ? 146 : 96)
    this.group.position.set(view.x, view.y, view.z)
    place(this.#back, width, height, 0)
    place(this.#screen, width, height, 0)
    if (view.media) {
      place(this.#media, width, height, 0)
      cropMedia(this.#media, view)
    }
    this.#browser?.layout(width, height)
    place(this.#hitbox, width + windowGripReach * 2, height + windowGripReach * 2, 0)
    this.#returnButton.layout(metres(backWidth), metres(backHeight), height / 2 - backMargin - metres(backHeight) / 2)
    this.#returnButton.mesh.position.x = -width / 2 + backMargin + metres(backWidth) / 2
    this.#message.layout(Math.min(width, metres(450)), metres(65), 0)
    cutout(this.#screen, this.#message.mesh.scale.x, this.#message.mesh.scale.y, 0, 0)
    this.#controls.layout(width, controls, -(height + controls) / 2 - chromeGap)
    this.#controls.mesh.visible = Boolean(this.#runtime?.video) && view.controls
    for (const { x, y, horizontal, vertical } of this.#grips) {
      if (horizontal) {
        const length = x ? cornerHandleLength : width - 2 * cornerLength
        place(horizontal, length, gripThickness, y * (height / 2 + gripOffset))
        horizontal.position.x = x * (width / 2 + gripOffset - (length - gripThickness) / 2)
      }
      if (vertical) {
        const length = y ? cornerHandleLength - gripThickness : height - 2 * cornerLength
        // The corner's two strokes meet without overlapping when translucent.
        place(vertical, gripThickness, length, y * (height / 2 + gripOffset - (length + gripThickness) / 2))
        vertical.position.x = x * (width / 2 + gripOffset)
      }
    }
  }

  #paintControls(runtime: MediaRuntime) {
    const view = this.#view
    const media = runtime.snapshot()
    const panel = this.#controls
    const { width } = panel
    const signature = JSON.stringify([
      width, view.loopStart, view.loopEnd, view.muted, media.duration, Math.floor(media.time * 10), media.playing,
    ])
    if (signature === this.#lastControls) return
    this.#lastControls = signature
    panel.paint(ctx => {
      const seekWidth = width - 2 * seekX
      const fraction = (t: number) => media.duration ? t / media.duration : 0
      slider(ctx, seekX, seekY, seekWidth, fraction(media.time))
      if (view.loopStart) rect(ctx, seekX + seekWidth * fraction(view.loopStart), seekY - 8, 3, 16, ink)
      if (view.loopEnd !== null) rect(ctx, seekX + seekWidth * fraction(view.loopEnd), seekY - 8, 3, 16, ink)
      const compact = width < compactControlsWidth
      const gap = compact ? 6 : 15
      const muteX = width - (compact ? 6 : 25) - 130
      const endX = muteX - gap - 77
      const startX = endX - gap - 77
      const loopY = compact ? 91 : 40
      panel.button(media.playing ? 'Ⅱ' : '▶', 19, 40, 64, 43, () => runtime.togglePlayback())
      text(ctx, `${formatTime(media.time)} / ${formatTime(media.duration)}`, 98, 62, 21, muted, 550,
        (compact ? width - 16 : startX - 12) - 98)
      panel.button('[ A', startX, loopY, 77, 43, () => runtime.mark('start'), view.loopStart > 0)
      panel.button('B ]', endX, loopY, 77, 43, () => runtime.mark('end'), view.loopEnd !== null)
      panel.button(view.muted ? 'Unmute' : 'Mute', muteX, loopY, 130, 43,
        () => this.workspace.patch(view.id, { muted: !view.muted }), !view.muted)
    })
  }

  #focus() { this.workspace.select(this.#view.id) }

  #move(hit: Hit) {
    if (this.#immersive) return this.#moveInVr(hit)
    // Keep mouse drags at the same depth as the initial grab.
    const { id, x, y } = this.#view
    return xyDrag(hit.point, new Quaternion(), (dx, dy) => {
      this.workspace.patch(id, { x: clamp(x + dx, -100, 100), y: clamp(y + dy, -100, 100) })
    })
  }

  #moveInVr(hit: Hit): Grab {
    const previousPosition = this.group.position.clone()
    const offset = previousPosition.clone().sub(hit.point)
    const position = new Vector3()
    let distance = hit.distance
    return {
      update: (ray, depth) => {
        if (depth) distance = clamp(distance + depth, limits.near, limits.far)
        ray.at(distance, position).add(offset)
        position.set(clamp(position.x, -100, 100), clamp(position.y, -100, 100), clamp(position.z, -limits.far, limits.far))
        if (previousPosition.distanceToSquared(position) < 1e-8) return
        previousPosition.copy(position)
        this.workspace.patch(this.id, { x: position.x, y: position.y, z: position.z })
      },
    }
  }

  #resize(hit: Hit, x: number, y: number) {
    const browser = !this.#view.media ? this.#browser : undefined
    const view = browser ? { ...this.#view, ...this.#size } : this.#view
    const orientation = this.group.quaternion.clone()
    const height = viewHeight(view)
    const offset = new Vector3()
    let lastWidth = view.width
    let lastHeight = height
    browser?.startResize()
    return xyDrag(hit.point, orientation, (dx, dy) => {
      const size = resizedDimensions(view, dx, dy, x, y, browser ? browserMinimum : limits)
      const nextHeight = size.height ?? height
      if (size.width === lastWidth && nextHeight === lastHeight) return
      lastWidth = size.width
      lastHeight = nextHeight
      offset.set(x * (size.width - view.width) / 2, y * (nextHeight - height) / 2, 0)
        .applyQuaternion(orientation)
      this.workspace.patch(view.id, {
        ...size,
        x: clamp(view.x + offset.x, -100, 100),
        y: clamp(view.y + offset.y, -100, 100),
        z: clamp(view.z + offset.z, -limits.far, limits.far),
      })
    })
  }

  #body(hit: Hit) {
    const view = this.#view
    if (!view.media) {
      const local = this.group.worldToLocal(hit.point.clone())
      const { width, height } = this.#size
      this.#browser?.press(local.x / width + 0.5, 0.5 - local.y / height)
      return
    }

    const runtime = this.#runtime
    if (!runtime) return
    const overflow = mediaOverflow(view)
    const canPan = runtime.snapshot().ready && (overflow.x > 0 || overflow.y > 0)
    if (!canPan && !runtime.video) return
    return xyDrag(hit.point, this.group.quaternion, (dx, dy) => {
      if (!canPan) return
      const pan = panned(view, dx, dy)
      if (pan.panX !== this.#view.panX || pan.panY !== this.#view.panY) this.workspace.patch(view.id, pan)
    }, Math.min(0.022, view.width * 0.035), moved => {
      if (!moved && runtime.video) this.workspace.patch(view.id, { controls: !view.controls })
    })
  }

  #control(hit: Hit, ray: Ray) {
    const runtime = this.#runtime
    if (!runtime?.video) return
    const panel = this.#controls
    const { width, height } = panel
    const x = hit.uv!.x * width
    const y = (1 - hit.uv!.y) * height
    if (panel.press(x, y)) return
    const media = runtime.snapshot()
    if (Math.abs(y - seekY) > 15 || media.duration <= 0 || x < seekX - 15 || x > width - seekX + 15) return
    const plane = panelPlane(hit.point, this.group.quaternion)
    const inverse = panel.mesh.matrixWorld.clone().invert()
    const point = new Vector3()
    const update = (current: Ray) => {
      if (!current.intersectPlane(plane, point)) return
      const pos = (point.applyMatrix4(inverse).x + 0.5) * width
      runtime.seek(clamp((pos - seekX) / (width - 2 * seekX), 0, 1) * media.duration)
    }
    update(ray)
    return { update }
  }
}

class FileBrowser {
  #panel: Panel
  #pageAnchor = 0
  #pageSize = 1
  #listing?: DirectoryListing
  #signature = ''
  #dirty = true
  #images = new Map<string, HTMLImageElement>()
  #destroyed = false

  constructor(group: Group, private readonly workspace: Workspace, private readonly id: string, private readonly end: Action) {
    this.#panel = new Panel(group)
  }

  get mesh() { return this.#panel.mesh }

  layout(width: number, height: number) { this.#panel.layout(width, height, 0) }

  // Use the first item of the current page throughout the drag, even if the grid reflows several times.
  startResize() { this.#pageAnchor -= this.#pageAnchor % this.#pageSize }

  press(u: number, v: number) {
    this.#panel.press(u * this.#panel.width, v * this.#panel.height)
  }

  sync({ listing, busy, error }: View['browser'], immersive: boolean) {
    if (this.#listing !== listing) {
      if (this.#listing?.path !== listing.path) this.#pageAnchor = 0
      this.#listing = listing
      this.#images.clear()
      this.#dirty = true
    }
    const panel = this.#panel
    const { width, height } = panel
    const compact = width < (immersive ? 618 : 530)
    const headerExtra = compact ? compactHeaderExtra : 0
    const firstRowY = gridTop + headerExtra
    const innerWidth = width - 2 * browserMargin
    const columns = Math.floor((innerWidth + columnGap) / (cardSize + columnGap))
    const rows = Math.floor((height - firstRowY - browserFooter + rowGap) / (cardSize + rowGap))
    const pageSize = columns * rows
    this.#pageSize = pageSize
    this.#pageAnchor = Math.min(this.#pageAnchor, Math.max(0, listing.entries.length - 1))
    const page = Math.floor(this.#pageAnchor / pageSize)
    const pageCount = Math.max(1, Math.ceil(listing.entries.length / pageSize))
    const signature = JSON.stringify([width, height, busy, error, page, immersive])
    if (!this.#dirty && signature === this.#signature) return
    this.#signature = signature
    this.#dirty = false
    panel.paint(ctx => {
      const parent = listing.path.split('/').slice(0, -1).join('/')
      if (listing.path) {
        panel.button('Root', browserMargin, 14, 66, 38, () => void this.workspace.navigate(this.id, ''))
        panel.button('Up', 105, 14, 55, 38, () => void this.workspace.navigate(this.id, parent))
      }
      const path = listing.path ? `${listing.rootName} / ${listing.path}` : listing.rootName
      const pathX = listing.path ? 176 : browserMargin
      const right = width - browserMargin
      const closeX = right - 78
      const exitX = closeX - 99
      const refreshX = (immersive ? exitX : closeX) - 107
      const pathRight = compact ? right : refreshX - 10
      text(ctx, path, pathX, 33, 22, muted, 560, pathRight - pathX)
      panel.button('Refresh', refreshX, 14 + headerExtra, 98, 38, () => void this.workspace.navigate(this.id, listing.path))
      if (immersive) panel.button('Exit VR', exitX, 14 + headerExtra, 90, 38, this.end)
      panel.button('Close', closeX, 14 + headerExtra, 78, 38, () => this.workspace.close(this.id))
      rect(ctx, browserMargin, 63 + headerExtra, innerWidth, 2, line)
      if (error || busy) {
        text(ctx, error || 'Loading…', browserMargin, 86 + headerExtra, 20, error ? ink : muted, 520, innerWidth)
      }
      if (!listing.entries.length && !busy && !error) {
        text(ctx, 'No media in this folder.', browserMargin, firstRowY + 17, 23, muted, 520, innerWidth)
      }
      listing.entries.slice(page * pageSize, (page + 1) * pageSize).forEach((item, i) => {
        const x = browserMargin + i % columns * (cardSize + columnGap)
        const y = firstRowY + Math.floor(i / columns) * (cardSize + rowGap)
        this.#card(ctx, item, x, y)
      })
      const footerY = height - 65
      if (page > 0) panel.button('Previous', browserMargin, footerY, 112, 36, () => { this.#pageAnchor = (page - 1) * pageSize })
      if (page + 1 < pageCount) panel.button('Next', right - 112, footerY, 112, 36, () => { this.#pageAnchor = (page + 1) * pageSize })
      if (pageCount > 1) {
        ctx.textAlign = 'center'
        text(ctx, `${page + 1} / ${pageCount}`, width / 2, footerY + 19, 20, muted, 500, innerWidth - 240)
        ctx.textAlign = 'left'
      }
    })
  }

  dispose() {
    this.#destroyed = true
    this.#images.clear()
    this.#panel.dispose()
  }

  #card(ctx: CanvasRenderingContext2D, item: LibraryEntry, x: number, y: number) {
    rect(ctx, x, y, cardSize, cardSize, line, 8)
    rect(ctx, x + 2, y + 2, cardSize - 4, cardSize - 4, '#2e2e2e', 7)
    text(ctx, item.name, x + 12, y + cardSize - 17, 22, ink, 550, cardSize - 24)
    if (item.kind === 'folder') {
      const iconX = x + (cardSize - 67) / 2
      rect(ctx, iconX, y + 54, 41, 16, '#858585', 5)
      rect(ctx, iconX, y + 64, 67, 42, '#b5b5b5', 5)
      this.#panel.action(x, y, cardSize, cardSize, () => void this.workspace.navigate(this.id, item.path))
      return
    }
    let image = this.#images.get(item.path)
    if (!image) {
      image = new Image()
      image.onload = () => { if (!this.#destroyed) this.#dirty = true }
      image.src = mediaUrl(item, 'thumbnail')
      this.#images.set(item.path, image)
    }
    const destW = cardSize - 16
    const destH = cardSize - 42
    rect(ctx, x + 8, y + 8, destW, destH, '#3a3a3a', 4)
    if (image.complete && image.naturalWidth) {
      const ratio = Math.min(destW / image.naturalWidth, destH / image.naturalHeight)
      const w = image.naturalWidth * ratio
      const h = image.naturalHeight * ratio
      ctx.drawImage(image, x + 8 + (destW - w) / 2, y + 8 + (destH - h) / 2, w, h)
    }
    if (item.kind === 'video') chip(ctx, '▶', x + cardSize - 52, y + destH - 30, 36, 30)
    this.#panel.action(x, y, cardSize, cardSize, () => this.workspace.open(this.id, item))
  }
}
