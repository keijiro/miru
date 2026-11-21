import {
  BackSide, CanvasTexture, Mesh, MeshBasicMaterial, NoBlending, ShaderMaterial, SphereGeometry, SRGBColorSpace,
  type Scene, type VideoTexture,
} from 'three'

export interface XrPanorama {
  yaw: number
  loopFrame?: HTMLCanvasElement
}

// Keep the hemisphere centered on each eye as the camera moves.
const projectHemisphere = `
  vec4 mvPosition = vec4(mat3(modelViewMatrix) * transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_Position.z = gl_Position.w;
`

export class Panorama {
  #hemisphere = new SphereGeometry(1, 64, 32, 0, Math.PI).rotateY(Math.PI)
  #uv = this.#hemisphere.getAttribute('uv').clone()
  #material = new MeshBasicMaterial({ side: BackSide, depthTest: false, depthWrite: false, fog: false, toneMapped: false })
  #mask = new ShaderMaterial({
    side: BackSide, depthTest: false, depthWrite: false, blending: NoBlending,
    vertexShader: `void main() { vec3 transformed = position; ${projectHemisphere} }`,
    fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }',
  })
  #mesh = new Mesh<SphereGeometry, MeshBasicMaterial | ShaderMaterial>(this.#hemisphere, this.#material)
  #rightEye = new Mesh(this.#hemisphere.clone(), this.#material)
  #loopTexture?: CanvasTexture

  constructor(scene: Scene) {
    this.#material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', projectHemisphere)
    }
    for (const mesh of [this.#mesh, this.#rightEye]) {
      mesh.renderOrder = -1
      mesh.frustumCulled = false
      mesh.visible = false
      scene.add(mesh)
    }
    // Three.js uses layers 1 and 2 for the left and right XR eyes.
    this.#rightEye.layers.set(2)
  }

  sync(texture: VideoTexture | undefined, xr?: XrPanorama) {
    const frame = xr?.loopFrame
    if (!xr || (frame && this.#loopTexture?.image !== frame)) {
      this.#loopTexture?.dispose()
      this.#loopTexture = undefined
    }
    const map = frame ? this.#loopTexture ??= new CanvasTexture(frame) : texture ?? null
    this.#mesh.visible = Boolean(texture || xr)
    this.#mesh.material = xr && !frame ? this.#mask : this.#material
    this.#mesh.rotation.y = this.#rightEye.rotation.y = xr?.yaw ?? 0
    this.#mesh.layers.set(frame ? 1 : 0)
    this.#rightEye.visible = Boolean(frame)
    if (map !== this.#material.map) {
      this.#material.map = map
      this.#material.needsUpdate = true
      if (frame && map) {
        map.colorSpace = SRGBColorSpace
        map.needsUpdate = true
        this.#setEyeUv(this.#hemisphere, frame.width, 0)
        this.#setEyeUv(this.#rightEye.geometry, frame.width, 0.5)
      } else if (texture) {
        this.#setEyeUv(this.#hemisphere, texture.image.videoWidth, 0)
      }
    }
    return this.#mesh.visible
  }

  #setEyeUv(hemisphere: SphereGeometry, width: number, offset: number) {
    // Reverse U for the inside view and keep filtering within each eye's half.
    const inset = 0.5 / width
    const uv = hemisphere.getAttribute('uv')
    for (let i = 0; i < uv.count; i++) {
      const u = (1 - this.#uv.getX(i)) / 2
      uv.setX(i, offset + Math.min(0.5 - inset, Math.max(inset, u)))
    }
    uv.needsUpdate = true
  }

  dispose() {
    for (const mesh of [this.#mesh, this.#rightEye]) {
      mesh.removeFromParent()
      mesh.geometry.dispose()
    }
    this.#loopTexture?.dispose()
    this.#material.dispose()
    this.#mask.dispose()
  }
}
