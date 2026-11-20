import { Box, CircleAlert, Glasses, Maximize, RefreshCw, X } from 'lucide-react'
import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { fetchDirectory } from './media-api'
import { WorkspaceScene } from './scene'
import { Workspace } from './workspace'
import './style.css'

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark"><Box size={22} strokeWidth={1.8} /></span>
      <span className="brand-name">miru</span>
      <span className="brand-caption">Media workspace</span>
    </div>
  )
}

function App({ workspace }: { workspace: Workspace }) {
  const state = useSyncExternalStore(workspace.subscribe, workspace.snapshot)
  const [available, setAvailable] = useState(false)
  const [active, setActive] = useState(false)
  const [pending, setPending] = useState(false)
  const [ready, setReady] = useState(false)
  const [sceneError, setSceneError] = useState('')
  const [error, setError] = useState('')
  const stage = useRef<HTMLElement>(null)
  const session = useRef<XRSession | null>(null)
  const scene = useRef<WorkspaceScene | null>(null)

  useEffect(() => {
    let renderer: WorkspaceScene
    try {
      renderer = new WorkspaceScene(workspace, stage.current!)
    } catch {
      setSceneError('Could not start the workspace. WebGL 2 is required.')
      return
    }
    scene.current = renderer
    setReady(true)
    return () => {
      scene.current = null
      const xrSession = session.current
      session.current = null
      if (xrSession) void xrSession.end().catch(() => {}).finally(() => renderer.dispose())
      else renderer.dispose()
    }
  }, [workspace])

  useEffect(() => {
    const xr = navigator.xr
    if (!xr) return
    const update = () => void xr.isSessionSupported('immersive-vr').then(setAvailable).catch(() => setAvailable(false))
    update()
    xr.addEventListener('devicechange', update)
    window.addEventListener('focus', update)
    return () => {
      xr.removeEventListener('devicechange', update)
      window.removeEventListener('focus', update)
    }
  }, [])

  async function toggleVr() {
    const renderer = scene.current
    if (pending || !renderer) return
    setError('')
    if (session.current) {
      try {
        await session.current.end()
      } catch {
        setError('Could not exit VR mode.')
      }
      return
    }
    if (!navigator.xr) return
    setPending(true)
    try {
      const xrSession = await navigator.xr.requestSession('immersive-vr')
      if (scene.current !== renderer) {
        await xrSession.end()
        return
      }
      session.current = xrSession
      xrSession.addEventListener('end', () => {
        if (session.current !== xrSession) return
        session.current = null
        setActive(false)
        workspace.save()
      }, { once: true })
      await renderer.start(xrSession)
      if (session.current === xrSession) setActive(true)
    } catch (failure) {
      if (session.current) await session.current.end().catch(() => {})
      setError(failure instanceof DOMException && failure.name === 'NotSupportedError'
        ? 'No VR session is available.'
        : 'Could not start VR mode. Check your headset and its connection to the browser.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <Brand />
        <div className="app-actions">
          <button type="button" className="fit-button" disabled={!ready || active || pending || !state.views.length}
            onClick={() => scene.current?.fit()}><Maximize size={16} />Fit all</button>
          <button type="button" className="vr-toggle" role="switch" aria-checked={active} aria-label="VR mode"
            disabled={!ready || pending || (!available && !active)}
            title={available ? 'Toggle VR mode' : 'VR sessions are unavailable in this browser'}
            onClick={() => void toggleVr()}>
            <Glasses size={20} /><span>VR mode</span><span className="switch-track" aria-hidden="true" />
          </button>
        </div>
      </header>
      <main className="stage" ref={stage}>
        {sceneError && <p className="stage-error" role="alert">{sceneError}</p>}
      </main>
      <footer className="workspace-footer">
        <span>Click empty space to open a window</span>
        <span className="desktop-hints">Hover edges to move or corners to resize · Alt + scroll for depth</span>
        {state.storageError && <span role="alert">Autosave unavailable</span>}
      </footer>
      {error && <div className="app-notice" role="alert"><CircleAlert size={18} />{error}
        <button type="button" className="icon-button" aria-label="Dismiss notification" onClick={() => setError('')}><X size={15} /></button>
      </div>}
    </div>
  )
}

function Startup() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setError('')
    void fetchDirectory('', controller.signal)
      .then(listing => { if (!controller.signal.aborted) setWorkspace(new Workspace(listing)) })
      .catch((failure: Error) => { if (!controller.signal.aborted) setError(failure.message) })
    return () => controller.abort()
  }, [attempt])

  if (workspace) return <App workspace={workspace} />
  return (
    <div className="app">
      <header className="app-header"><Brand /></header>
      <main className="boot">
        <div className="empty-icon">{error ? <CircleAlert size={32} /> : <Box size={32} />}</div>
        <h1>{error ? 'Could not open the library' : 'Loading library…'}</h1>
        {error && <><p role="alert">{error}</p>
          <button type="button" className="fit-button" onClick={() => setAttempt(attempt + 1)}><RefreshCw size={16} />Retry</button></>}
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Startup />)
