import {
  BufferAttribute, BufferGeometry, Color, Fog, GridHelper, Line, LineBasicMaterial,
  Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera, Raycaster, Scene,
  SphereGeometry, Vector2, Vector3, WebGLRenderer, type Ray, type XRTargetRaySpace,
} from 'three'
import { Panorama } from './panorama'
import { SceneWindow, windowGripReach, type Face, type Grab, type Hit, type WindowPart } from './scene-window'
import { uiColors } from './ui-style'
import { clamp, limits, windowDefaults, type Workspace } from './workspace'
import { videoLayerUnavailable, XrVideoLayers } from './xr-video-layers'

const controllerSmoothingTime = 0.035 // Seconds
const cameraFov = 55
const fogStart = 7
const fogFalloff = 18

interface PickedPart {
  panel: SceneWindow
  part: WindowPart
}

interface ActiveGrab extends PickedPart {
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
  #fog = new Fog(uiColors.background, fogStart, fogStart + fogFalloff)
  #xrCamera = new PerspectiveCamera(cameraFov, 1, 0.04, 80)
  #desktopCamera = this.#xrCamera.clone()
  #headPosition = new Vector3()
  #headForward = new Vector3()
  #headYaw = 0
  #needsDesktopFit = true
  #floor = new GridHelper(70, 70, uiColors.active, uiColors.control)
  #panorama = new Panorama(this.#scene)
  #windows = new Map<string, SceneWindow>()
  #pointers: Pointer[]
  #raycaster = new Raycaster()
  #targets = new Map<Face, SceneWindow>()
  #size = new Vector2(1, 1)
  #rendererSize = new Vector2()
  #mouse?: ActiveGrab & { id: number }
  #mousePosition?: Pick<MouseEvent, 'clientX' | 'clientY'>
  #resize: ResizeObserver
  #events = new AbortController()
  #previousFrame = 0
  #videoLayers?: XrVideoLayers

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

