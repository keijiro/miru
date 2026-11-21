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
  #mesh = new Mesh<SphereGeometry, MeshBasicMaterial | ShaderMaterial>(this.#hemisphere, this.#material)

  constructor(scene: Scene) {
    this.#material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', projectHemisphere)
    }
    this.#mesh.renderOrder = -1
    this.#mesh.frustumCulled = false
    this.#mesh.visible = false
    scene.add(this.#mesh)
  }

  sync(texture: VideoTexture | undefined, nativeYaw: number | null) {
    this.#mesh.visible = Boolean(texture) || nativeYaw !== null
    this.#mesh.material = nativeYaw === null ? this.#material : this.#mask
    this.#mesh.rotation.y = nativeYaw ?? 0
    const map = texture ?? null
    if (map === this.#material.map) return
    this.#material.map = map
    this.#material.needsUpdate = true
    if (!texture) return
    // Reverse U for the inside view and keep filtering within the left eye's half on desktop.
    const inset = 0.5 / texture.image.videoWidth
    const uv = this.#hemisphere.getAttribute('uv')
    for (let i = 0; i < uv.count; i++) {
      const u = (1 - this.#uv.getX(i)) / 2
      uv.setX(i, Math.min(0.5 - inset, Math.max(inset, u)))
    }
    uv.needsUpdate = true
  }

  dispose() {
    this.#mesh.removeFromParent()
    this.#hemisphere.dispose()
    this.#material.dispose()
    this.#mask.dispose()
  }
}
