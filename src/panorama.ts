import { BackSide, Mesh, MeshBasicMaterial, SphereGeometry, type Scene, type VideoTexture } from 'three'

export class Panorama {
  #hemisphere = new SphereGeometry(1, 64, 32, 0, Math.PI).rotateY(Math.PI)
  #uv = this.#hemisphere.getAttribute('uv').clone()
  #material = new MeshBasicMaterial({ side: BackSide, depthTest: false, depthWrite: false, fog: false, toneMapped: false })
  #eyes = [this.#hemisphere, this.#hemisphere.clone()].map(geometry => new Mesh(geometry, this.#material))
  #immersive = false

  constructor(scene: Scene) {
    this.#material.onBeforeCompile = shader => {
      // Keep the sphere centered on each eye as the camera moves.
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
        vec4 mvPosition = vec4(mat3(modelViewMatrix) * transformed, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        gl_Position.z = gl_Position.w;
      `)
    }
    for (const [index, eye] of this.#eyes.entries()) {
      eye.layers.set(index + 1) // Three.js uses layers 1 and 2 for the left and right XR eyes.
      eye.renderOrder = -1
      eye.frustumCulled = false
      eye.visible = false
      scene.add(eye)
    }
  }

  sync(texture: VideoTexture | undefined, yaw: number | null) {
    const immersive = yaw !== null
    const map = texture ?? null
    if (map === this.#material.map && immersive === this.#immersive) return
    this.#immersive = immersive
    this.#material.map = map
    this.#material.needsUpdate = true
    for (const [index, eye] of this.#eyes.entries()) {
      eye.visible = Boolean(texture)
      eye.rotation.y = yaw ?? 0
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
  }
}
