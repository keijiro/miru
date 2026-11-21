import { fetchDirectory, mediaUrl, type DirectoryListing, type MediaEntry } from './media-api'

const minWidth = 0.24
const maxWidth = 6
const minAutoAspect = 0.52
const maxAutoAspect = 2.8

export const windowDefaults = { width: 0.56, height: 0.44, depth: 1 }

export const limits = {
  minWidth,
  maxWidth,
  minHeight: minWidth / maxAutoAspect,
  maxHeight: maxWidth / minAutoAspect,
  near: 0.55,
  far: 24,
}

export interface View {
  id: string
  media: MediaEntry | null
  directory: string
  browser: BrowserState
  x: number
  y: number
  z: number
  width: number
  // Derive the height from the media until the view is resized.
  height?: number
  aspect: number
  panX: number
  panY: number
  controls: boolean
  paused: boolean
  muted: boolean
  loopStart: number
  loopEnd: number | null
}

type SavedView = Omit<View, 'browser'>

interface BrowserState {
  listing: DirectoryListing
  busy: boolean
  error: string
}

interface Camera {
  x: number
  y: number
  z: number
}

interface Layout {
  views: SavedView[]
  selected: string | null
  panorama: string | null
  camera: Camera | null
}

interface WorkspaceState extends Omit<Layout, 'views'> {
  views: View[]
  storageError: boolean
}

interface MediaState {
  ready: boolean
  duration: number
  time: number
  playing: boolean
  error: string
}

const defaultCamera: Camera = { x: 0, y: 0, z: 0 }
const blankMedia: MediaState = { ready: false, duration: 0, time: 0, playing: false, error: '' }
const oldSampleFolder = String.fromCodePoint(0x30d5, 0x30a3, 0x30fc, 0x30eb, 0x30c9, 0x30ce, 0x30fc, 0x30c8)

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
export const viewHeight = (view: View) => view.height ?? view.width / clamp(view.aspect, minAutoAspect, maxAutoAspect)
export const filterMedia = (listing: DirectoryListing) => listing.entries.filter(entry => entry.kind !== 'folder')

function finite(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback
}

