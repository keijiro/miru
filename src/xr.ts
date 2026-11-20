import {
  BufferAttribute, BufferGeometry, CanvasTexture, Color, Fog, GridHelper, Group, Line, LineBasicMaterial,
  Mesh, MeshBasicMaterial, PerspectiveCamera, Plane, PlaneGeometry, Quaternion, Ray, Raycaster, Scene,
  SRGBColorSpace, Texture, Vector3, VideoTexture, WebGLRenderer,
  type Intersection, type XRTargetRaySpace,
} from 'three'
import { mediaUrl, type DirectoryListing, type LibraryEntry } from './media-api'
import {
  clamp, formatTime, frameAspect, limits, panned, resized, viewHeight,
  type MediaRuntime, type View, type Workspace,
} from './workspace'

const ink = '#e4ebf4'
const muted = '#a1b1c4'
const mint = '#6ae9ce'
const surface = '#141d2a'
const line = '#354659'

type Face = Mesh<PlaneGeometry, MeshBasicMaterial>
type Hit = Intersection<Face>
interface Grab {
  update(ray: Ray, depth: number): void
  finish?(commit: boolean): void
}
interface Target {
  mesh: Face
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
  const aspect = frameAspect(view)
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
  const height = viewHeight(view)
  mesh.scale.set((x.upper - x.lower) * view.width, (y.upper - y.lower) * height, 1)
  mesh.position.set((x.lower + x.upper - 1) * view.width / 2, (y.lower + y.upper - 1) * height / 2, 0.003)
  const uv = mesh.geometry.getAttribute('uv')
  uv.setXY(0, x.uv0, y.uv1)
  uv.setXY(1, x.uv1, y.uv1)
  uv.setXY(2, x.uv0, y.uv0)
  uv.setXY(3, x.uv1, y.uv0)
  uv.needsUpdate = true
}

