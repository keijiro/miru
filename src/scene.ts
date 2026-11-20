import {
  BufferAttribute, BufferGeometry, Color, Fog, GridHelper, Line, LineBasicMaterial,
  Mesh, MeshBasicMaterial, PerspectiveCamera, Raycaster, Scene,
  SphereGeometry, Vector2, Vector3, WebGLRenderer, type XRTargetRaySpace,
} from 'three'
import { mint, SceneWindow, windowTitleHeight, type Face, type Grab, type Hit, type Target } from './scene-window'
import { clamp, windowDefaults, type Workspace } from './workspace'

const controllerSmoothingTime = 0.035 // Seconds
const stageBase = (width: number, height: number) => Math.min(width * 0.96, height * 1.6)

interface ActiveGrab {
  panel: SceneWindow
  action: Grab
}

interface Pointer {
  controller: XRTargetRaySpace
  beam: Line<BufferGeometry, LineBasicMaterial>
  cursor: Mesh<SphereGeometry, MeshBasicMaterial>
  source?: XRInputSource
  grab?: ActiveGrab
}

export class WorkspaceScene {
  #renderer: WebGLRenderer
  #scene = new Scene()
  #xrCamera = new PerspectiveCamera(55, 1, 0.04, 80)
  #desktopCamera = new PerspectiveCamera(55, 1, 0.04, 80)
  #viewerPosition = new Vector3()
  #floor = new GridHelper(70, 70, '#396068', '#263746')
  #windows = new Map<string, SceneWindow>()
  #pointers: Pointer[]
  #raycaster = new Raycaster()
  #targets = new Map<Face, Target>()
  #size = new Vector2(1, 1)
  #rendererSize = new Vector2()
  #mouse?: ActiveGrab & { id: number }
  #resize: ResizeObserver
  #events = new AbortController()
  #previousFrame = 0