function restore(key: string) {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (data && typeof data === 'object') {
      return data as Partial<Omit<Layout, 'camera'>> & {
        camera?: Partial<Camera> & { zoom?: number } | null
        directory?: string
      }
    }
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

function restoreView(view: SavedView, browser: BrowserState, legacyDirectory: string): View | undefined {
  if (!view || typeof view.id !== 'string') return
  const { media } = view
  if (media !== null && (!media || typeof media.path !== 'string' || typeof media.name !== 'string'
    || typeof media.version !== 'string' || (media.kind !== 'video' && media.kind !== 'image'))) return
  const directory = typeof view.directory === 'string' ? view.directory : legacyDirectory
  const samples = browser.listing.samples
  return {
    id: view.id,
    media: samples && media ? { ...media, path: restoreSamplePath(media.path) } : media,
    directory: samples ? restoreSamplePath(directory) : directory,
    browser,
    x: finite(view.x, 0, -100, 100),
    y: finite(view.y, 0, -100, 100),
    z: finite(view.z, -windowDefaults.depth, -limits.far, limits.far),
    width: finite(view.width, windowDefaults.width, limits.minWidth, limits.maxWidth),
    height: typeof view.height === 'number' && Number.isFinite(view.height)
      ? clamp(view.height, limits.minHeight, limits.maxHeight) : media ? undefined : windowDefaults.height,
    aspect: finite(view.aspect, 16 / 9, 0.01, 100),
    panX: finite(view.panX, 0, -1, 1),
    panY: finite(view.panY, 0, -1, 1),
    controls: media?.kind === 'video' && view.controls === true,
    paused: view.paused === true,
    muted: view.muted !== false,
    loopStart: finite(view.loopStart, 0, 0, Number.MAX_SAFE_INTEGER),
    loopEnd: typeof view.loopEnd === 'number' && Number.isFinite(view.loopEnd) && view.loopEnd > view.loopStart
      ? view.loopEnd : null,
  }
}

const mediaDefaults = {
  aspect: 16 / 9, panX: 0, panY: 0, controls: false,
  paused: false, muted: true, loopStart: 0, loopEnd: null,
}

export function resizedDimensions(
  view: View, dx: number, dy: number, xSide: number, ySide: number,
  minimum: Pick<typeof limits, 'minWidth' | 'minHeight'> = limits,
) {
  const originalHeight = viewHeight(view)
  const width = clamp(view.width + dx * xSide, minimum.minWidth, limits.maxWidth)
  const height = clamp(originalHeight + dy * ySide, minimum.minHeight, limits.maxHeight)
  return {
    width,
    height: width === view.width && height === originalHeight ? view.height : height,
  }
}

export function mediaOverflow(view: View) {
  const height = viewHeight(view)
  const ratio = view.aspect / (view.width / height)
  return {
    x: Math.max(0, view.width * (ratio - 1)),
    y: Math.max(0, height * (1 / ratio - 1)),
  }
}

export function panned(view: View, dx: number, dy: number): Pick<View, 'panX' | 'panY'> {
  const { x, y } = mediaOverflow(view)
  return {
    panX: x > 0 ? clamp(view.panX + dx * 2 / x, -1, 1) : view.panX,
    panY: y > 0 ? clamp(view.panY + dy * 2 / y, -1, 1) : view.panY,
  }
}

const normalizedTime = (time: number) => Number.isFinite(time) && time > 0 ? time : 0
const loopCaptureWindow = 0.4
const loopCaptureInterval = 1 / 15
const loopFrameMaxSize = 1280

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
  #abort = new AbortController()
  #frame?: number
  #previousTime = 0
  #playRequested = false
  #captureLoopFrames = false
  #loopFrameContext?: CanvasRenderingContext2D
  #loopFrameTime = -Infinity

  constructor(view: View, media: MediaEntry, private readonly update: (patch: Partial<View>) => void) {
    this.#view = view
    const options = { signal: this.#abort.signal }
    if (media.kind === 'image') {
      const image = new Image()
      this.element = image
      image.alt = media.name
      image.draggable = false
      image.decoding = 'async'
      image.addEventListener('load', () => {
        this.update({ aspect: image.naturalWidth / image.naturalHeight })
        this.#publish({ ready: true })
      }, options)
      image.addEventListener('error', this.#fail, options)
      image.src = mediaUrl(media)
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
        aspect: video.videoHeight > 0 ? video.videoWidth / video.videoHeight : this.#view.aspect,
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
      this.#loopFrameTime = -Infinity
      this.#publish({ time: video.currentTime })
    }, options)
    video.addEventListener('playing', () => {
      this.#publish({ playing: true })
      this.#requestFrame()
    }, options)
    video.addEventListener('pause', () => this.#publish({ playing: false }), options)
    video.addEventListener('ended', () => {
      if (this.#view.paused) return
      this.#seek(this.#view.loopStart, true)
      this.play()
    }, options)
    video.addEventListener('error', this.#fail, options)
    video.src = mediaUrl(media)
  }

  snapshot = () => this.#state

  get loopFrame() {
    const video = this.video
    if (!video || this.#loopFrameTime === -Infinity) return
    if (video.seeking || (video.readyState < video.HAVE_CURRENT_DATA && video.currentTime < this.#loopFrameTime)) {
      return this.#loopFrameContext?.canvas
    }
  }

  setLoopFrameCapture(enabled: boolean) {
    this.#captureLoopFrames = enabled
    if (!enabled) {
      this.#loopFrameContext = undefined
      this.#loopFrameTime = -Infinity
    }
  }

  apply(view: View) {
    this.#view = view
    if (!this.video) return
    this.video.muted = view.muted
    this.video.loop = view.loopStart === 0 && view.loopEnd === null
  }

  seek(time: number) {
    this.#seek(time)
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
      if (!video.paused && video.currentTime >= end) this.#seek(start, true)
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
    this.setLoopFrameCapture(false)
    if (this.video) {
      if (this.#frame !== undefined) this.video.cancelVideoFrameCallback(this.#frame)
      this.video.pause()
      this.video.removeAttribute('src')
      this.video.load()
    }
  }

  #seek(time: number, looping = false) {
    const video = this.video
    if (!video || !Number.isFinite(video.duration)) return
    const position = clamp(time, 0, video.duration)
    if (Math.abs(video.currentTime - position) < 0.001) return
    if (looping) this.#captureLoopFrame(video.currentTime)
    else this.#loopFrameTime = -Infinity
    this.#previousTime = position
    video.currentTime = position
    this.#publish({ time: position })
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
    if (crossed) this.#seek(this.#view.loopStart, true)
    // The browser can loop at the end of the file before the app sees a seek.
    else if (end === null && time >= video.duration - loopCaptureWindow && time - this.#loopFrameTime >= loopCaptureInterval) {
      this.#captureLoopFrame(time)
    }
  }

  #captureLoopFrame(time: number) {
    const video = this.video
    if (!this.#captureLoopFrames || !video || video.seeking || video.readyState < video.HAVE_CURRENT_DATA) return
    const { videoWidth, videoHeight } = video
    if (!videoWidth || !videoHeight) return
    const context = this.#loopFrameContext ??= document.createElement('canvas').getContext('2d') ?? undefined
    if (!context) return
    const scale = Math.min(1, loopFrameMaxSize / Math.max(videoWidth, videoHeight))
    const width = Math.max(1, Math.round(videoWidth * scale))
    const height = Math.max(1, Math.round(videoHeight * scale))
    if (context.canvas.width !== width) context.canvas.width = width
    if (context.canvas.height !== height) context.canvas.height = height
    context.drawImage(video, 0, 0, width, height)
    this.#loopFrameTime = time
  }

  #fail = () => this.#publish({
    ready: false, playing: false,
    error: 'Could not open the file. Check its location and whether your browser supports the format.',
  })

  #publish(patch: Partial<MediaState>) {
    this.#state = { ...this.#state, ...patch }
  }
}

export class Workspace {
  #state: WorkspaceState
  #key: string
  #root: BrowserState
  #listeners = new Set<() => void>()
  #runtime = new Map<string, MediaRuntime>()
  #navigation = new Map<string, AbortController>()
  #saveTimer?: number

  constructor(listing: DirectoryListing) {
    this.#key = `miru.workspace.v1.${listing.rootId}`
    this.#root = { listing, busy: false, error: '' }
    const saved = restore(this.#key)
    const legacyDirectory = typeof saved?.directory === 'string' ? saved.directory : ''
    const views = Array.isArray(saved?.views)
      ? saved.views.map(view => restoreView(view, this.#root, legacyDirectory)).filter(view => view !== undefined)
      : []
    const selected = views.find(view => view.id === saved?.selected)?.id ?? null
    const panorama = views.find(view => view.id === saved?.panorama && view.media?.kind === 'video')?.id ?? null
    const camera = saved?.camera
    // Reframe legacy layouts that used Fit all with a shifted projection.
    const legacyFit = camera && camera.z === undefined && (camera.x !== 0 || camera.y !== 0 || camera.zoom !== 1)
    this.#state = {
      camera: views.length && (camera === null || legacyFit) ? null : camera && views.length ? {
        x: finite(camera.x, 0, -100, 100),
        y: finite(camera.y, 0, -100, 100),
        z: finite(camera.z, 0, -limits.far, 100_000),
      } : defaultCamera,
      views, selected, panorama, storageError: false,
    }

    // Use current revisions for items already available in the initial directory.
    this.#refreshMedia(listing)
    for (const view of this.#state.views) {
      this.#createRuntime(view)
      if (!view.media && view.directory) void this.navigate(view.id, view.directory)
    }
    window.addEventListener('pagehide', this.save)
    this.#scheduleSave()
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  snapshot = () => this.#state

  runtime(id: string) {
    return this.#runtime.get(id)
  }

  async navigate(id: string, directory: string) {
    const view = this.#state.views.find(item => item.id === id)
    if (!view || view.media) return
    this.#cancelNavigation(id)
    const controller = new AbortController()
    this.#navigation.set(id, controller)
    this.patch(id, { browser: { ...view.browser, busy: true, error: '' } }, false)
    try {
      const listing = await fetchDirectory(directory, controller.signal)
      if (controller.signal.aborted) return
      if (listing.rootId !== this.#root.listing.rootId) {
        location.reload()
        return
      }
      this.#refreshMedia(listing)
      const browser = { listing, busy: false, error: '' }
      if (!listing.path) this.#root = browser
      this.patch(id, { directory: listing.path, browser })
    } catch (error) {
      if (controller.signal.aborted) return
      const message = error instanceof Error ? error.message : 'Could not load the folder.'
      this.patch(id, {
        directory: view.browser.listing.path,
        browser: { ...view.browser, busy: false, error: message },
      })
    } finally {
      if (this.#navigation.get(id) === controller) this.#navigation.delete(id)
    }
  }

  create(position: Pick<View, 'x' | 'y' | 'z'>) {
    const view: View = {
      ...mediaDefaults, ...position, id: crypto.randomUUID(), media: null, directory: '', browser: this.#root,
      width: windowDefaults.width, height: windowDefaults.height,
    }
    this.#publish({ views: [...this.#state.views, view], selected: view.id }, true)
  }

  open(id: string, media: MediaEntry) {
    const view = this.#state.views.find(item => item.id === id)
    if (!view || view.media) return
    this.#cancelNavigation(id)
    const patch = {
      ...mediaDefaults, media, height: viewHeight(view), directory: view.browser.listing.path,
      browser: { ...view.browser, busy: false, error: '' },
    }
    this.#createRuntime({ ...view, ...patch })
    this.patch(id, patch)
  }

  back(id: string) {
    const view = this.#state.views.find(item => item.id === id)
    if (!view?.media) return
    this.#disposeRuntime(id)
    this.patch(id, { media: null, height: viewHeight(view), controls: false })
    if (view.directory !== view.browser.listing.path) void this.navigate(id, view.directory)
  }

  close(id: string) {
    const views = this.#state.views.filter(view => view.id !== id)
    if (views.length === this.#state.views.length) return
    this.#cancelNavigation(id)
    this.#disposeRuntime(id)
    const selected = this.#state.selected === id ? views.at(-1)?.id ?? null : this.#state.selected
    const panorama = this.#state.panorama === id ? null : this.#state.panorama
    this.#publish({ views, selected, panorama, camera: views.length ? this.#state.camera : defaultCamera }, true)
  }

  select(id: string | null) {
    if (this.#state.selected !== id) this.#publish({ selected: id }, true)
  }

  togglePanorama(id: string) {
    const runtime = this.runtime(id)
    if (!runtime?.video || !runtime.snapshot().ready) return
    this.#publish({ panorama: this.#state.panorama === id ? null : id }, true)
  }

  patch(id: string, patch: Partial<View>, save = true) {
    const current = this.#state.views.find(view => view.id === id)
    if (!current) return
    const updated = { ...current, ...patch }
    this.runtime(id)?.apply(updated)
    const panorama = this.#state.panorama === id && updated.media?.kind !== 'video' ? null : this.#state.panorama
    this.#publish({ views: this.#state.views.map(view => view === current ? updated : view), panorama }, save)
  }

  depth(id: string, distance: number, cameraZ: number) {
    const view = this.#state.views.find(item => item.id === id)
    if (view) {
      const closest = Math.min(limits.far, Math.max(view.z, cameraZ - limits.near))
      this.patch(id, { z: clamp(view.z - distance, -limits.far, closest) })
    }
  }

  setCamera(camera: Camera) {
    this.#publish({ camera }, true)
  }

  save = () => {
    window.clearTimeout(this.#saveTimer)
    this.#saveTimer = undefined
    const { views, selected, panorama, camera } = this.#state
    const savedViews = views.map(({ browser, ...view }) => view)
    try {
      localStorage.setItem(this.#key, JSON.stringify({ views: savedViews, selected, panorama, camera } satisfies Layout))
      if (this.#state.storageError) this.#publish({ storageError: false })
    } catch {
      if (!this.#state.storageError) this.#publish({ storageError: true })
    }
  }

  #createRuntime(view: View) {
    if (view.media) this.#runtime.set(view.id, new MediaRuntime(view, view.media, patch => this.patch(view.id, patch)))
  }

  #disposeRuntime(id: string) {
    this.runtime(id)?.dispose()
    this.#runtime.delete(id)
  }

  #cancelNavigation(id: string) {
    this.#navigation.get(id)?.abort()
    this.#navigation.delete(id)
  }

  #refreshMedia(listing: DirectoryListing) {
    const media = new Map(filterMedia(listing).map(entry => [entry.path, entry]))
    this.#state = {
      ...this.#state,
      views: this.#state.views.map(view => {
        if (!view.media) return view
        const revised = media.get(view.media.path)
        if (!revised || revised.version === view.media.version) return view
        const next = { ...view, media: revised }
        if (this.#runtime.has(view.id)) {
          this.#disposeRuntime(view.id)
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