    this.#scene.background = new Color(uiColors.background)
    this.#scene.fog = this.#fog
    this.#floor.position.y = -1.58
    this.#scene.add(this.#floor)
    this.#pointers = [0, 1].map(index => this.#createPointer(index))
    const options = { signal: this.#events.signal }
    canvas.addEventListener('pointerdown', this.#mouseDown, options)
    canvas.addEventListener('pointerenter', this.#mouseMove, options)
    canvas.addEventListener('pointermove', this.#mouseMove, options)
    canvas.addEventListener('pointerleave', this.#mouseLeave, options)
    canvas.addEventListener('pointerup', this.#mouseUp, options)
    canvas.addEventListener('pointercancel', this.#mouseCancel, options)
    canvas.addEventListener('lostpointercapture', this.#mouseCancel, options)
    canvas.addEventListener('wheel', this.#wheel, { ...options, passive: false })
    this.#renderer.setAnimationLoop(this.#frame)
  }

  async start(session: XRSession) {
    this.#finishMouse(false)
    this.#mouseLeave()
    this.#previousFrame = 0
    this.#headPosition.set(0, 0, 0)
    this.#headYaw = 0
    this.#needsDesktopFit = true
    await this.#renderer.xr.setSession(session)
    if (this.#renderer.xr.getSession() !== session) return
    const layers = XrVideoLayers.create(session, this.#renderer.xr.getBaseLayer(), this.#renderer.xr.getReferenceSpace())
    if (layers) {
      this.#videoLayers = layers
      session.addEventListener('end', () => {
        if (this.#videoLayers === layers) this.#videoLayers = undefined
        layers.dispose()
      }, { once: true })
    }
  }

  fit() {
    if (this.#renderer.xr.getSession()) return
    this.#updateDesktopCamera()
    this.#sync(false)
    this.#fitDesktopWindows()
  }

  #fitDesktopWindows() {
    if (!this.#windows.size) return
    const bounds = Array.from(this.#windows.values(), panel => {
      const { x, y, z } = panel.group.position
      return { x, y, z, radius: panel.radius }
    })
    const x = (Math.min(...bounds.map(b => b.x - b.radius)) + Math.max(...bounds.map(b => b.x + b.radius))) / 2
    const y = (Math.min(...bounds.map(b => b.y - b.radius)) + Math.max(...bounds.map(b => b.y + b.radius))) / 2
    const { x: slopeX, y: slopeY } = this.#desktopCamera.getViewSize(1, new Vector2()).multiplyScalar(0.42)
    // Fit each window's bounding sphere inside the padded frustum even as it turns to face the camera.
    const z = Math.max(windowDefaults.depth - limits.far, ...bounds.map(b => b.z + Math.max(
      (Math.abs(b.x - x) + b.radius * Math.hypot(1, slopeX)) / slopeX,
      (Math.abs(b.y - y) + b.radius * Math.hypot(1, slopeY)) / slopeY,
      b.radius + this.#desktopCamera.near,
    )))
    this.workspace.setCamera({ x, y, z })
  }

  dispose() {
    this.#renderer.setAnimationLoop(null)
    this.#finishMouse(false)
    this.#events.abort()
    this.#resize.disconnect()
    this.#videoLayers?.dispose()
    this.#videoLayers = undefined
    this.#panorama.dispose()
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
    const position = this.workspace.snapshot().camera
    const camera = this.#desktopCamera
    if (position) camera.position.set(position.x, position.y, position.z)
    camera.aspect = width / height
    // Widen the view on narrow screens so a new window fits across the canvas.
    camera.zoom = Math.min(1, camera.aspect * 1.92 * Math.tan(camera.fov * Math.PI / 360))
    camera.far = Math.max(80, camera.position.z + limits.far + limits.maxHeight)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
  }

  #mouseRay(event: Pick<MouseEvent, 'clientX' | 'clientY'>) {
    const { left, top, width, height } = this.#renderer.domElement.getBoundingClientRect()
    const ndc = new Vector2(2 * (event.clientX - left) / width - 1, 1 - 2 * (event.clientY - top) / height)
    this.#raycaster.setFromCamera(ndc, this.#desktopCamera)
    const { ray } = this.#raycaster
    this.#raycaster.near = this.#desktopCamera.near / -ray.direction.z
    this.#raycaster.far = this.#desktopCamera.far / -ray.direction.z
    return ray
  }

  #createDesktopWindow(ray: Ray) {
    const { width, height } = windowDefaults
    const camera = this.#desktopCamera
    const eye = camera.position
    const z = Math.min(eye.z - windowDefaults.depth, limits.far)
    const center = new Vector3(eye.x, eye.y, z)
    const position = ray.at((z - eye.z) / ray.direction.z, new Vector3())
    position.set(clamp(position.x, -100, 100), clamp(position.y, -100, 100), z)

    const rotation = new Matrix4()
    const corner = new Vector3()
    const fits = (point: Vector3) => {
      rotation.lookAt(eye, point, camera.up)
      for (const x of [-width / 2 - windowGripReach, width / 2 + windowGripReach]) {
        for (const y of [-height / 2 - windowGripReach, height / 2 + windowGripReach]) {
          corner.set(x, y, 0).applyMatrix4(rotation).add(point).project(camera)
          if (Math.abs(corner.x) > 0.98 || Math.abs(corner.y) > 0.98 || corner.z >= 1) return false
        }
      }
      return true
    }
    // Pull the window inward at the viewport edge to accommodate its angle.
    if (!fits(position)) {
      const point = new Vector3()
      let inside = 0
      let outside = 1
      for (let step = 0; step < 10; step++) {
        const t = (inside + outside) / 2
        if (fits(point.lerpVectors(center, position, t))) inside = t
        else outside = t
      }
      position.lerpVectors(center, position, inside)
    }
    this.workspace.create(position)
  }

  #mouseDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary || this.#mouse || this.#renderer.xr.getSession()) return
    this.#updateDesktopCamera()
    this.#sync(false)
    this.#mousePosition = { clientX: event.clientX, clientY: event.clientY }
    const ray = this.#mouseRay(event)
    const picked = this.#pick()
    if (!picked) {
      this.#createDesktopWindow(ray)
      return
    }
    const { panel, part, hit } = picked
    const action = panel.press(part, hit, ray)
    if (action) {
      this.#mouse = { panel, part, action, id: event.pointerId }
      this.#renderer.domElement.setPointerCapture(event.pointerId)
    }
  }

  #mouseMove = (event: PointerEvent) => {
    if (event.isPrimary) this.#mousePosition = { clientX: event.clientX, clientY: event.clientY }
    if (this.#mouse?.id === event.pointerId) {
      this.#mouse.action.update(this.#mouseRay(event), 0)
    }
  }

  #mouseLeave = () => {
    this.#mousePosition = undefined
    this.#renderer.domElement.style.cursor = ''
  }

  #updateMouseHover() {
    let picked: PickedPart | undefined = this.#mouse
    if (!picked && this.#mousePosition) {
      const { clientX, clientY } = this.#mousePosition
      const bounds = this.#renderer.domElement.getBoundingClientRect()
      if (clientX >= bounds.left && clientX <= bounds.right && clientY >= bounds.top && clientY <= bounds.bottom) {
        this.#mouseRay(this.#mousePosition)
        picked = this.#pick()
      }
    }
    let cursor = ''
    if (picked) {
      const { panel, part } = picked
      panel.highlight(part)
      if (typeof part === 'object' && part.kind === 'grip') {
        cursor = part.x && part.y
          ? (part.x === part.y ? 'nesw-resize' : 'nwse-resize')
          : (this.#mouse ? 'grabbing' : 'grab')
      } else if (part === 'back' || typeof part === 'object') cursor = 'pointer'
    }
    const style = this.#renderer.domElement.style
    if (style.cursor !== cursor) style.cursor = cursor
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
    const panel = this.#pick()?.panel
    const id = panel?.id ?? this.workspace.snapshot().selected
    if (!id) return
    event.preventDefault()
    const delta = event.deltaY * (event.deltaMode === 0 ? 0.004 : 0.08)
    this.workspace.depth(id, clamp(delta, -0.9, 0.9), this.#desktopCamera.position.z)
  }

  #createPointer(index: number): Pointer {
    const controller = this.#renderer.xr.getController(index)
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 0, 0, -1]), 3))
    const beam = new Line(geometry, new LineBasicMaterial({ color: uiColors.accent, transparent: true, opacity: 0.8 }))
    beam.frustumCulled = false
    beam.visible = false
    const cursor = new Mesh(new SphereGeometry(0.005, 12, 8), new MeshBasicMaterial({ color: uiColors.accent, toneMapped: false }))
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
    const picked = this.#point(pointer)
    if (!picked) {
      const { x, y, z } = this.#raycaster.ray.at(windowDefaults.depth, new Vector3())
      this.workspace.create({ x, y, z })
      return
    }
    const { panel, part, hit } = picked
    if (this.#pointers.some(other => other.grab?.panel === panel)) return
    const action = panel.press(part, hit, this.#raycaster.ray)
    if (action) pointer.grab = { panel, part, action }
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
    const eye = immersive ? this.#headPosition : this.#desktopCamera.position
    let fogNear = fogStart
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
      // Desktop windows created at the same depth still need a deterministic stacking order.
      panel.group.renderOrder = immersive ? 0 : selected === view.id ? views.length + 1 : index + 1
      panel.sync(view, runtime, immersive)
      panel.group.lookAt(eye)
      if (!immersive) fogNear = Math.max(fogNear, eye.z - view.z + panel.radius)
      for (const target of panel.targets) if (target.visible) this.#targets.set(target, panel)
    }
    // Keep desktop windows readable after Fit all pulls the camera back.
    this.#fog.near = fogNear
    this.#fog.far = fogNear + fogFalloff
    this.#scene.updateMatrixWorld()
  }

  #frame = (time: number, frame?: XRFrame) => {
    const immersive = this.#renderer.xr.isPresenting
    if (!immersive && this.#renderer.xr.getSession()) return
    let pose: XRViewerPose | null = null
    if (immersive && frame) {
      // Use the headset center in the same reference space as the controller rays.
      const referenceSpace = this.#renderer.xr.getReferenceSpace()
      pose = (referenceSpace && frame.getViewerPose(referenceSpace)) ?? null
      if (pose) {
        const { x, y, z } = pose.transform.position
        this.#headPosition.set(x, y, z)
        const forward = this.#headForward.set(0, 0, -1).applyQuaternion(pose.transform.orientation)
        if (Math.hypot(forward.x, forward.z) > 0.001) this.#headYaw = Math.atan2(-forward.x, -forward.z)
      }
    }
    if (!immersive) this.#updateDesktopCamera()
    this.#sync(immersive)
    if (immersive) this.#updatePointers(time)
    else if (this.#needsDesktopFit && this.#size.x > 1 && this.#size.y > 1) {
      this.#needsDesktopFit = false
      const { camera, views } = this.workspace.snapshot()
      if (!camera || views.some(view => view.z >= this.#desktopCamera.position.z - this.#desktopCamera.near)) {
        this.#fitDesktopWindows()
        this.#updateDesktopCamera()
        this.#sync(false)
      }
    }
    if (!immersive) this.#updateMouseHover()
    for (const panel of this.#windows.values()) panel.updateAffordances()
    const { panorama } = this.workspace.snapshot()
    let nativePanorama: number | null = null
    if (immersive) {
      if (this.#videoLayers) {
        nativePanorama = this.#videoLayers.sync(this.#windows.values(), pose, panorama, this.#headYaw)
      } else {
        for (const panel of this.#windows.values()) if (panel.videoPlane) panel.setVideoLayer(undefined, videoLayerUnavailable)
      }
    }
    const texture = !immersive && panorama !== null ? this.#windows.get(panorama)?.videoTexture : undefined
    this.#panorama.sync(texture, nativePanorama)
    this.#floor.visible = !texture && nativePanorama === null
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
      const picked = this.#point(pointer)
      const active = pointer.grab ?? picked
      if (active) active.panel.highlight(active.part)
      const hit = picked?.hit
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

  #point(pointer: Pointer) {
    const { ray } = this.#raycaster
    this.#raycaster.near = 0
    this.#raycaster.far = Infinity
    ray.origin.copy(pointer.beam.position)
    ray.direction.set(0, 0, -1).applyQuaternion(pointer.beam.quaternion)
    return this.#pick()
  }

  #pick() {
    const hits = this.#raycaster.intersectObjects([...this.#targets.keys()], false) as Hit[]
    let nearest: (PickedPart & { hit: Hit }) | undefined
    for (const hit of hits) {
      if (nearest && hit.distance - nearest.hit.distance > 1e-8) break
      const panel = this.#targets.get(hit.object)!
      const part = panel.part(hit)
      if (!part) continue
      if (!nearest || panel.group.renderOrder > nearest.panel.group.renderOrder) nearest = { panel, part, hit }
    }
    return nearest
  }
}
