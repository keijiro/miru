import {
  ArrowLeft, Check, ChevronRight, CircleAlert, Film, Folder, FolderOpen, Image as ImageIcon,
  Maximize, Monitor, Mouse, Move, Pause, Play, RefreshCw, Volume2, VolumeX, X,
} from 'lucide-react'
import {
  useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject,
} from 'react'
import { mediaUrl, type MediaEntry } from './media-api'
import {
  clamp, desktopDepth, filterMedia, formatTime, limits, mediaOverflow, panned, resized, viewHeight, windowDefaults,
  type View, type Workspace,
} from './workspace'

type State = ReturnType<Workspace['snapshot']>

function Thumbnail({ media }: { media: MediaEntry }) {
  const [broken, setBroken] = useState(false)
  const Kind = media.kind === 'video' ? Film : ImageIcon
  return (
    <div className="thumbnail">
      {broken ? <Kind size={23} className="thumbnail-fallback" /> : (
        <img src={mediaUrl(media, 'thumbnail')} alt="" loading="lazy" onError={() => setBroken(true)} />
      )}
      {media.kind === 'video' && <span className="thumbnail-video"><Play size={12} fill="currentColor" /></span>}
    </div>
  )
}

type LibraryScroll = { path: string, top: number }

function Library({ workspace, view, scroll }: {
  workspace: Workspace
  view: View
  scroll: RefObject<LibraryScroll | null>
}) {
  const { listing, busy, error } = view.browser
  const content = useRef<HTMLDivElement>(null)
  const crumbs = listing.path ? listing.path.split('/') : []
  const folders = listing.entries.filter(entry => entry.kind === 'folder')
  const media = filterMedia(listing)

  useLayoutEffect(() => {
    const element = content.current
    if (!element) return
    element.scrollTop = scroll.current?.path === listing.path ? scroll.current.top : 0
    return () => { scroll.current = { path: listing.path, top: element.scrollTop } }
  }, [listing.path, scroll])

  return (
    <div className="library">
      <div className="library-top">
        <nav className="breadcrumbs" aria-label="Current folder">
          <Folder size={14} aria-hidden="true" />
          {[listing.rootName, ...crumbs].map((name, index) => (
            <span key={index}>
              {index > 0 && <ChevronRight size={13} />}
              <button type="button" title={name} aria-current={index === crumbs.length ? 'location' : undefined}
                onClick={() => void workspace.navigate(view.id, crumbs.slice(0, index).join('/'))}>{name}</button>
            </span>
          ))}
        </nav>
        <button type="button" className="icon-button" title="Refresh" aria-label="Refresh folder"
          onClick={() => void workspace.navigate(view.id, listing.path)} disabled={busy}>
          <RefreshCw size={16} className={busy ? 'spinning' : ''} />
        </button>
      </div>
      <div className="library-content" aria-busy={busy} ref={content}>
        {error && <p className="notice" role="alert"><CircleAlert size={16} />{error}</p>}
        {folders.length > 0 && (
          <section className="library-section">
            <h3 className="section-title">Folders</h3>
            <div className="folder-list">
              {folders.map(folder => (
                <button type="button" className="folder-row" key={folder.path} onClick={() => void workspace.navigate(view.id, folder.path)}>
                  <Folder size={17} /><span>{folder.name}</span><ChevronRight size={15} className="folder-chevron" />
                </button>
              ))}
            </div>
          </section>
        )}
        <section className="library-section">
          <h3 className="section-title">Media</h3>
          {media.length ? (
            <div className="media-grid">
              {media.map(entry => (
                <button type="button" key={entry.path} title={entry.name} onClick={() => workspace.open(view.id, entry)}
                  className="media-card">
                  <Thumbnail media={entry} key={entry.version} />
                  <span className="media-name">{entry.name}</span>
                </button>
              ))}
            </div>
          ) : !busy && <p className="folder-empty">No supported media in this folder.</p>}
        </section>
      </div>
    </div>
  )
}

export function stageBase(width: number, height: number) {
  return Math.min(width * 0.96, height * 1.6)
}