  constructor(private readonly workspace: Workspace, container: HTMLElement) {
    const canvas = document.createElement('canvas')
    // Request XR compatibility up front to avoid context loss when entering PC VR.
    const context = canvas.getContext('webgl2', { xrCompatible: true, antialias: true, alpha: false })
    if (!context) throw new Error('Could not create a WebGL 2 context.')
    this.#renderer = new WebGLRenderer({ canvas, context })
    this.#renderer.xr.enabled = true
    this.#renderer.xr.setReferenceSpaceType('local')
    canvas.setAttribute('aria-label', 'Media workspace')
    container.append(canvas)
    this.#resize = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      this.#size.set(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)))
    })
    this.#resize.observe(container)

    this.#scene.background = new Color('#0c1420')
    this.#scene.fog = new Fog('#0c1420', 7, 25)
    this.#floor.position.y = -1.58
    this.#scene.add(this.#floor)
    this.#pointers = [0, 1].map(index => this.#createPointer(index))
    const options = { signal: this.#events.signal }
    canvas.addEventListener('pointerdown', this.#mouseDown, options)
    canvas.addEventListener('pointermove', this.#mouseMove, options)
    canvas.addEventListener('pointerup', this.#mouseUp, options)
    canvas.addEventListener('pointercancel', this.#mouseCancel, options)
    canvas.addEventListener('lostpointercapture', this.#mouseCancel, options)
    canvas.addEventListener('wheel', this.#wheel, { ...options, passive: false })
    this.#renderer.setAnimationLoop(this.#frame)
  }

  async start(session: XRSession) {
    this.#finishMouse(false)
    this.#previousFrame = 0
    this.#viewerPosition.set(0, 0, 0)
    await this.#renderer.xr.setSession(session)
  }

  fit() {
    if (this.#renderer.xr.getSession()) return
    this.#sync(false)
    if (!this.#windows.size) return
    const { x: width, y: height } = this.#size
    const bounds = [...this.#windows.values()].map(panel => panel.desktopBounds)
    const left = Math.min(...bounds.map(box => box.left))
    const right = Math.max(...bounds.map(box => box.right))
    const bottom = Math.min(...bounds.map(box => box.bottom))
    const top = Math.max(...bounds.map(box => box.top))
    const scale = 0.84 * Math.min(width / (right - left), height / (top - bottom))
    this.workspace.setCamera({
      x: (left + right) / 2, y: (bottom + top) / 2,
      zoom: clamp(scale / stageBase(width, height), 0.002, 1.5),
    })
  }

  dispose() {
    this.#renderer.setAnimationLoop(null)
    this.#finishMouse(false)
    this.#events.abort()
    this.#resize.disconnect()
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

  #updateDesktopCamera() {
    const { x: width, y: height } = this.#size
    const pixelRatio = Math.min(window.devicePixelRatio, 2)
    if (pixelRatio !== this.#renderer.getPixelRatio()) this.#renderer.setPixelRatio(pixelRatio)
    if (!this.#renderer.getSize(this.#rendererSize).equals(this.#size)) this.#renderer.setSize(width, height, false)
    const { x, y, zoom } = this.workspace.snapshot().camera
    const camera = this.#desktopCamera
    const scale = stageBase(width, height) * zoom
    // Saved desktop camera offsets are expressed on the projection plane at z = -1.
    camera.zoom = 2 * Math.tan(camera.fov * Math.PI / 360) * scale / height
    camera.setViewOffset(width, height, x * scale, -y * scale, width, height)
  }

  #mouseRay(event: MouseEvent) {
    const { left, top, width, height } = this.#renderer.domElement.getBoundingClientRect()
    const ndc = new Vector2(2 * (event.clientX - left) / width - 1, 1 - 2 * (event.clientY - top) / height)
    this.#raycaster.setFromCamera(ndc, this.#desktopCamera)
    return this.#raycaster.ray
  }

  #mouseDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary || this.#mouse || this.#renderer.xr.getSession()) return
    this.#updateDesktopCamera()
    this.#sync(false)
    const ray = this.#mouseRay(event)
    const hit = this.#pick()
    if (!hit) {
      const { width, height, depth } = windowDefaults
      const position = ray.at(-depth / ray.direction.z, new Vector3())
      const min = new Vector2()
      const max = new Vector2()
      this.#desktopCamera.getViewBounds(depth, min, max)
      const halfWidth = Math.min(width / 2, (max.x - min.x) / 2)
      const halfHeight = Math.min(height / 2, (max.y - min.y) / 2)
      this.workspace.create({
        x: clamp(position.x, min.x + halfWidth, max.x - halfWidth),
        y: clamp(position.y, min.y + halfHeight, Math.max(min.y + halfHeight, max.y - halfHeight - windowTitleHeight)),
        z: -depth,
      })
      return
    }
    const target = this.#targets.get(hit.object)!
    const action = target.press(hit, ray)
    if (action) {
      this.#mouse = { panel: target.panel, action, id: event.pointerId }
      this.#renderer.domElement.setPointerCapture(event.pointerId)
    }
  }

  #mouseMove = (event: PointerEvent) => {
    if (this.#mouse?.id === event.pointerId) {
      this.#mouse.action.update(this.#mouseRay(event), 0)
    }
  }

  #mouseUp = (event: PointerEvent) => {
    if (this.#mouse?.id !== event.pointerId) return
    this.#mouseMove(event)
    this.#finishMouse(true)
  }

  #mouseCancel = (event: PointerEvent) => {
    if (this.#mouse?.id === event.pointerId) this.#finishMouse(false)
  }

  #finishMouse(commit: boolean) {
    const grab = this.#mouse
    if (!grab) return
    this.#mouse = undefined
    const canvas = this.#renderer.domElement
    if (canvas.hasPointerCapture(grab.id)) canvas.releasePointerCapture(grab.id)
    this.#finish(grab, commit)
  }

  #wheel = (event: WheelEvent) => {
    if (!event.altKey || this.#mouse || this.#renderer.xr.getSession()) return
    this.#updateDesktopCamera()
    this.#sync(false)
    this.#mouseRay(event)
    const hit = this.#pick()
    const panel = hit && this.#targets.get(hit.object)?.panel
    const id = panel?.id ?? this.workspace.snapshot().selected
    if (!id) return
    event.preventDefault()
    const delta = event.deltaY * (event.deltaMode === 0 ? 0.004 : 0.08)
    this.workspace.depth(id, clamp(delta, -0.9, 0.9))
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
    controller.addEventListener('selectstart', () => this.#press(pointer))
    controller.addEventListener('selectend', () => this.#finishGrab(pointer, controller.visible))
    return pointer
  }

  #press(pointer: Pointer) {
    if (!pointer.source || !pointer.controller.visible || pointer.grab) return
    // Use the same filtered pose as the displayed ray.
    if (!pointer.beam.visible) this.#filterPose(pointer, 1)
    this.#sync(true)
    const hit = this.#hit(pointer)
    const target = hit && this.#targets.get(hit.object)
    if (!hit || !target) {
      const { x, y, z } = this.#raycaster.ray.at(windowDefaults.depth, new Vector3())
      this.workspace.create({ x, y, z })
      return
    }
    const { panel } = target
    if (this.#pointers.some(other => other.grab?.panel === panel)) return
    const action = target.press(hit, this.#raycaster.ray)
    if (action) pointer.grab = { panel, action }
  }

  #end = () => { void this.#renderer.xr.getSession()?.end().catch(() => {}) }

  #finishGrab(pointer: Pointer, commit: boolean) {
    const grab = pointer.grab
    if (!grab) return
    pointer.grab = undefined
    this.#finish(grab, commit)
  }

  #finish(grab: ActiveGrab, commit: boolean) {
    grab.action.finish?.(commit)
    if (commit) this.workspace.save()
  }

  #cancelGrabs(panel: SceneWindow) {
    if (this.#mouse?.panel === panel) this.#finishMouse(false)
    for (const pointer of this.#pointers) if (pointer.grab?.panel === panel) this.#finishGrab(pointer, false)
  }

  #sync(immersive: boolean) {
    const { views, selected } = this.workspace.snapshot()
    const wanted = new Set(views.map(view => view.id))
    for (const [id, panel] of this.#windows) {
      if (wanted.has(id)) continue
      this.#cancelGrabs(panel)
      panel.dispose()
      this.#windows.delete(id)
    }
    this.#targets.clear()
    for (const [index, view] of views.entries()) {
      const runtime = this.workspace.runtime(view.id)
      let panel = this.#windows.get(view.id)
      if (!panel) {
        panel = new SceneWindow(this.workspace, view, this.#end)
        this.#windows.set(view.id, panel)
        this.#scene.add(panel.group)
      }
      if (panel.runtime !== runtime) this.#cancelGrabs(panel)
      const focused = selected === view.id
      // Desktop windows created at the same depth still need a deterministic stacking order.
      panel.group.renderOrder = immersive ? 0 : focused ? views.length + 1 : index + 1
      panel.sync(view, focused, runtime, immersive)
      if (immersive) panel.group.lookAt(this.#viewerPosition)
      for (const target of panel.targets) if (target.mesh.visible) this.#targets.set(target.mesh, target)
    }
    this.#scene.updateMatrixWorld()
  }

  #frame = (time: number, frame?: XRFrame) => {
    const immersive = this.#renderer.xr.isPresenting
    if (!immersive && this.#renderer.xr.getSession()) return
    if (immersive && frame) {
      // Use the headset center in the same reference space as the controller rays.
      const referenceSpace = this.#renderer.xr.getReferenceSpace()
      const pose = referenceSpace && frame.getViewerPose(referenceSpace)
      if (pose) {
        const { x, y, z } = pose.transform.position
        this.#viewerPosition.set(x, y, z)
      }
    }
    this.#sync(immersive)
    if (immersive) this.#updatePointers(time)
    else this.#updateDesktopCamera()
    this.#renderer.render(this.#scene, immersive ? this.#xrCamera : this.#desktopCamera)
  }

  #updatePointers(time: number) {
    const dt = this.#previousFrame ? clamp((time - this.#previousFrame) / 1000, 0, 0.05) : 0
    const alpha = 1 - Math.exp(-dt / controllerSmoothingTime)
    this.#previousFrame = time
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
      pointer.grab?.action.update(this.#raycaster.ray, depth)
      const positions = pointer.beam.geometry.getAttribute('position')
      positions.setZ(1, -(hit?.distance ?? windowDefaults.depth))
      positions.needsUpdate = true
      pointer.beam.material.opacity = hit ? 0.82 : 0.27
      pointer.cursor.visible = !hit && !pointer.grab
      if (pointer.cursor.visible) this.#raycaster.ray.at(windowDefaults.depth, pointer.cursor.position)
    }
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
    return this.#pick()
  }

  #pick() {
    const hits = this.#raycaster.intersectObjects([...this.#targets.keys()], false) as Hit[]
    const first: Hit | undefined = hits[0]
    if (!first) return
    let nearest = first
    for (const hit of hits) {
      if (hit.distance - first.distance > 1e-8) break
      if (hit.object.parent!.renderOrder > nearest.object.parent!.renderOrder) nearest = hit
    }
    return nearest
  }
}
