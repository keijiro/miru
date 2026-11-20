import { fetchDirectory, mediaUrl, type DirectoryListing, type MediaEntry } from './media-api'

export const limits = {
  minWidth: 0.24,
  maxWidth: 6,
  near: 0.55,
  far: 24,
  maxZoom: 4,
}

export interface View {
  id: string
  media: MediaEntry
  x: number
  y: number
  z: number
  width: number
  aspect: number
  zoom: number
  panX: number
  panY: number
  controls: boolean
  paused: boolean
  muted: boolean
  loopStart: number
  loopEnd: number | null
}

interface Camera {
  x: number
  y: number
  zoom: number
}

interface Layout {
  directory: string
  views: View[]
  selected: string | null
  camera: Camera
}

interface WorkspaceState extends Layout {
  listing: DirectoryListing
  busy: boolean
  error: string
  storageError: boolean
}

interface MediaState {
  ready: boolean
  duration: number
  time: number
  playing: boolean
  error: string
}

const defaultCamera: Camera = { x: 0, y: 0, zoom: 1 }
const blankMedia: MediaState = { ready: false, duration: 0, time: 0, playing: false, error: '' }
const oldSampleFolder = String.fromCodePoint(0x30d5, 0x30a3, 0x30fc, 0x30eb, 0x30c9, 0x30ce, 0x30fc, 0x30c8)

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
export const frameAspect = (view: View) => clamp(view.aspect, 0.52, 2.8)
export const viewHeight = (view: View) => view.width / frameAspect(view)
export const filterMedia = (listing: DirectoryListing) => listing.entries.filter(entry => entry.kind !== 'folder')
export const extension = (name: string) => name.slice(name.lastIndexOf('.') + 1).toUpperCase()

function finite(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback
}

function restore(key: string) {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (data && typeof data === 'object') return data as Partial<Layout>
  } catch {
    // Unavailable storage and older or damaged snapshots are handled at startup.
  }
  return null
}

function restoreSamplePath(path: string) {
  // Migrate paths saved before the bundled folder was renamed to Field Notes.
  return path === oldSampleFolder || path.startsWith(oldSampleFolder + '/')
    ? 'Field Notes' + path.slice(oldSampleFolder.length)
    : path
}

function restoreView(view: View, samples: boolean): View | undefined {
  if (!view || typeof view.id !== 'string' || !view.media || typeof view.media.path !== 'string'
    || typeof view.media.name !== 'string' || typeof view.media.version !== 'string'
    || (view.media.kind !== 'video' && view.media.kind !== 'image')) return
  return {
    id: view.id,
    media: samples ? { ...view.media, path: restoreSamplePath(view.media.path) } : view.media,
    x: finite(view.x, 0, -100, 100),
    y: finite(view.y, 0, -100, 100),
    z: finite(view.z, -3.15, -limits.far, -limits.near),
    width: finite(view.width, 1.42, limits.minWidth, limits.maxWidth),
    aspect: finite(view.aspect, 16 / 9, 0.01, 100),
    zoom: finite(view.zoom, 1, 1, limits.maxZoom),
    panX: finite(view.panX, 0, -1, 1),
    panY: finite(view.panY, 0, -1, 1),
    controls: view.controls === true,
    paused: view.paused === true,
    muted: view.muted !== false,
    loopStart: finite(view.loopStart, 0, 0, Number.MAX_SAFE_INTEGER),
    loopEnd: typeof view.loopEnd === 'number' && Number.isFinite(view.loopEnd) && view.loopEnd > view.loopStart
      ? view.loopEnd : null,
  }
}

function newView(media: MediaEntry, index: number): View {
  const slots = [
    { x: -0.43, y: 0.31, z: -3.05, width: 1.57 },
    { x: 0.90, y: -0.45, z: -3.43, width: 1.17 },
    { x: 0.85, y: 0.58, z: -3.21, width: 1.10 },
    { x: -0.80, y: -0.50, z: -3.22, width: 1.12 },
  ]
  const slot = slots[index % slots.length]
  const offset = (Math.floor(index / slots.length) % 5) * 0.11
  return {
    id: crypto.randomUUID(), media, ...slot, x: slot.x + offset, y: slot.y - offset,
    aspect: 16 / 9, zoom: 1, panX: 0, panY: 0, controls: false,
    paused: false, muted: true, loopStart: 0, loopEnd: null,
  }
}

