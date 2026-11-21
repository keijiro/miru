import { BufferGeometry, Group, LineBasicMaterial, LineLoop, Mesh, MeshBasicMaterial, RingGeometry, Vector3 } from 'three'
import { uiColors } from './ui-style'
import { clamp, windowDefaults } from './workspace'

const holdDuration = 500
const ringSegments = 120

export class WindowPreview {
  readonly group = new Group()
  #started = performance.now()
  #outline = new LineBasicMaterial({ color: uiColors.accent })
  #track = new MeshBasicMaterial({ color: uiColors.outline })
  #fill = new MeshBasicMaterial({ color: uiColors.accent })
  #frame = new BufferGeometry()
  #ring = new RingGeometry(0.032, 0.037, ringSegments, 1, Math.PI / 2)
  #progress = this.#ring.clone()

  constructor(position: Vector3, eye: Vector3) {
    const { width, height } = windowDefaults
    this.#frame.setFromPoints([
      new Vector3(-width / 2, -height / 2, 0),
      new Vector3(width / 2, -height / 2, 0),
      new Vector3(width / 2, height / 2, 0),
      new Vector3(-width / 2, height / 2, 0),
    ])
    // Draw the arc over the track on the same plane.
    this.#progress.setDrawRange(0, 0)
    const arc = new Mesh(this.#progress, this.#fill)
    const track = new Mesh(this.#ring, this.#track)
    // Mirror the meshes so progress advances clockwise from 12 o'clock.
    arc.scale.x = track.scale.x = -1
    arc.renderOrder = 1
    this.group.add(new LineLoop(this.#frame, this.#outline), track, arc)
    this.group.position.copy(position)
    this.group.lookAt(eye)
  }

  update(now: number, eye: Vector3) {
    const progress = clamp((now - this.#started) / holdDuration, 0, 1)
    this.group.lookAt(eye)
    // Each ring segment is two indexed triangles.
    this.#progress.setDrawRange(0, 6 * Math.floor(progress * ringSegments))
    return progress === 1
  }

  dispose() {
    this.group.removeFromParent()
    this.#frame.dispose()
    this.#ring.dispose()
    this.#progress.dispose()
    this.#outline.dispose()
    this.#track.dispose()
    this.#fill.dispose()
  }
}
