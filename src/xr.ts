import {
  BufferAttribute, BufferGeometry, CanvasTexture, Color, DoubleSide, Fog, GridHelper, Group, Line, LineBasicMaterial,
  Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera, Plane, PlaneGeometry, Quaternion, Ray, Raycaster, Scene,
  SphereGeometry, SRGBColorSpace, Texture, Vector3, VideoTexture, WebGLRenderer,
  type Intersection, type XRTargetRaySpace,
} from 'three'
import { mediaUrl, type DirectoryListing, type LibraryEntry } from './media-api'
import {
  clamp, formatTime, limits, panned, resizedDimensions, viewHeight, windowDefaults,
  type MediaRuntime, type View, type Workspace,
} from './workspace'

const ink = '#e4ebf4'
const muted = '#a1b1c4'
const mint = '#6ae9ce'
const surface = '#141d2a'
const line = '#354659'
const controllerSmoothingTime = 0.035 // Seconds

type Face = Mesh<PlaneGeometry, MeshBasicMaterial>
type Hit = Intersection<Face>
interface Grab {
  update(ray: Ray, depth: number, orientation: Quaternion): void
  finish?(commit: boolean): void
}
interface Target {
  mesh: Face
  panel: XRWindow
  press(hit: Hit, ray: Ray): Grab | void
}
type Action = () => void

function face(group: Group, color: string | number, geometry = new PlaneGeometry()) {
  const mesh = new Mesh(geometry, new MeshBasicMaterial({ color, toneMapped: false }))
  group.add(mesh)
  return mesh
}

function place(mesh: Face, width: number, height: number, y: number, z: number) {
  mesh.scale.set(width, height, 1)
  mesh.position.set(0, y, z)
}

class Panel {
  readonly canvas = document.createElement('canvas')
  readonly context: CanvasRenderingContext2D
  readonly texture: CanvasTexture
  readonly mesh: Face

  constructor(group: Group, width: number, height: number) {
    this.canvas.width = width
    this.canvas.height = height
    this.context = this.canvas.getContext('2d')!
    this.texture = new CanvasTexture(this.canvas)
    this.texture.colorSpace = SRGBColorSpace
    this.mesh = face(group, 0xffffff)
    this.mesh.material.map = this.texture
  }

  paint(draw: (ctx: CanvasRenderingContext2D) => void) {
    this.context.fillStyle = surface
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height)
    draw(this.context)
    this.texture.needsUpdate = true
  }

  dispose() { this.texture.dispose() }
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

function chip(ctx: CanvasRenderingContext2D, label: string, x: number, y: number, w: number, h: number, active = false) {
  rect(ctx, x, y, w, h, active ? '#396b63' : line, 8)
  rect(ctx, x + 2, y + 2, w - 4, h - 4, '#202c3d', 7)
  ctx.textAlign = 'center'
  text(ctx, label, x + w / 2, y + h / 2 + 1, 22, active ? mint : ink, 620, w - 8)
  ctx.textAlign = 'left'
}

function slider(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, progress: number) {
  const position = x + w * clamp(progress, 0, 1)
  rect(ctx, x, y - 3, w, 6, line, 3)
  rect(ctx, x, y - 3, position - x, 6, mint, 3)
  ctx.fillStyle = mint
  ctx.beginPath()
  ctx.arc(position, y, 8, 0, Math.PI * 2)
  ctx.fill()
}