export function resized(view: View, dx: number, dy: number, xSide: number, ySide: number): Partial<View> {
  const aspect = frameAspect(view)
  const axisY = ySide / aspect
  const requested = (dx * xSide + dy * axisY) / (xSide * xSide + axisY * axisY)
  const width = clamp(view.width + requested, limits.minWidth, limits.maxWidth)
  const difference = width - view.width
  return {
    width,
    x: clamp(view.x + xSide * difference / 2, -100, 100),
    y: clamp(view.y + axisY * difference / 2, -100, 100),
  }
}

export function panned(view: View, dx: number, dy: number): Partial<View> {
  const available = view.zoom - 1
  if (available <= 0) return {}
  return {
    panX: clamp(view.panX + dx * 2 / (view.width * available), -1, 1),
    panY: clamp(view.panY + dy * 2 / (viewHeight(view) * available), -1, 1),
  }
}

const normalizedTime = (time: number) => Number.isFinite(time) && time > 0 ? time : 0

export function formatTime(seconds: number) {
  const n = Math.floor(normalizedTime(seconds))
  const hours = n >= 3600 ? `${Math.floor(n / 3600)}:` : ''
  return `${hours}${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
}

export class MediaRuntime {
  readonly element: HTMLImageElement | HTMLVideoElement
  readonly video?: HTMLVideoElement
  #state = blankMedia
  #view: View
  #listeners = new Set<() => void>()
  #abort = new AbortController()
  #frame?: number
  #previousTime = 0
  #playRequested = false

  constructor(view: View, private readonly update: (patch: Partial<View>) => void) {
    this.#view = view
    const options = { signal: this.#abort.signal }
    if (view.media.kind === 'image') {
      const image = new Image()
      this.element = image
      image.alt = view.media.name
      image.draggable = false
      image.decoding = 'async'
      image.addEventListener('load', () => {
        this.update({ aspect: image.naturalWidth / image.naturalHeight })
        this.#publish({ ready: true })
      }, options)
      image.addEventListener('error', this.#fail, options)
      image.src = mediaUrl(view.media)
      return
    }

    const video = document.createElement('video')
    this.element = this.video = video
    video.playsInline = true
    video.preload = 'auto'
    video.muted = view.muted
    video.loop = view.loopStart === 0 && view.loopEnd === null
    video.disablePictureInPicture = true
    video.addEventListener('loadedmetadata', () => {
      const duration = normalizedTime(video.duration)
      const start = clamp(this.#view.loopStart, 0, Math.max(0, duration - Math.min(0.04, duration / 2)))
      const end = this.#view.loopEnd === null ? null : Math.min(duration, this.#view.loopEnd)
      this.update({
        aspect: video.videoWidth / video.videoHeight,
        loopStart: start,
        loopEnd: end !== null && end > start ? end : null,
      })
      if (start) this.seek(start)
      this.#publish({ ready: true, duration, time: start })
      if (!this.#view.paused) this.play()
    }, options)
    video.addEventListener('timeupdate', () => {
      this.#checkLoop(video.currentTime)
      this.#publish({ time: video.currentTime })
    }, options)
    video.addEventListener('seeked', () => {
      this.#previousTime = video.currentTime
      this.#publish({ time: video.currentTime })
    }, options)
    video.addEventListener('playing', () => {
      this.#publish({ playing: true })
      this.#requestFrame()
    }, options)
    video.addEventListener('pause', () => this.#publish({ playing: false }), options)
    video.addEventListener('ended', () => {
      if (this.#view.paused) return
      this.seek(this.#view.loopStart)
      this.play()
    }, options)
    video.addEventListener('error', this.#fail, options)
    video.src = mediaUrl(view.media)
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  snapshot = () => this.#state

  apply(view: View) {
    this.#view = view
    if (!this.video) return
    this.video.muted = view.muted
    this.video.loop = view.loopStart === 0 && view.loopEnd === null
  }

  seek(time: number) {
    if (!this.video || !Number.isFinite(this.video.duration)) return
    const position = clamp(time, 0, this.video.duration)
    if (Math.abs(this.video.currentTime - position) < 0.001) return
    this.#previousTime = position
    this.video.currentTime = position
    this.#publish({ time: position })
  }

  mark(point: 'start' | 'end') {
    const video = this.video
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return
    const gap = Math.min(0.04, video.duration / 2)
    if (point === 'start') {
      const start = clamp(video.currentTime, 0, video.duration - gap)
      const end = this.#view.loopEnd
      this.update({ loopStart: start, loopEnd: end !== null && end - start >= gap ? end : null })
    } else {
      const end = clamp(video.currentTime, gap, video.duration)
      const start = end - this.#view.loopStart >= gap ? this.#view.loopStart : 0
      this.update({ loopEnd: end, loopStart: start })
      if (!video.paused && video.currentTime >= end) this.seek(start)
    }
  }

  togglePlayback() {
    if (!this.video) return
    if (this.video.paused && !this.#playRequested) {
      this.update({ paused: false })
      const { loopStart, loopEnd } = this.#view
      const time = this.video.currentTime
      if (this.video.ended || time < loopStart || (loopEnd !== null && time >= loopEnd)) this.seek(loopStart)
      this.play()
    } else {
      this.update({ paused: true })
      this.video.pause()
    }
  }

  play() {
    if (!this.video || this.#playRequested) return
    this.#playRequested = true
    void this.video.play().catch(() => {
      this.#publish({ playing: false })
    }).finally(() => { this.#playRequested = false })
  }

  dispose() {
    this.#abort.abort()
    if (this.video) {
      if (this.#frame !== undefined) this.video.cancelVideoFrameCallback(this.#frame)
      this.video.pause()
      this.video.removeAttribute('src')
      this.video.load()
    }
    this.element.remove()
    this.#listeners.clear()
  }

  #requestFrame() {
    const video = this.video
    if (!video || video.paused || this.#frame !== undefined || !video.requestVideoFrameCallback) return
    this.#frame = video.requestVideoFrameCallback((_now, metadata) => {
      this.#frame = undefined
      this.#checkLoop(metadata.mediaTime)
      this.#requestFrame()
    })
  }

  #checkLoop(time: number) {
    const video = this.video
    const end = this.#view.loopEnd
    if (!video || video.paused || video.seeking) return
    const crossed = end !== null && this.#previousTime < end && time >= end
    this.#previousTime = time
    if (crossed) this.seek(this.#view.loopStart)
  }

  #fail = () => this.#publish({
    ready: false, playing: false,
    error: 'Could not open the file. Check its location and whether your browser supports the format.',
  })

  #publish(patch: Partial<MediaState>) {
    this.#state = { ...this.#state, ...patch }
    for (const listener of this.#listeners) listener()
  }
}

export class Workspace {
  #state: WorkspaceState
  #key: string
  #listeners = new Set<() => void>()
  #runtime = new Map<string, MediaRuntime>()
  #navigation?: AbortController
  #saveTimer?: number

  constructor(listing: DirectoryListing) {
    this.#key = `miru.workspace.v1.${listing.rootId}`
    const saved = restore(this.#key)
    const views = Array.isArray(saved?.views)
      ? saved.views.map(view => restoreView(view, listing.samples)).filter(view => view !== undefined)
      : []
    if (!saved && listing.samples) {
      const media = filterMedia(listing)
      const video = media.find(entry => entry.path === 'Aurora Over Lofoten.mp4')
      const still = media.find(entry => entry.path === 'The Dolomites.jpg')
      if (video) views.push({ ...newView(video, 0), controls: true })
      if (still) views.push(newView(still, video ? 1 : 0))
    }
    const selected = saved ? saved.selected ?? null : views[0]?.id ?? null
    const directory = typeof saved?.directory === 'string' ? saved.directory : ''
    this.#state = {
      directory: listing.samples ? restoreSamplePath(directory) : directory,
      camera: saved?.camera ? {
        x: finite(saved.camera.x, 0, -200, 200),
        y: finite(saved.camera.y, 0, -200, 200),
        zoom: finite(saved.camera.zoom, 1, 0.002, 1.5),
      } : defaultCamera,
      views, selected, listing, busy: false, error: '', storageError: false,
    }

    // Use current revisions for items already available in the initial directory.
    this.#refreshMedia(listing)
    for (const view of this.#state.views) this.#createRuntime(view)
    window.addEventListener('pagehide', this.save)
    if (this.#state.directory) void this.navigate(this.#state.directory, true)
    else this.#scheduleSave()
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  snapshot = () => this.#state

  runtime(id: string) {
    return this.#runtime.get(id)!
  }

  async navigate(directory: string, restoring = false) {
    this.#navigation?.abort()
    const controller = new AbortController()
    this.#navigation = controller
    this.#publish({ busy: true, error: '' })
    try {
      const listing = await fetchDirectory(directory, controller.signal)
      if (controller.signal.aborted) return
      if (listing.rootId !== this.#state.listing.rootId) {
        location.reload()
        return
      }
      this.#refreshMedia(listing)
      this.#publish({ listing, directory, busy: false }, true)
    } catch (error) {
      if (controller.signal.aborted) return
      const message = error instanceof Error ? error.message : 'Could not load the folder.'
      this.#publish({
        busy: false, error: message,
        directory: restoring ? this.#state.listing.path : this.#state.directory,
      }, restoring)
    }
  }

  open(media: MediaEntry) {
    const existing = this.#state.views.find(view => view.media.path === media.path)
    if (existing) {
      this.select(existing.id)
      return
    }
    const view = newView(media, this.#state.views.length)
    this.#createRuntime(view)
    this.#publish({ views: [...this.#state.views, view], selected: view.id }, true)
  }

  close(id: string) {
    const runtime = this.#runtime.get(id)
    if (!runtime) return
    runtime.dispose()
    this.#runtime.delete(id)
    const views = this.#state.views.filter(view => view.id !== id)
    const selected = this.#state.selected === id ? views.at(-1)?.id ?? null : this.#state.selected
    this.#publish({ views, selected, camera: views.length ? this.#state.camera : defaultCamera }, true)
  }

  select(id: string | null) {
    if (this.#state.selected !== id) this.#publish({ selected: id }, true)
  }

  patch(id: string, patch: Partial<View>) {
    const current = this.#state.views.find(view => view.id === id)
    if (!current) return
    const updated = { ...current, ...patch }
    this.runtime(id).apply(updated)
    this.#publish({ views: this.#state.views.map(view => view === current ? updated : view) }, true)
  }

  zoom(id: string, value: number) {
    const zoom = clamp(value, 1, limits.maxZoom)
    this.patch(id, zoom === 1 ? { zoom, panX: 0, panY: 0 } : { zoom })
  }

  depth(id: string, distance: number) {
    const view = this.#state.views.find(item => item.id === id)
    if (view) this.patch(id, { z: clamp(view.z - distance, -limits.far, -limits.near) })
  }

  fit(width: number, height: number, base: number) {
    const views = this.#state.views
    if (!views.length || base <= 0) return
    const left = Math.min(...views.map(view => (view.x - view.width / 2) / -view.z))
    const right = Math.max(...views.map(view => (view.x + view.width / 2) / -view.z))
    const top = Math.max(...views.map(view => (view.y + viewHeight(view) / 2) / -view.z))
    const bottom = Math.min(...views.map(view => (view.y - viewHeight(view) / 2) / -view.z))
    const topInset = Math.min(42, height * 0.15)
    const controlsInset = views.some(view => view.controls && view.media.kind === 'video') ? 123
      : views.some(view => view.controls) ? 77 : 44
    const bottomInset = Math.min(controlsInset, height * 0.35)
    const zoom = clamp(Math.min(width * 0.84 / (right - left), (height - topInset - bottomInset) / (top - bottom)) / base, 0.002, 1.5)
    const y = (top + bottom) / 2 + (topInset - bottomInset) / (2 * base * zoom)
    this.#publish({ camera: { x: (left + right) / 2, y, zoom } }, true)
  }

  save = () => {
    window.clearTimeout(this.#saveTimer)
    this.#saveTimer = undefined
    const { directory, views, selected, camera } = this.#state
    try {
      localStorage.setItem(this.#key, JSON.stringify({ directory, views, selected, camera } satisfies Layout))
      if (this.#state.storageError) this.#publish({ storageError: false })
    } catch {
      if (!this.#state.storageError) this.#publish({ storageError: true })
    }
  }

  #createRuntime(view: View) {
    this.#runtime.set(view.id, new MediaRuntime(view, patch => this.patch(view.id, patch)))
  }

  #refreshMedia(listing: DirectoryListing) {
    const media = new Map(filterMedia(listing).map(entry => [entry.path, entry]))
    this.#state = {
      ...this.#state,
      views: this.#state.views.map(view => {
        const revised = media.get(view.media.path)
        if (!revised || revised.version === view.media.version) return view
        const next = { ...view, media: revised }
        if (this.#runtime.has(view.id)) {
          this.runtime(view.id).dispose()
          this.#createRuntime(next)
        }
        return next
      }),
    }
  }

  #scheduleSave() {
    if (this.#saveTimer === undefined) this.#saveTimer = window.setTimeout(this.save, 120)
  }

  #publish(patch: Partial<WorkspaceState>, save = false) {
    this.#state = { ...this.#state, ...patch }
    if (save) this.#scheduleSave()
    for (const listener of this.#listeners) listener()
  }
}
