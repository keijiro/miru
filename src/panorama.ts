import { BackSide, Mesh, MeshBasicMaterial, NoBlending, ShaderMaterial, SphereGeometry, type Scene, type VideoTexture } from 'three'

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
  #eyes = [this.#hemisphere, this.#hemisphere.clone()]
    .map(geometry => new Mesh<SphereGeometry, MeshBasicMaterial | ShaderMaterial>(geometry, this.#material))
  #immersive = false
  #nativeYaw: number | null = null

  constructor(scene: Scene) {
    this.#material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', projectHemisphere)
    }
    for (const [index, eye] of this.#eyes.entries()) {
      eye.layers.set(index + 1) // Three.js uses layers 1 and 2 for the left and right XR eyes.
      eye.renderOrder = -1
      eye.frustumCulled = false
      eye.visible = false
      scene.add(eye)
    }
  }

  sync(texture: VideoTexture | undefined, yaw: number | null, nativeYaw: number | null) {
    const immersive = yaw !== null
    const map = texture ?? null
    if (map === this.#material.map && immersive === this.#immersive && nativeYaw === this.#nativeYaw) return
    this.#immersive = immersive
    this.#nativeYaw = nativeYaw
    this.#material.map = map
    this.#material.needsUpdate = true
    for (const [index, eye] of this.#eyes.entries()) {
      eye.visible = Boolean(texture) || nativeYaw !== null
      eye.material = nativeYaw === null ? this.#material : this.#mask
      eye.rotation.y = nativeYaw ?? yaw ?? 0
      if (!texture) continue
      // Reverse the hemisphere's U axis for an inside view, then keep filtering within this eye's half.
      const inset = 0.5 / texture.image.videoWidth
      const uv = eye.geometry.getAttribute('uv')
      for (let i = 0; i < uv.count; i++) {
        const u = 1 - this.#uv.getX(i)
        uv.setX(i, index / 2 + Math.min(0.5 - inset, Math.max(inset, u / 2)))
      }
      uv.needsUpdate = true
    }
  }

  dispose() {
    for (const eye of this.#eyes) {
      eye.removeFromParent()
      eye.geometry.dispose()
    }
    this.#material.dispose()
    this.#mask.dispose()
  }
}