function visibleMedia(mesh: Face, view: View) {
  const height = viewHeight(view)
  const aspect = view.width / height
  const fitWidth = Math.min(1, view.aspect / aspect)
  const fitHeight = Math.min(1, aspect / view.aspect)
  const crop = (fit: number, pan: number) => {
    const size = fit * view.zoom
    const start = (1 - size + pan * (view.zoom - 1)) / 2
    const lower = clamp(start, 0, 1)
    const upper = clamp(start + size, 0, 1)
    return { lower, upper, uv0: clamp((lower - start) / size, 0, 1), uv1: clamp((upper - start) / size, 0, 1) }
  }
  const x = crop(fitWidth, view.panX)
  const y = crop(fitHeight, view.panY)
  mesh.scale.set((x.upper - x.lower) * view.width, (y.upper - y.lower) * height, 1)
  mesh.position.set((x.lower + x.upper - 1) * view.width / 2, (y.lower + y.upper - 1) * height / 2, 0.003)
  const uv = mesh.geometry.getAttribute('uv')
  uv.setXY(0, x.uv0, y.uv1)
  uv.setXY(1, x.uv1, y.uv1)
  uv.setXY(2, x.uv0, y.uv0)
  uv.setXY(3, x.uv1, y.uv0)
  uv.needsUpdate = true
}

function panelPlane(point: Vector3, orientation: Quaternion) {
  const normal = new Vector3(0, 0, 1).applyQuaternion(orientation)
  return new Plane().setFromNormalAndCoplanarPoint(normal, point)
}

function xyDrag(
  view: View, point: Vector3, orientation: Quaternion,
  apply: (dx: number, dy: number) => void, finish?: (moved: boolean) => void,
): Grab {
  const plane = panelPlane(point, orientation)
  const inverse = orientation.clone().invert()
  const intersect = new Vector3()
  let moved = false
  return {
    update(ray) {
      if (!ray.intersectPlane(plane, intersect)) return
      const { x: dx, y: dy } = intersect.sub(point).applyQuaternion(inverse)
      moved ||= Math.hypot(dx, dy) >= Math.min(0.022, view.width * 0.035)
      if (moved) apply(dx, dy)
    },
    finish(commit) { if (commit) finish?.(moved) },
  }
}

class XRWindow {
  readonly group = new Group()
  readonly targets: Target[]
  #view: View
  #frame = face(this.group, line)
  #screen = face(this.group, '#090e15')
  #media = face(this.group, 0xffffff)
  #hitbox = face(this.group, 0xffffff)
  #title = new Panel(this.group, 660, 48)
  #controls = new Panel(this.group, 660, 140)
  #message = new Panel(this.group, 480, 65)
  #browser?: XRBrowser
  #runtime?: MediaRuntime
  #texture?: Texture
  #selected = false
  #lastControls = ''
  #lastMessage = ''

