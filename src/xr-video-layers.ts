import {
  Box2, Matrix4, NoBlending, Quaternion, ShaderMaterial, UniformsLib, UniformsUtils, Vector2, Vector3, Vector4,
  type BufferAttribute,
} from 'three'
import type { NativePanorama } from './panorama'
import type { Face, SceneWindow } from './scene-window'

const viewport = new Box2(new Vector2(-1, -1), new Vector2(1, 1))
const cornerSigns = [-1, 1]

interface Plane {
  center: Vector3
  width: number
  height: number
}

interface VideoWindow {
  panel: SceneWindow
  mesh: Face
  video: HTMLVideoElement
}

interface Candidate extends VideoWindow {
  plane: Plane
  orientation: Quaternion
  distanceSquared: number
}

interface Entry {
  panel: SceneWindow
  layer: XRQuadLayer
  matrix: Matrix4
  uvVersion: number
  distanceSquared: number
}

export class XrVideoLayers {
  #entries = new Map<HTMLVideoElement, Entry>()
  #panoramas = new Map<HTMLVideoElement, { layer: XREquirectLayer }>()
  #unavailable = new WeakSet<HTMLVideoElement>()
  #panoramaUnavailable = new WeakSet<HTMLVideoElement>()
  #submitted: XRLayer[] = []
  #panoramaVideo?: HTMLVideoElement
  #panoramaLoopFrame?: HTMLCanvasElement
  #available = true
  #limit: number
  #projectionAlpha: boolean
  // Quest treats quad dimensions as half extents. https://github.com/immersive-web/layers/issues/324
  #quadScale = /\bOculusBrowser\//.test(navigator.userAgent) ? 0.5 : 1
  #corner = new Vector3()
  #clip = new Vector4()
  #ndc = new Vector2()
  #mask = new ShaderMaterial({
    blending: NoBlending,
    fog: true,
    uniforms: UniformsUtils.clone(UniformsLib.fog),
    vertexShader: `
      #include <fog_pars_vertex>
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: `
      #include <fog_pars_fragment>
      void main() {
        gl_FragColor = vec4(0.0);
        #include <fog_fragment>
        #ifdef USE_FOG
          gl_FragColor.a = fogFactor;
        #endif
      }
    `,
  })

  static create(session: XRSession, base: XRWebGLLayer | XRProjectionLayer | null, space: XRReferenceSpace | null) {
    if (typeof XRMediaBinding !== 'function' || !base || !('blendTextureSourceAlpha' in base) || !space) return
    try {
      return new XrVideoLayers(session, base, space, new XRMediaBinding(session))
    } catch {
      // Support for the layers feature does not guarantee that a media binding can be created.
    }
  }

  private constructor(
    private readonly session: XRSession,
    private readonly projection: XRProjectionLayer,
    private readonly space: XRReferenceSpace,
    private readonly binding: XRMediaBinding,
  ) {
    const { maxRenderLayers } = session as XRSession & { maxRenderLayers?: number }
    this.#limit = maxRenderLayers === undefined ? Infinity : Math.max(0, maxRenderLayers - 1)
    this.#projectionAlpha = projection.blendTextureSourceAlpha
  }

  sync(panels: Iterable<SceneWindow>, pose: XRViewerPose | null, panoramaId: string | null, yaw: number): NativePanorama | undefined {
    const windows: VideoWindow[] = []
    for (const panel of panels) {
      const video = panel.runtime?.video
      const mesh = panel.videoPlane
      if (mesh && video) windows.push({ panel, mesh, video })
    }

    const source = windows.find(({ panel }) => panel.id === panoramaId)
    const loopFrame = source?.panel.runtime?.loopFrame
    const panorama = this.#panorama(source?.video, yaw, Boolean(loopFrame))
    const candidates: Candidate[] = []
    if (pose?.views.length) {
      const matrices = pose.views.map(view => new Matrix4().fromArray(view.projectionMatrix)
        .multiply(new Matrix4().fromArray(view.transform.inverse.matrix)))
      const { x, y, z } = pose.transform.position
      const viewer = new Vector3(x, y, z)
      for (const window of windows) {
        const { panel, video } = window
        // Keep an existing layer assigned while its window shows the frame before the loop.
        if (video.readyState < video.HAVE_CURRENT_DATA && !(panel.runtime?.loopFrame && this.#entries.has(video))) continue
        const candidate = this.#candidate(window, matrices, viewer)
        if (candidate) candidates.push(candidate)
      }
    }

    // Give the available layers to playing videos first, starting with the largest source frames.
    candidates.sort((a, b) => Number(a.video.paused) - Number(b.video.paused) ||
      b.video.videoWidth * b.video.videoHeight - a.video.videoWidth * a.video.videoHeight)
    const next: Entry[] = []
    for (const candidate of candidates) {
      if (!this.#available || next.length + Number(Boolean(panorama)) >= this.#limit) break
      if (this.#unavailable.has(candidate.video) || (candidate.panel === source?.panel && !panorama)) continue
      const entry = this.#entry(candidate)
      if (!entry) continue
      next.push(entry)
    }

    const scheduledPanorama = this.#submit(next, panorama)
    const active = this.session.renderState.layers ?? []
    const removing = active.some(layer => layer !== this.projection && !this.#submitted.includes(layer))
    const scheduled = new Map(next.map(({ panel, layer }) => [panel, layer]))
    for (const { panel } of windows) {
      const layer = scheduled.get(panel)
      // The render state is applied on the next XR frame. During removal, keep windows opaque
      // until a retired layer can no longer show through a different window.
      const showNative = layer && !removing && active.includes(layer) && !panel.runtime?.loopFrame
      panel.setVideoLayer(showNative ? this.#mask : undefined, !layer)
    }
    for (const entries of [this.#entries, this.#panoramas]) {
      for (const [video, { layer }] of entries) {
        if (this.#submitted.includes(layer) || active.includes(layer)) continue
        layer.destroy()
        entries.delete(video)
      }
    }
    if (!scheduledPanorama) {
      this.#panoramaLoopFrame = undefined
      return
    }
    const showNative = !loopFrame && !removing && active.includes(scheduledPanorama)
    // Hold the frame until the native panorama can safely be shown through the projection.
    this.#panoramaLoopFrame = showNative ? undefined : loopFrame ?? this.#panoramaLoopFrame
    if (showNative || this.#panoramaLoopFrame) return { loopFrame: this.#panoramaLoopFrame }
  }

  dispose() {
    for (const entries of [this.#entries, this.#panoramas]) {
      for (const { layer } of entries.values()) layer.destroy()
      entries.clear()
    }
    this.#submitted = []
    this.#mask.dispose()
  }

  #candidate(window: VideoWindow, matrices: Matrix4[], viewer: Vector3): Candidate | undefined {
    const { mesh } = window
    const center = new Vector3()
    const orientation = new Quaternion()
    const size = new Vector3()
    mesh.matrixWorld.decompose(center, orientation, size)
    const width = size.x * mesh.geometry.parameters.width
    const height = size.y * mesh.geometry.parameters.height
    const mask = { center, width, height }
    if (matrices.every(matrix => this.#bounds(mask, orientation, matrix).isEmpty())) return
    const uv = mesh.geometry.getAttribute('uv')
    const left = uv.getX(0), right = uv.getX(1)
    const bottom = uv.getY(2), top = uv.getY(0)
    const spanX = right - left, spanY = top - bottom
    if (spanX <= 0 || spanY <= 0) return
    // Recover the full video plane behind the crop already used by the WebGL mesh.
    const plane = { center: center.clone(), width: width / spanX, height: height / spanY }
    plane.center.add(this.#corner.set(
      plane.width * (0.5 - (left + right) / 2),
      plane.height * (0.5 - (bottom + top) / 2), 0,
    ).applyQuaternion(orientation))
    return { ...window, plane, orientation, distanceSquared: center.distanceToSquared(viewer) }
  }

  #bounds(plane: Plane, orientation: Quaternion, matrix: Matrix4) {
    const bounds = new Box2()
    let cornersInFront = 0
    for (const x of cornerSigns) {
      for (const y of cornerSigns) {
        const corner = this.#corner.set(x * plane.width / 2, y * plane.height / 2, 0)
          .applyQuaternion(orientation).add(plane.center)
        const clip = this.#clip.set(corner.x, corner.y, corner.z, 1).applyMatrix4(matrix)
        if (clip.w <= 0 || clip.z < -clip.w) continue
        cornersInFront++
        bounds.expandByPoint(this.#ndc.set(clip.x / clip.w, clip.y / clip.w))
      }
    }
    // A plane that crosses the near plane can cover more of the view than its projected corners.
    return cornersInFront > 0 && cornersInFront < 4 ? bounds.copy(viewport) : bounds.intersect(viewport)
  }

  #entry({ panel, mesh, video, plane, orientation, distanceSquared }: Candidate) {
    const entry = this.#entries.get(video)
    if (entry) entry.distanceSquared = distanceSquared
    const uvVersion = (mesh.geometry.getAttribute('uv') as BufferAttribute).version
    if (entry?.matrix.equals(mesh.matrixWorld) && entry.uvVersion === uvVersion) return entry
    const { x, y, z } = plane.center
    const transform = new XRRigidTransform({ x, y, z }, {
      x: orientation.x, y: orientation.y, z: orientation.z, w: orientation.w,
    })
    const layout = { transform, width: plane.width * this.#quadScale, height: plane.height * this.#quadScale }
    try {
      if (entry) {
        Object.assign(entry.layer, layout)
        entry.matrix.copy(mesh.matrixWorld)
        entry.uvVersion = uvVersion
        return entry
      }
      const layer = this.binding.createQuadLayer(video, { space: this.space, ...layout })
      const created = { panel, layer, matrix: mesh.matrixWorld.clone(), uvVersion, distanceSquared }
      this.#entries.set(video, created)
      return created
    } catch {
      this.#unavailable.add(video)
    }
  }

  #panorama(video: HTMLVideoElement | undefined, yaw: number, holdingLoopFrame: boolean) {
    const changed = video !== this.#panoramaVideo
    if (changed) {
      this.#panoramaVideo = video
      this.#panoramaLoopFrame = undefined
    }
    if (!this.#available || !this.#limit || !video || this.#panoramaUnavailable.has(video)) return
    const existing = this.#panoramas.get(video)?.layer
    if (video.readyState < video.HAVE_CURRENT_DATA && !(existing && holdingLoopFrame)) return
    if (existing && !changed) return existing
    const angle = yaw / 2
    const transform = new XRRigidTransform(undefined, { x: 0, y: Math.sin(angle), z: 0, w: Math.cos(angle) })
    try {
      if (existing) {
        existing.transform = transform
        return existing
      }
      const layer = this.binding.createEquirectLayer(video, {
        space: this.space, transform, layout: 'stereo-left-right', radius: 0, centralHorizontalAngle: Math.PI,
      })
      this.#panoramas.set(video, { layer })
      return layer
    } catch {
      this.#panoramaUnavailable.add(video)
    }
  }

  #submit(windows: Entry[], panorama?: XREquirectLayer) {
    // Compose farthest to nearest. Cropped parts of a nearer video can show through another window's mask.
    let ordered = [...windows].sort((a, b) => b.distanceSquared - a.distanceSquared)
    let layers = [...(panorama ? [panorama] : []), ...ordered.map(({ layer }) => layer)]
    if (layers.length === this.#submitted.length && layers.every((layer, i) => layer === this.#submitted[i])) return panorama
    while (true) {
      try {
        this.projection.blendTextureSourceAlpha = layers.length > 0 || this.#projectionAlpha
        this.session.updateRenderState({ layers: [...layers, this.projection] })
        this.#submitted = layers
        return panorama
      } catch (error) {
        if (!layers.length) return
        if (error instanceof DOMException && error.name === 'NotSupportedError') {
          if (windows.length) windows.pop()
          else panorama = undefined
          this.#limit = windows.length + Number(Boolean(panorama))
        } else {
          windows.length = 0
          panorama = undefined
          this.#available = false
        }
        ordered = ordered.filter(entry => windows.includes(entry))
        layers = [...(panorama ? [panorama] : []), ...ordered.map(({ layer }) => layer)]
      }
    }
  }
}