function useSize(ref: RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      setSize({ width, height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return size
}

type Drag =
  | { type: 'move' }
  | { type: 'resize', xSide: number, ySide: number }
  | { type: 'content' }

const edges = [
  { name: 'n', xSide: 0, ySide: 1 }, { name: 's', xSide: 0, ySide: -1 },
  { name: 'e', xSide: 1, ySide: 0 }, { name: 'w', xSide: -1, ySide: 0 },
  { name: 'ne', xSide: 1, ySide: 1 }, { name: 'nw', xSide: -1, ySide: 1 },
  { name: 'se', xSide: 1, ySide: -1 }, { name: 'sw', xSide: -1, ySide: -1 },
]

const noMedia = { ready: false, duration: 0, time: 0, playing: false, error: '' }
const emptyMediaSnapshot = () => noMedia
const noMediaSubscription = () => () => {}

function ViewWindow({ workspace, view, selected, pixels, left, top, order }: {
  workspace: Workspace
  view: View
  selected: boolean
  pixels: number
  left: number
  top: number
  order: number
}) {
  const runtime = workspace.runtime(view.id)
  const video = runtime?.video
  const media = useSyncExternalStore(runtime?.subscribe ?? noMediaSubscription, runtime?.snapshot ?? emptyMediaSnapshot)
  const target = useRef<HTMLDivElement>(null)
  const libraryScroll = useRef<LibraryScroll | null>(null)
  const pointer = useRef<{ action: Drag, view: View, originX: number, originY: number, pixels: number, moved: boolean, id: number } | null>(null)
  const title = view.media?.name ?? 'File browser'
  const Kind = view.media?.kind === 'video' ? Film : view.media ? ImageIcon : FolderOpen
  const overflow = mediaOverflow(view)
  const canPan = media.ready && (overflow.x > 0 || overflow.y > 0)
  const surfaceClass = `view-surface${canPan ? ' can-pan' : ''}`
  const toggleControls = () => workspace.patch(view.id, { controls: !view.controls })

  useLayoutEffect(() => {
    const parent = target.current
    const element = runtime?.element
    if (!parent || !element) return
    parent.append(element)
    return () => element.remove()
  }, [runtime])

  const start = (event: PointerEvent<HTMLElement>, action: Drag) => {
    if (event.button !== 0 || pointer.current) return
    workspace.select(view.id)
    pointer.current = {
      action, view, originX: event.clientX, originY: event.clientY, pixels, moved: false, id: event.pointerId,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const drag = (event: PointerEvent<HTMLElement>) => {
    const active = pointer.current
    if (!active || active.id !== event.pointerId) return
    const dx = (event.clientX - active.originX) / active.pixels
    const dy = (active.originY - event.clientY) / active.pixels
    active.moved ||= Math.hypot(dx, dy) * active.pixels >= 4
    if (!active.moved) return
    const original = active.view
    if (active.action.type === 'move') {
      workspace.patch(view.id, { x: clamp(original.x + dx, -100, 100), y: clamp(original.y + dy, -100, 100) })
    } else if (active.action.type === 'resize') {
      workspace.patch(view.id, resized(original, dx, dy, active.action.xSide, active.action.ySide))
    } else if (canPan) {
      const pan = panned(original, dx, dy)
      if (pan.panX !== view.panX || pan.panY !== view.panY) workspace.patch(view.id, pan)
    }
  }
  const finish = (event: PointerEvent<HTMLElement>) => {
    const active = pointer.current
    if (!active || active.id !== event.pointerId) return
    if (event.type === 'pointerup') {
      drag(event)
      if (active.action.type === 'content' && !active.moved && video) toggleControls()
    }
    pointer.current = null
    workspace.save()
  }
  const pointerHandlers = { onPointerMove: drag, onPointerUp: finish, onPointerCancel: finish, onLostPointerCapture: finish }
  const contentHandlers = { ...pointerHandlers, onPointerDown: (event: PointerEvent<HTMLElement>) => start(event, { type: 'content' }) }
  const moveWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    const amount = event.shiftKey ? 0.25 : 0.07
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      workspace.depth(view.id, event.key === 'ArrowUp' ? amount * 3 : -amount * 3)
      return
    }
    const x = event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0
    const y = event.key === 'ArrowDown' ? -amount : event.key === 'ArrowUp' ? amount : 0
    if (x || y) {
      event.preventDefault()
      workspace.patch(view.id, { x: clamp(view.x + x, -100, 100), y: clamp(view.y + y, -100, 100) })
    }
  }

  const loopStart = media.duration ? 100 * view.loopStart / media.duration : 0
  const loopEnd = media.duration ? 100 * (view.loopEnd ?? media.duration) / media.duration : 100
  const timelineProgress = media.duration ? 100 * media.time / media.duration : 0
  const width = view.width * pixels
  const height = viewHeight(view) * pixels
  return (
    <section className={`view-window${selected ? ' is-selected' : ''}`} aria-label={title} data-view-id={view.id}
      style={{ left, top: top - height / 2 - 17, width, zIndex: order }}
      onPointerDown={() => workspace.select(view.id)}
      onFocus={() => workspace.select(view.id)}>
      <div className="view-frame">
        <div className="view-resizable">
          <div className="view-title">
            {runtime && <button type="button" className="icon-button back-view" title="Back to file browser"
              aria-label="Back to file browser" onClick={() => workspace.back(view.id)}><ArrowLeft size={17} /></button>}
            <button type="button" className="view-title-drag" aria-label={`Move ${title}`} title={title}
              onPointerDown={event => start(event, { type: 'move' })} {...pointerHandlers} onKeyDown={moveWithKeyboard}>
              <Kind size={15} aria-hidden="true" />
              <span className="view-name">{title}</span>
            </button>
            <button type="button" className="icon-button close-view" title="Close view" aria-label={`Close ${title}`}
              onClick={() => workspace.close(view.id)}><X size={17} /></button>
          </div>
          <div className="view-screen" style={{ height }}>
            {runtime ? (
              <>
                <div className="view-visual" ref={target} style={{
                  '--media-position': `${(1 - view.panX) * 50}% ${(1 + view.panY) * 50}%`,
                } as CSSProperties} />
                {media.error && <div className="view-message"><CircleAlert size={17} />{media.error}</div>}
                {!media.ready && !media.error && <div className="view-message" role="status">Loading…</div>}
                {video ? (
                  <button type="button" className={surfaceClass} aria-label="Video controls" aria-expanded={view.controls}
                    onClick={event => { if (event.detail === 0) toggleControls() }} {...contentHandlers} />
                ) : canPan && <div className={surfaceClass} aria-hidden="true" {...contentHandlers} />}
              </>
            ) : <Library workspace={workspace} view={view} scroll={libraryScroll} />}
          </div>
          {edges.map(edge => (
            <div key={edge.name} data-edge={edge.name} className={`resize-edge edge-${edge.name}`}
              aria-hidden="true" onPointerDown={event => start(event, { type: 'resize', xSide: edge.xSide, ySide: edge.ySide })}
              {...pointerHandlers} />
          ))}
        </div>
        {runtime && video && view.controls && (
          <div className="view-controls">
            <div className="timeline">
              <input className="range timeline-range" type="range" aria-label="Playback position"
                min={0} max={media.duration || 1} step={0.01} value={media.time} disabled={!media.duration}
                style={{ '--progress': `${timelineProgress}%` } as CSSProperties}
                onChange={event => runtime.seek(event.currentTarget.valueAsNumber)} />
              {view.loopStart > 0 && <span className="loop-tick" style={{ left: `${loopStart}%` }} />}
              {view.loopEnd !== null && <span className="loop-tick" style={{ left: `${loopEnd}%` }} />}
            </div>
            <div className="video-buttons">
              <button type="button" className="icon-button playback" onClick={() => runtime.togglePlayback()}
                aria-label={media.playing ? 'Pause' : 'Play'} title={media.playing ? 'Pause' : 'Play'} disabled={!media.ready}>
                {media.playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
              </button>
              <span className="video-time">{formatTime(media.time)} <span>/ {formatTime(media.duration)}</span></span>
              <div className="loop-actions">
                <button type="button" title={`Set loop start (${formatTime(view.loopStart)})`}
                  aria-label="Set loop start" data-set={view.loopStart > 0} disabled={!media.duration}
                  onClick={() => runtime.mark('start')}>[ A</button>
                <button type="button" title={`Set loop end (${formatTime(view.loopEnd ?? media.duration)})`}
                  aria-label="Set loop end" data-set={view.loopEnd !== null} disabled={!media.duration}
                  onClick={() => runtime.mark('end')}>B ]</button>
                <button type="button" className="icon-button volume-button" title={view.muted ? 'Unmute' : 'Mute'}
                  aria-label={view.muted ? 'Unmute' : 'Mute'}
                  onClick={() => workspace.patch(view.id, { muted: !view.muted })}>
                  {view.muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

export function Desktop({ workspace, state }: {
  workspace: Workspace
  state: State
}) {
  const stage = useRef<HTMLDivElement>(null)
  const { width, height } = useSize(stage)
  const base = stageBase(width, height)
  const scale = base * state.camera.zoom
  const ordered = [...state.views].sort((a, b) => desktopDepth(b) - desktopDepth(a) || Number(a.id === state.selected) - Number(b.id === state.selected))
  const stacking = new Map(ordered.map((view, index) => [view.id, index + 1]))

  const openWindow = (event: MouseEvent<HTMLButtonElement>) => {
    const { left, top, width, height } = event.currentTarget.getBoundingClientRect()
    const scale = stageBase(width, height) * state.camera.zoom
    if (scale <= 0) return
    const x = event.detail ? event.clientX - left : width / 2
    const y = event.detail ? event.clientY - top : height / 2
    const { width: windowWidth, height: windowHeight, depth } = windowDefaults
    const halfWidth = Math.min(width / 2, windowWidth * scale / depth / 2)
    const halfHeight = windowHeight * scale / depth / 2
    const centerX = clamp(x, halfWidth, width - halfWidth)
    const centerY = clamp(y, Math.min(height / 2, halfHeight + 34), Math.max(height / 2, height - halfHeight))
    workspace.create({
      x: (state.camera.x + (centerX - width / 2) / scale) * depth,
      y: (state.camera.y + (height / 2 - centerY) / scale) * depth,
      z: -depth, orientation: [0, 0, 0, 1],
    })
  }

  useEffect(() => {
    const element = stage.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      if (!event.altKey) return
      const id = (event.target as HTMLElement).closest<HTMLElement>('[data-view-id]')?.dataset.viewId ?? workspace.snapshot().selected
      if (!id) return
      event.preventDefault()
      const delta = event.deltaY * (event.deltaMode === 0 ? 0.004 : 0.08)
      workspace.depth(id, clamp(delta, -0.9, 0.9))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [workspace])

  return (
    <main className="workspace">
      <header className="workspace-top">
        <div className="workspace-heading">
          <div>
            <h1>Workspace</h1>
            <p>{state.views.length} {state.views.length === 1 ? 'view' : 'views'} open</p>
          </div>
        </div>
        <button type="button" className="fit-button" disabled={!state.views.length}
          onClick={() => workspace.fit(width, height, base)} title="Fit all views">
          <Maximize size={16} /><span>Fit all</span>
        </button>
      </header>
      <div className="stage" ref={stage}>
        <div className="stage-dots" aria-hidden="true" />
        <div className="stage-floor" aria-hidden="true"><div /></div>
        <button type="button" className="stage-background" aria-label="Open a new file browser" onClick={openWindow} />
        {!!scale && state.views.map(view => (
          <ViewWindow key={view.id} workspace={workspace} view={view} selected={state.selected === view.id}
            order={stacking.get(view.id) ?? 1} pixels={scale / desktopDepth(view)}
            left={width / 2 + (view.x / desktopDepth(view) - state.camera.x) * scale}
            top={height / 2 - (view.y / desktopDepth(view) - state.camera.y) * scale} />
        ))}
      </div>
      <footer className="workspace-footer">
        <div className="desktop-indicator"><Monitor size={15} /><span>Desktop</span></div>
        <div className="create-hint"><Mouse size={14} />Click empty space to open a window</div>
        <div className="hints">
          <span><Move size={14} />Drag title bar to move</span>
          <span><Maximize size={13} />Drag edges to resize</span>
          <span><Mouse size={14} /><kbd>Alt</kbd> + scroll for depth</span>
        </div>
        <div className={`save-indicator${state.storageError ? ' has-error' : ''}`} role="status">
          {state.storageError ? <CircleAlert size={15} /> : <Check size={15} />}
          <span>{state.storageError ? 'Autosave unavailable' : 'Autosave on'}</span>
        </div>
      </footer>
    </main>
  )
}