function xyDrag(view: View, point: Vector3, apply: (dx: number, dy: number) => void, finish?: (moved: boolean) => void): Grab {
  const plane = new Plane(new Vector3(0, 0, 1), -point.z)
  const intersect = new Vector3()
  let moved = false
  return {
    update(ray) {
      if (!ray.intersectPlane(plane, intersect)) return
      const dx = intersect.x - point.x
      const dy = intersect.y - point.y
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
  #grip = new Panel(this.group, 200, 30)
  #controls = new Panel(this.group, 660, 140)
  #message = new Panel(this.group, 480, 65)
  #texture?: Texture
  #selected = false
  #lastControls = ''
  #lastMessage = ''

  constructor(private readonly workspace: Workspace, view: View, readonly runtime: MediaRuntime) {
    this.#view = view
    this.#hitbox.material.visible = false
    this.#message.mesh.visible = false
    this.#media.visible = false
    this.targets = [
      { mesh: this.#hitbox, press: (hit, ray) => this.#body(hit, ray) },
      { mesh: this.#grip.mesh, press: hit => this.#move(hit) },
      { mesh: this.#title.mesh, press: (hit, ray) => this.#header(hit, ray) },
      { mesh: this.#controls.mesh, press: (hit, ray) => this.#control(hit, ray) },
    ]
    this.#layout()
  }

  sync(view: View, selected: boolean) {
    if (view !== this.#view || selected !== this.#selected) {
      this.#view = view
      this.#selected = selected
      this.#layout()
    }

    const media = this.runtime.snapshot()
    if (media.ready && !this.#texture) {
      const image = this.runtime.element
      const texture = this.runtime.video ? new VideoTexture(this.runtime.video) : new Texture(image)
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

  dispose() {
    this.group.removeFromParent()
    this.#texture?.dispose()
    for (const panel of [this.#title, this.#grip, this.#controls, this.#message]) panel.dispose()
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
    const grip = view.width * 0.043
    const controls = view.width * (this.runtime.video ? 140 : 47) / 660
    this.group.position.set(view.x, view.y, view.z)
    this.#frame.material.color.set(this.#selected ? mint : line)
    place(this.#frame, view.width + border * 2, height + title + border * 2, title / 2, -0.01)
    place(this.#screen, view.width, height, 0, 0)
    visibleMedia(this.#media, view)
    place(this.#hitbox, view.width + border * 5, height + border * 5, 0, 0.011)
    place(this.#title.mesh, view.width + border * 2, title, (height + title) / 2, 0.015)
    place(this.#message.mesh, view.width * 0.63, view.width * 0.086, 0, 0.009)
    place(this.#controls.mesh, view.width, controls, -(height + controls) / 2 - border, 0.017)
    this.#controls.mesh.visible = view.controls
    const extra = view.controls ? controls + border : 0
    place(this.#grip.mesh, view.width * 0.285, grip, -(height + grip) / 2 - extra - border * 3, 0.02)

    this.#title.paint(ctx => {
      rect(ctx, 0, 0, 660, 2, this.#selected ? mint : line)
      const badge = this.runtime.video ? 'VID' : 'IMG'
      text(ctx, badge, 15, 25, 17, this.#selected ? mint : muted, 700)
      text(ctx, view.media.name, 68, 25, 23, ink, 625, 529)
      chip(ctx, '×', 613, 7, 40, 35)
    })
    this.#grip.paint(ctx => {
      rect(ctx, 0, 0, 200, 30, this.#selected ? '#42766e' : line, 6)
      rect(ctx, 2, 2, 196, 26, '#1c2b3b', 5)
      for (let dot = 0; dot < 5; dot++) rect(ctx, 79 + dot * 9, 13, 4, 4, this.#selected ? mint : muted, 2)
    })
  }

  #paintControls() {
    const view = this.#view
    const media = this.runtime.snapshot()
    const signature = JSON.stringify([
      view.zoom, view.loopStart, view.loopEnd, view.muted, media.duration, Math.floor(media.time * 10), media.playing,
    ])
    if (signature === this.#lastControls) return
    this.#lastControls = signature
    this.#controls.paint(ctx => {
      const hasVideo = Boolean(this.runtime.video)
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
    return xyDrag(view, hit.point, (dx, dy) => this.workspace.patch(view.id, resized(view, dx, dy, x, y)))
  }

  #body(hit: Hit, ray: Ray) {
    const view = this.#view
    this.#focus()
    const x = (hit.point.x - view.x) / view.width
    const y = (hit.point.y - view.y) / viewHeight(view)
    const edgeX = Math.abs(x) > 0.463 ? Math.sign(x) : 0
    const edgeY = Math.abs(y) > 0.449 ? Math.sign(y) : 0
    if (edgeX || edgeY) return this.#resize(hit, edgeX, edgeY)

    const drag = xyDrag(view, hit.point, (dx, dy) => {
      if (view.zoom > 1) this.workspace.patch(view.id, panned(view, dx, dy))
    }, moved => {
      if (!moved) this.workspace.patch(view.id, { controls: !view.controls })
    })
    drag.update(ray, 0)
    return drag
  }

  #header(hit: Hit, ray: Ray) {
    this.#focus()
    const uv = hit.uv!
    if (uv.x > 0.928 && uv.y > 0.10 && uv.y < 0.87) {
      this.workspace.close(this.#view.id)
      return
    }
    const x = uv.x < 0.04 ? -1 : uv.x > 0.96 ? 1 : 0
    const y = uv.y > 0.72 ? 1 : 0
    if (x || y) {
      const drag = this.#resize(hit, x, y)
      drag.update(ray, 0)
      return drag
    }
  }

  #move(hit: Hit): Grab {
    this.#focus()
    const view = this.#view
    const delta = new Vector3(view.x, view.y, view.z).sub(hit.point)
    const position = new Vector3()
    let distance = hit.distance
    return {
      update: (ray, depth) => {
        distance = clamp(distance + depth, limits.near, limits.far)
        ray.at(distance, position).add(delta)
        this.workspace.patch(view.id, {
          x: clamp(position.x, -100, 100), y: clamp(position.y, -100, 100),
          z: clamp(position.z, -limits.far, -limits.near),
        })
      },
    }
  }

  #control(hit: Hit, ray: Ray) {
    this.#focus()
    const x = hit.uv!.x * 660
    const y = (1 - hit.uv!.y) * 140
    const media = this.runtime.snapshot()
    if (this.runtime.video && y >= 38 && y <= 87) {
      if (x >= 19 && x <= 83) this.runtime.togglePlayback()
      else if (x >= 321 && x <= 398) this.runtime.mark('start')
      else if (x >= 413 && x <= 490) this.runtime.mark('end')
      else if (x >= 505 && x <= 635) this.workspace.patch(this.#view.id, { muted: !this.#view.muted })
      return
    }
    const seeking = this.runtime.video && y < 36 && media.duration > 0
    const zooming = (!this.runtime.video || y > 93) && x >= 134 && x <= 552
    if (!seeking && !zooming) return
    const panel = this.#controls.mesh
    const plane = new Plane(new Vector3(0, 0, 1), -hit.point.z)
    const point = new Vector3()
    const update = (current: Ray) => {
      if (!current.intersectPlane(plane, point)) return
      const pos = (panel.worldToLocal(point).x + 0.5) * 660
      if (seeking) this.runtime.seek(clamp((pos - 25) / 610, 0, 1) * media.duration)
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

class XRLibrary {
  readonly group = new Group()
  readonly target: Target
  #panel = new Panel(this.group, 720, 772)
  #page = 0
  #buttons: ButtonArea[] = []
  #listing?: DirectoryListing
  #signature = ''
  #dirty = true
  #images = new Map<string, HTMLImageElement>()
  #destroyed = false

  constructor(private readonly workspace: Workspace, private readonly end: Action) {
    this.group.position.set(-1.43, 0.04, -2.47)
    this.group.rotation.y = 0.32
    place(this.#panel.mesh, 0.93, 1, 0, 0)
    this.target = {
      mesh: this.#panel.mesh,
      press: hit => {
        const x = hit.uv!.x * 720
        const y = (1 - hit.uv!.y) * 772
        this.#buttons.find(button => x >= button.x && x <= button.x + button.w && y >= button.y && y <= button.y + button.h)?.run()
      },
    }
  }

  sync() {
    if (!this.group.visible) return
    const state = this.workspace.snapshot()
    const { listing, busy, error, views } = state
    if (this.#listing !== listing) {
      if (this.#listing?.path !== listing.path) this.#page = 0
      this.#listing = listing
      this.#images.clear()
      this.#dirty = true
    }
    const pageCount = Math.max(1, Math.ceil(listing.entries.length / pageSize))
    this.#page = clamp(this.#page, 0, pageCount - 1)
    const signature = JSON.stringify([busy, error, this.#page, ...views.map(view => view.media.path)])
    if (!this.#dirty && signature === this.#signature) return
    this.#signature = signature
    this.#dirty = false
    this.#buttons = []
    this.#panel.paint(ctx => {
      rect(ctx, 0, 0, 720, 5, '#53998f')
      text(ctx, 'File browser', 24, 43, 31, ink, 700)
      this.#button(ctx, 'Exit VR', 575, 21, 121, 42, this.end)
      const parent = listing.path.split('/').slice(0, -1).join('/')
      if (listing.path) {
        this.#button(ctx, 'Root', 24, 84, 91, 40, () => void this.workspace.navigate(''))
        this.#button(ctx, 'Up', 125, 84, 78, 40, () => void this.workspace.navigate(parent))
      }
      const path = listing.path ? `${listing.rootName} / ${listing.path}` : listing.rootName
      const pathX = listing.path ? 221 : 25
      text(ctx, path, pathX, 105, 22, muted, 560, 594 - pathX)
      this.#button(ctx, 'Refresh', 596, 84, 100, 40, () => void this.workspace.navigate(listing.path))
      rect(ctx, 24, 142, 672, 2, line)
      if (error || busy) text(ctx, error || 'Loading…', 25, 169, 20, error ? '#f3c387' : muted, 520, 665)
      if (!listing.entries.length && !busy && !error) {
        text(ctx, 'No media in this folder.', 25, 220, 23, muted, 520, 665)
      }
      listing.entries.slice(this.#page * pageSize, (this.#page + 1) * pageSize).forEach((item, i) => {
        this.#card(ctx, item, i, views.some(view => view.media.path === item.path))
      })
      if (this.#page > 0) this.#button(ctx, 'Previous', 24, 714, 112, 40, () => this.#page--)
      if (this.#page + 1 < pageCount) this.#button(ctx, 'Next', 584, 714, 112, 40, () => this.#page++)
      ctx.textAlign = 'center'
      text(ctx, `${this.#page + 1} / ${pageCount}`, 360, 735, 20, muted)
      ctx.textAlign = 'left'
    })
  }

  dispose() {
    this.#destroyed = true
    this.#images.clear()
    this.#panel.dispose()
    this.#panel.mesh.geometry.dispose()
    this.#panel.mesh.material.dispose()
  }

  #card(ctx: CanvasRenderingContext2D, item: LibraryEntry, index: number, open: boolean) {
    const x = index % 2 === 0 ? 24 : 367
    const y = 189 + Math.floor(index / 2) * 171
    const w = 329
    const h = 155
    rect(ctx, x, y, w, h, open ? '#538378' : line, 8)
    rect(ctx, x + 2, y + 2, w - 4, h - 4, '#1c2939', 7)
    if (item.kind === 'folder') {
      rect(ctx, x + 24, y + 31, 45, 16, '#648d9e', 5)
      rect(ctx, x + 24, y + 41, 73, 44, '#9dbcc7', 5)
      text(ctx, item.name, x + 17, y + 124, 24, ink, 650, w - 32)
      this.#buttons.push({ x, y, w, h, run: () => void this.workspace.navigate(item.path) })
      return
    }
    let image = this.#images.get(item.path)
    if (!image) {
      image = new Image()
      image.onload = () => { if (!this.#destroyed) this.#dirty = true }
      image.src = mediaUrl(item, 'thumbnail')
      this.#images.set(item.path, image)
    }
    rect(ctx, x + 8, y + 8, w - 16, 102, '#293847', 4)
    if (image.complete && image.naturalWidth) {
      const destW = w - 16
      const destH = 102
      const ratio = Math.max(destW / image.naturalWidth, destH / image.naturalHeight)
      const sw = destW / ratio
      const sh = destH / ratio
      ctx.drawImage(image, (image.naturalWidth - sw) / 2, (image.naturalHeight - sh) / 2, sw, sh, x + 8, y + 8, destW, destH)
    }
    if (item.kind === 'video') chip(ctx, '▶', x + w - 54, y + 67, 36, 30)
    text(ctx, item.name, x + 12, y + 132, 23, ink, 550, w - 24)
    this.#buttons.push({ x, y, w, h, run: () => this.workspace.open(item) })
  }

  #button(ctx: CanvasRenderingContext2D, label: string, x: number, y: number, w: number, h: number, run: Action) {
    chip(ctx, label, x, y, w, h)
    this.#buttons.push({ x, y, w, h, run })
  }
}

interface Pointer {
  controller: XRTargetRaySpace
  beam: Line<BufferGeometry, LineBasicMaterial>
  source?: XRInputSource
  grab?: Grab
}

export class XRWorkspace {
  #renderer: WebGLRenderer
  #scene = new Scene()
  #camera = new PerspectiveCamera(55, 1, 0.04, 80)
  #floor = new GridHelper(70, 70, '#396068', '#263746')
  #library: XRLibrary
  #windows = new Map<string, XRWindow>()
  #pointers: Pointer[]
  #raycaster = new Raycaster()
  #targets = new Map<Face, Target>()
  #session?: XRSession
  #previousFrame = 0
  #rotation = new Quaternion()
  #direction = new Vector3()
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
    this.#library = new XRLibrary(workspace, () => {
      if (this.#session) void this.#session.end().catch(() => {})
    })
    this.#scene.add(this.#library.group)
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
    this.#library.dispose()
    for (const panel of this.#windows.values()) panel.dispose()
    for (const { beam, grab } of this.#pointers) {
      grab?.finish?.(false)
      beam.geometry.dispose()
      beam.material.dispose()
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
    controller.add(beam)
    this.#scene.add(controller)
    const pointer: Pointer = { controller, beam }
    controller.addEventListener('connected', event => {
      pointer.source = event.data
      beam.visible = true
    })
    controller.addEventListener('disconnected', () => {
      pointer.grab?.finish?.(false)
      pointer.grab = undefined
      pointer.source = undefined
      beam.visible = false
    })
    controller.addEventListener('selectstart', () => {
      if (!pointer.source || pointer.grab) return
      this.#sync()
      const hit = this.#hit(pointer)
      if (!hit) return
      pointer.grab = this.#targets.get(hit.object)?.press(hit, this.#raycaster.ray) || undefined
    })
    controller.addEventListener('selectend', () => {
      if (pointer.grab) {
        this.#setRay(pointer)
        pointer.grab.update(this.#raycaster.ray, 0)
        pointer.grab.finish?.(true)
        pointer.grab = undefined
        this.workspace.save()
      }
    })
    controller.addEventListener('squeezestart', () => {
      const library = this.#library.group
      library.visible = !library.visible
      if (!library.visible) return
      const pose = this.#renderer.xr.getCamera()
      const forward = pose.getWorldDirection(new Vector3()).setY(0).normalize()
      if (!forward.lengthSq()) return
      const side = new Vector3(-forward.z, 0, forward.x)
      library.position.copy(pose.getWorldPosition(new Vector3()))
        .addScaledVector(forward, 2.47).addScaledVector(side, -1.43)
      library.rotation.y = Math.atan2(-forward.x, -forward.z) + 0.32
    })
    return pointer
  }

  #sync() {
    const { views, selected } = this.workspace.snapshot()
    const wanted = new Set(views.map(view => view.id))
    for (const [id, panel] of this.#windows) {
      const exists = wanted.has(id)
      if (exists && panel.runtime === this.workspace.runtime(id)) continue
      panel.dispose()
      this.#windows.delete(id)
    }
    this.#targets.clear()
    for (const view of views) {
      let panel = this.#windows.get(view.id)
      if (!panel) {
        panel = new XRWindow(this.workspace, view, this.workspace.runtime(view.id))
        this.#windows.set(view.id, panel)
        this.#scene.add(panel.group)
      }
      panel.sync(view, selected === view.id)
      for (const target of panel.targets) if (target.mesh.visible) this.#targets.set(target.mesh, target)
    }
    this.#library.sync()
    if (this.#library.group.visible) this.#targets.set(this.#library.target.mesh, this.#library.target)
    this.#scene.updateMatrixWorld()
  }

  #frame = (time: number) => {
    const dt = this.#previousFrame ? clamp((time - this.#previousFrame) / 1000, 0, 0.05) : 0
    this.#previousFrame = time
    this.#sync()
    for (const pointer of this.#pointers) {
      if (!pointer.source || !pointer.controller.visible) continue
      const hit = this.#hit(pointer)
      const axes = pointer.source.gamepad?.axes
      const y = axes?.[3] ?? axes?.[1] ?? 0
      pointer.grab?.update(this.#raycaster.ray, Math.abs(y) > 0.2 ? y * dt * 2.2 : 0)
      const positions = pointer.beam.geometry.getAttribute('position')
      positions.setZ(1, -(hit?.distance ?? 4.0))
      positions.needsUpdate = true
      pointer.beam.material.opacity = hit ? 0.82 : 0.27
    }
    this.#renderer.render(this.#scene, this.#camera)
  }

  #setRay(pointer: Pointer) {
    pointer.controller.getWorldPosition(this.#raycaster.ray.origin)
    pointer.controller.getWorldQuaternion(this.#rotation)
    this.#direction.set(0, 0, -1).applyQuaternion(this.#rotation)
    this.#raycaster.ray.direction.copy(this.#direction)
  }

  #hit(pointer: Pointer): Hit | undefined {
    this.#setRay(pointer)
    return this.#raycaster.intersectObjects([...this.#targets.keys()], false)[0] as Hit | undefined
  }
}