  constructor(private readonly workspace: Workspace, view: View, private readonly end: Action) {
    this.#view = view
    this.#hitbox.material.visible = false
    this.#message.mesh.visible = false
    this.#media.visible = false
    // Keep the view visible and grabbable from the back after rotation.
    this.#frame.material.side = DoubleSide
    this.#hitbox.material.side = DoubleSide
    this.targets = [
      { mesh: this.#hitbox, panel: this, press: hit => this.#body(hit) },
      { mesh: this.#title.mesh, panel: this, press: hit => this.#header(hit) },
      { mesh: this.#controls.mesh, panel: this, press: (hit, ray) => this.#control(hit, ray) },
    ]
    this.#layout()
    this.#paintFrame()
  }

  get runtime() { return this.#runtime }

  sync(view: View, selected: boolean, runtime: MediaRuntime | undefined) {
    const runtimeChanged = runtime !== this.#runtime
    const repaint = selected !== this.#selected || runtimeChanged || view.media?.name !== this.#view.media?.name
    const createBrowser = !runtime && !this.#browser
    if (createBrowser) this.#browser = new XRBrowser(this.group, this.workspace, view.id, this.end)
    if (runtimeChanged) {
      this.#runtime = runtime
      this.#texture?.dispose()
      this.#texture = undefined
      this.#media.material.map = null
      this.#lastControls = ''
    }
    if (view !== this.#view || runtimeChanged || createBrowser) {
      this.#view = view
      this.#layout()
    }
    this.#selected = selected
    if (repaint) this.#paintFrame()

    if (this.#browser) this.#browser.mesh.visible = !runtime
    if (!runtime) {
      this.#media.visible = false
      this.#message.mesh.visible = false
      this.#browser?.sync(view.browser)
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
    this.#media.visible = Boolean(this.#texture) && !media.error
    this.#message.mesh.visible = !this.#media.visible
    const message = media.error ? 'Could not display the file' : 'Loading…'
    if (this.#message.mesh.visible && message !== this.#lastMessage) {
      this.#lastMessage = message
      this.#message.paint(ctx => {
        ctx.textAlign = 'center'
        text(ctx, message, 240, 33, 23, muted)
        ctx.textAlign = 'left'
      })
    }
    if (view.controls) this.#paintControls()
  }

  grab(hit: Hit, orientation: Quaternion): Grab {
    this.#focus()
    const view = this.#view
    const inverse = orientation.clone().invert()
    const previousPosition = this.group.position.clone()
    const previousOrientation = this.group.quaternion.clone()
    const offset = previousPosition.clone().sub(hit.point).applyQuaternion(inverse)
    const relativeOrientation = inverse.multiply(previousOrientation)
    const position = new Vector3()
    const rotatedOffset = new Vector3()
    const next = new Quaternion()
    let distance = hit.distance
    return {
      update: (ray, depth, current) => {
        if (depth) distance = clamp(distance + depth, limits.near, limits.far)
        ray.at(distance, position).add(rotatedOffset.copy(offset).applyQuaternion(current))
        position.set(clamp(position.x, -100, 100), clamp(position.y, -100, 100), clamp(position.z, -limits.far, limits.far))
        next.copy(current).multiply(relativeOrientation).normalize()
        if (previousPosition.distanceToSquared(position) < 1e-8 && next.angleTo(previousOrientation) < 0.0001) return
        previousPosition.copy(position)
        previousOrientation.copy(next)
        this.workspace.patch(view.id, {
          x: position.x, y: position.y, z: position.z,
          orientation: [next.x, next.y, next.z, next.w],
        })
      },
    }
  }

  dispose() {
    this.group.removeFromParent()
    this.#texture?.dispose()
    this.#browser?.dispose()
    for (const panel of [this.#title, this.#controls, this.#message]) panel.dispose()
    for (const child of this.group.children as Face[]) {
      child.geometry.dispose()
      child.material.dispose()
    }
  }

  #layout() {
    const view = this.#view
    const height = viewHeight(view)
    const border = clamp(view.width * 0.005, 0.004, 0.014)
    const title = view.width * 48 / 660
    const controls = view.width * (this.#runtime?.video ? 140 : 47) / 660
    this.group.position.set(view.x, view.y, view.z)
    this.group.quaternion.fromArray(view.orientation)
    place(this.#frame, view.width + border * 2, height + title + border * 2, title / 2, -0.01)
    place(this.#screen, view.width, height, 0, 0)
    if (view.media) visibleMedia(this.#media, view)
    if (this.#browser) place(this.#browser.mesh, view.width, height, 0, 0.003)
    place(this.#hitbox, view.width + border * 5, height + border * 5, 0, 0.011)
    place(this.#title.mesh, view.width + border * 2, title, (height + title) / 2, 0.015)
    place(this.#message.mesh, view.width * 0.63, view.width * 0.086, 0, 0.009)
    place(this.#controls.mesh, view.width, controls, -(height + controls) / 2 - border, 0.017)
    this.#controls.mesh.visible = Boolean(this.#runtime) && view.controls
  }

  #paintFrame() {
    this.#frame.material.color.set(this.#selected ? mint : line)
    this.#title.paint(ctx => {
      rect(ctx, 0, 0, 660, 2, this.#selected ? mint : line)
      const { media } = this.#view
      if (media) chip(ctx, '← Back', 12, 7, 90, 35)
      const titleX = media ? 117 : 16
      text(ctx, media?.name ?? 'File browser', titleX, 25, 23, ink, 625, 600 - titleX)
      chip(ctx, '×', 613, 7, 40, 35)
    })
  }

  #paintControls() {
    const view = this.#view
    const runtime = this.#runtime
    if (!runtime) return
    const media = runtime.snapshot()
    const signature = JSON.stringify([
      view.zoom, view.loopStart, view.loopEnd, view.muted, media.duration, Math.floor(media.time * 10), media.playing,
    ])
    if (signature === this.#lastControls) return
    this.#lastControls = signature
    this.#controls.paint(ctx => {
      const hasVideo = Boolean(runtime.video)
      const zoomY = hasVideo ? 115 : 70
      rect(ctx, 0, 0, 660, 2, line)
      if (hasVideo) {
        const fraction = (t: number) => media.duration ? t / media.duration : 0
        slider(ctx, 25, 22, 610, fraction(media.time))
        if (view.loopStart) rect(ctx, 25 + 610 * fraction(view.loopStart), 14, 3, 16, '#f3c387')
        if (view.loopEnd !== null) rect(ctx, 25 + 610 * fraction(view.loopEnd), 14, 3, 16, '#f3c387')
        chip(ctx, media.playing ? 'Ⅱ' : '▶', 19, 40, 64, 43)
        text(ctx, `${formatTime(media.time)} / ${formatTime(media.duration)}`, 98, 62, 21, muted, 550, 201)
        chip(ctx, '[ A', 321, 40, 77, 43, view.loopStart > 0)
        chip(ctx, 'B ]', 413, 40, 77, 43, view.loopEnd !== null)
        chip(ctx, view.muted ? 'Unmute' : 'Mute', 505, 40, 130, 43, !view.muted)
        rect(ctx, 20, 92, 620, 2, line)
      }
      text(ctx, 'Zoom', 25, zoomY, hasVideo ? 22 : 34, muted, 630)
      slider(ctx, 152, zoomY, 382, (view.zoom - 1) / (limits.maxZoom - 1))
      text(ctx, `${Math.round(view.zoom * 100)}%`, 560, zoomY, hasVideo ? 23 : 35)
    })
  }

  #focus() { this.workspace.select(this.#view.id) }

  #resize(hit: Hit, x: number, y: number) {
    const view = this.#view
    const orientation = this.group.quaternion.clone()
    const height = viewHeight(view)
    const offset = new Vector3()
    return xyDrag(view, hit.point, orientation, (dx, dy) => {
      const size = resizedDimensions(view, dx, dy, x, y)
      offset.set(x * (size.width - view.width) / 2, y * ((size.height ?? height) - height) / 2, 0)
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
    this.#focus()
    const local = this.group.worldToLocal(hit.point.clone())
    const x = local.x / view.width
    const y = local.y / viewHeight(view)
    const edgeX = Math.abs(x) > 0.463 ? Math.sign(x) : 0
    const edgeY = Math.abs(y) > 0.449 ? Math.sign(y) : 0
    if (edgeX || edgeY) return this.#resize(hit, edgeX, edgeY)
    if (!view.media) {
      this.#browser?.press(x + 0.5, 0.5 - y)
      return
    }

    return xyDrag(view, hit.point, this.group.quaternion, (dx, dy) => {
      if (view.zoom > 1) this.workspace.patch(view.id, panned(view, dx, dy))
    }, moved => {
      if (!moved) this.workspace.patch(view.id, { controls: !view.controls })
    })
  }

  #header(hit: Hit) {
    this.#focus()
    const uv = hit.uv!
    const px = uv.x * 660
    const py = (1 - uv.y) * 48
    const onButton = py >= 7 && py <= 42
    if (onButton && px >= 613 && px <= 653) {
      this.workspace.close(this.#view.id)
      return
    }
    if (this.#view.media && onButton && px >= 12 && px <= 102) {
      this.workspace.back(this.#view.id)
      return
    }
    const x = uv.x < 0.04 ? -1 : uv.x > 0.96 ? 1 : 0
    const y = uv.y > 0.72 ? 1 : 0
    if (x || y) return this.#resize(hit, x, y)
  }

  #control(hit: Hit, ray: Ray) {
    const runtime = this.#runtime
    if (!runtime) return
    this.#focus()
    const x = hit.uv!.x * 660
    const y = (1 - hit.uv!.y) * 140
    const media = runtime.snapshot()
    if (runtime.video && y >= 38 && y <= 87) {
      if (x >= 19 && x <= 83) runtime.togglePlayback()
      else if (x >= 321 && x <= 398) runtime.mark('start')
      else if (x >= 413 && x <= 490) runtime.mark('end')
      else if (x >= 505 && x <= 635) this.workspace.patch(this.#view.id, { muted: !this.#view.muted })
      return
    }
    const seeking = runtime.video && y < 36 && media.duration > 0
    const zooming = (!runtime.video || y > 93) && x >= 134 && x <= 552
    if (!seeking && !zooming) return
    const panel = this.#controls.mesh
    const plane = panelPlane(hit.point, this.group.quaternion)
    const point = new Vector3()
    const update = (current: Ray) => {
      if (!current.intersectPlane(plane, point)) return
      const pos = (panel.worldToLocal(point).x + 0.5) * 660
      if (seeking) runtime.seek(clamp((pos - 25) / 610, 0, 1) * media.duration)
      else this.workspace.zoom(this.#view.id, 1 + clamp((pos - 152) / 382, 0, 1) * (limits.maxZoom - 1))
    }
    update(ray)
    return { update }
  }
}

interface ButtonArea {
  x: number
  y: number
  w: number
  h: number
  run: Action
}

const pageSize = 6
const browserWidth = 720
const browserHeight = 566

class XRBrowser {
  #panel: Panel
  #page = 0
  #buttons: ButtonArea[] = []
  #listing?: DirectoryListing
  #signature = ''
  #dirty = true
  #images = new Map<string, HTMLImageElement>()
  #destroyed = false

  constructor(group: Group, private readonly workspace: Workspace, private readonly id: string, private readonly end: Action) {
    this.#panel = new Panel(group, browserWidth, browserHeight)
  }

  get mesh() { return this.#panel.mesh }

  press(u: number, v: number) {
    const x = u * browserWidth
    const y = v * browserHeight
    this.#buttons.find(button => x >= button.x && x <= button.x + button.w && y >= button.y && y <= button.y + button.h)?.run()
  }

  sync({ listing, busy, error }: View['browser']) {
    if (this.#listing !== listing) {
      if (this.#listing?.path !== listing.path) this.#page = 0
      this.#listing = listing
      this.#images.clear()
      this.#dirty = true
    }
    const pageCount = Math.max(1, Math.ceil(listing.entries.length / pageSize))
    this.#page = clamp(this.#page, 0, pageCount - 1)
    const signature = JSON.stringify([busy, error, this.#page])
    if (!this.#dirty && signature === this.#signature) return
    this.#signature = signature
    this.#dirty = false
    this.#buttons = []
    this.#panel.paint(ctx => {
      const parent = listing.path.split('/').slice(0, -1).join('/')
      if (listing.path) {
        this.#button(ctx, 'Root', 30, 14, 66, 38, () => void this.workspace.navigate(this.id, ''))
        this.#button(ctx, 'Up', 105, 14, 55, 38, () => void this.workspace.navigate(this.id, parent))
      }
      const path = listing.path ? `${listing.rootName} / ${listing.path}` : listing.rootName
      const pathX = listing.path ? 176 : 30
      text(ctx, path, pathX, 33, 22, muted, 560, 483 - pathX)
      this.#button(ctx, 'Refresh', 493, 14, 98, 38, () => void this.workspace.navigate(this.id, listing.path))
      this.#button(ctx, 'Exit VR', 600, 14, 90, 38, this.end)
      rect(ctx, 30, 63, 660, 2, line)
      if (error || busy) text(ctx, error || 'Loading…', 30, 86, 20, error ? '#f3c387' : muted, 520, 660)
      if (!listing.entries.length && !busy && !error) {
        text(ctx, 'No media in this folder.', 30, 122, 23, muted, 520, 660)
      }
      listing.entries.slice(this.#page * pageSize, (this.#page + 1) * pageSize).forEach((item, i) => {
        this.#card(ctx, item, i)
      })
      if (this.#page > 0) this.#button(ctx, 'Previous', 30, 501, 112, 36, () => this.#page--)
      if (this.#page + 1 < pageCount) this.#button(ctx, 'Next', 578, 501, 112, 36, () => this.#page++)
      if (pageCount > 1) {
        ctx.textAlign = 'center'
        text(ctx, `${this.#page + 1} / ${pageCount}`, 360, 520, 20, muted)
        ctx.textAlign = 'left'
      }
    })
  }

  dispose() {
    this.#destroyed = true
    this.#images.clear()
    this.#panel.dispose()
  }

  #card(ctx: CanvasRenderingContext2D, item: LibraryEntry, index: number) {
    const x = index % 2 === 0 ? 30 : 367
    const y = 105 + Math.floor(index / 2) * 129
    const w = 323
    const h = 119
    rect(ctx, x, y, w, h, line, 8)
    rect(ctx, x + 2, y + 2, w - 4, h - 4, '#1c2939', 7)
    if (item.kind === 'folder') {
      rect(ctx, x + 24, y + 21, 41, 16, '#648d9e', 5)
      rect(ctx, x + 24, y + 31, 67, 42, '#9dbcc7', 5)
      text(ctx, item.name, x + 17, y + 97, 23, ink, 650, w - 32)
      this.#buttons.push({ x, y, w, h, run: () => void this.workspace.navigate(this.id, item.path) })
      return
    }
    let image = this.#images.get(item.path)
    if (!image) {
      image = new Image()
      image.onload = () => { if (!this.#destroyed) this.#dirty = true }
      image.src = mediaUrl(item, 'thumbnail')
      this.#images.set(item.path, image)
    }
    const destW = w - 16
    const destH = 73
    rect(ctx, x + 8, y + 8, destW, destH, '#293847', 4)
    if (image.complete && image.naturalWidth) {
      const ratio = Math.max(destW / image.naturalWidth, destH / image.naturalHeight)
      const sw = destW / ratio
      const sh = destH / ratio
      ctx.drawImage(image, (image.naturalWidth - sw) / 2, (image.naturalHeight - sh) / 2, sw, sh, x + 8, y + 8, destW, destH)
    }
    if (item.kind === 'video') chip(ctx, '▶', x + w - 54, y + 43, 36, 30)
    text(ctx, item.name, x + 12, y + 99, 22, ink, 550, w - 24)
    this.#buttons.push({ x, y, w, h, run: () => this.workspace.open(this.id, item) })
  }

  #button(ctx: CanvasRenderingContext2D, label: string, x: number, y: number, w: number, h: number, run: Action) {
    chip(ctx, label, x, y, w, h)
    this.#buttons.push({ x, y, w, h, run })
  }
}

interface Pointer {
  controller: XRTargetRaySpace
  beam: Line<BufferGeometry, LineBasicMaterial>
  cursor: Mesh<SphereGeometry, MeshBasicMaterial>
  source?: XRInputSource
  grab?: { panel: XRWindow, action: Grab, button: 'select' | 'squeeze' }
}

export class XRWorkspace {
  #renderer: WebGLRenderer
  #scene = new Scene()
  #camera = new PerspectiveCamera(55, 1, 0.04, 80)
  #floor = new GridHelper(70, 70, '#396068', '#263746')
  #windows = new Map<string, XRWindow>()
  #pointers: Pointer[]
  #raycaster = new Raycaster()
  #targets = new Map<Face, Target>()
  #session?: XRSession
  #previousFrame = 0
  #destroyed = false

  constructor(private readonly workspace: Workspace, container: HTMLElement) {
    const canvas = document.createElement('canvas')
    // Request XR compatibility up front to avoid context loss when entering PC VR.
    const context = canvas.getContext('webgl2', { xrCompatible: true, antialias: true, alpha: false })
    if (!context) throw new Error('Could not create a WebGL 2 context for VR mode.')
    this.#renderer = new WebGLRenderer({ canvas, context })
    this.#renderer.xr.enabled = true
    this.#renderer.xr.setReferenceSpaceType('local')
    this.#renderer.setSize(Math.max(window.innerWidth, 1), Math.max(window.innerHeight, 1), false)
    container.append(this.#renderer.domElement)

    this.#scene.background = new Color('#0c1420')
    this.#scene.fog = new Fog('#0c1420', 7, 25)
    this.#floor.position.y = -1.58
    this.#scene.add(this.#floor)
    this.#pointers = [0, 1].map(index => this.#createPointer(index))
  }

  async start(session: XRSession) {
    this.#session = session
    await this.#renderer.xr.setSession(session)
    if (!this.#destroyed) this.#renderer.xr.setAnimationLoop(this.#frame)
  }

  dispose() {
    this.#destroyed = true
    this.#renderer.setAnimationLoop(null)
    for (const panel of this.#windows.values()) panel.dispose()
    for (const pointer of this.#pointers) {
      this.#resetPointer(pointer)
      pointer.beam.geometry.dispose()
      pointer.beam.material.dispose()
      pointer.cursor.geometry.dispose()
      pointer.cursor.material.dispose()
    }
    this.#floor.dispose()
    this.#renderer.dispose()
    this.#renderer.domElement.remove()
  }

  #createPointer(index: number): Pointer {
    const controller = this.#renderer.xr.getController(index)
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 0, 0, -1]), 3))
    const beam = new Line(geometry, new LineBasicMaterial({ color: mint, transparent: true, opacity: 0.8 }))
    beam.frustumCulled = false
    beam.visible = false
    const cursor = new Mesh(new SphereGeometry(0.005, 12, 8), new MeshBasicMaterial({ color: mint, toneMapped: false }))
    cursor.visible = false
    this.#scene.add(beam, cursor)
    const pointer: Pointer = { controller, beam, cursor }
    controller.addEventListener('connected', event => {
      pointer.source = event.data
    })
    controller.addEventListener('disconnected', () => {
      pointer.source = undefined
      this.#resetPointer(pointer)
    })
    controller.addEventListener('selectstart', () => this.#press(pointer, 'select'))
    controller.addEventListener('selectend', () => {
      if (pointer.grab?.button === 'select') this.#finishGrab(pointer, controller.visible)
    })
    controller.addEventListener('squeezestart', () => this.#press(pointer, 'squeeze'))
    controller.addEventListener('squeezeend', () => {
      if (pointer.grab?.button === 'squeeze') this.#finishGrab(pointer, controller.visible)
    })
    return pointer
  }

  #press(pointer: Pointer, button: 'select' | 'squeeze') {
    if (!pointer.source || !pointer.controller.visible || pointer.grab) return
    // Use the same filtered pose as the displayed ray.
    if (!pointer.beam.visible) this.#filterPose(pointer, 1)
    this.#sync()
    const hit = this.#hit(pointer)
    const target = hit && this.#targets.get(hit.object)
    if (!hit || !target) {
      if (button === 'select') this.#createWindow(this.#raycaster.ray)
      return
    }
    const { panel } = target
    if (this.#pointers.some(other => other.grab?.panel === panel)) return
    const action = button === 'squeeze' ? panel.grab(hit, pointer.beam.quaternion) : target.press(hit, this.#raycaster.ray)
    if (action) pointer.grab = { panel, action, button }
  }

  #createWindow(ray: Ray) {
    const position = ray.at(windowDefaults.depth, new Vector3())
    const viewer = this.#renderer.xr.getCamera().getWorldPosition(new Vector3())
    const rotation = new Matrix4().lookAt(viewer, position, new Vector3(0, 1, 0))
    this.workspace.create({
      x: position.x, y: position.y, z: position.z,
      orientation: new Quaternion().setFromRotationMatrix(rotation).toArray(),
    })
  }

  #end = () => { if (this.#session) void this.#session.end().catch(() => {}) }

  #finishGrab(pointer: Pointer, commit: boolean) {
    const grab = pointer.grab
    if (!grab) return
    pointer.grab = undefined
    grab.action.finish?.(commit)
    if (commit) this.workspace.save()
  }

  #sync() {
    const { views, selected } = this.workspace.snapshot()
    const wanted = new Set(views.map(view => view.id))
    for (const [id, panel] of this.#windows) {
      if (wanted.has(id)) continue
      for (const pointer of this.#pointers) if (pointer.grab?.panel === panel) this.#finishGrab(pointer, false)
      panel.dispose()
      this.#windows.delete(id)
    }
    this.#targets.clear()
    for (const view of views) {
      const runtime = this.workspace.runtime(view.id)
      let panel = this.#windows.get(view.id)
      if (!panel) {
        panel = new XRWindow(this.workspace, view, this.#end)
        this.#windows.set(view.id, panel)
        this.#scene.add(panel.group)
      }
      if (panel.runtime !== runtime) {
        for (const pointer of this.#pointers) if (pointer.grab?.panel === panel) this.#finishGrab(pointer, false)
      }
      panel.sync(view, selected === view.id, runtime)
      for (const target of panel.targets) if (target.mesh.visible) this.#targets.set(target.mesh, target)
    }
    this.#scene.updateMatrixWorld()
  }

  #frame = (time: number) => {
    const dt = this.#previousFrame ? clamp((time - this.#previousFrame) / 1000, 0, 0.05) : 0
    const alpha = 1 - Math.exp(-dt / controllerSmoothingTime)
    this.#previousFrame = time
    this.#sync()
    for (const pointer of this.#pointers) {
      if (!pointer.source || !pointer.controller.visible) {
        this.#resetPointer(pointer)
        continue
      }
      this.#filterPose(pointer, alpha)
      const hit = this.#hit(pointer)
      const axes = pointer.source.gamepad?.axes
      const y = axes?.[3] ?? axes?.[1] ?? 0
      const depth = Math.abs(y) > 0.2 ? y * dt * 2.2 : 0
      pointer.grab?.action.update(this.#raycaster.ray, depth, pointer.beam.quaternion)
      const positions = pointer.beam.geometry.getAttribute('position')
      positions.setZ(1, -(hit?.distance ?? windowDefaults.depth))
      positions.needsUpdate = true
      pointer.beam.material.opacity = hit ? 0.82 : 0.27
      pointer.cursor.visible = !hit && !pointer.grab
      if (pointer.cursor.visible) this.#raycaster.ray.at(windowDefaults.depth, pointer.cursor.position)
    }
    this.#renderer.render(this.#scene, this.#camera)
  }

  #resetPointer(pointer: Pointer) {
    this.#finishGrab(pointer, false)
    pointer.beam.visible = false
    pointer.cursor.visible = false
  }

  #filterPose({ controller, beam }: Pointer, alpha: number) {
    if (beam.visible) {
      beam.position.lerp(controller.position, alpha)
      beam.quaternion.slerp(controller.quaternion, alpha)
    } else {
      beam.position.copy(controller.position)
      beam.quaternion.copy(controller.quaternion)
      beam.visible = true
    }
  }

  #hit(pointer: Pointer): Hit | undefined {
    const { ray } = this.#raycaster
    ray.origin.copy(pointer.beam.position)
    ray.direction.set(0, 0, -1).applyQuaternion(pointer.beam.quaternion)
    return this.#raycaster.intersectObjects([...this.#targets.keys()], false)[0] as Hit | undefined
  }
}
