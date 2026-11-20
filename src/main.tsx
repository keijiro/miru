import { Box, CircleAlert, Glasses, RefreshCw, X } from 'lucide-react'
import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Desktop } from './desktop'
import { fetchDirectory } from './media-api'
import { Workspace } from './workspace'
import type { XRWorkspace } from './xr'
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
  const [error, setError] = useState('')
  const output = useRef<HTMLDivElement>(null)
  const session = useRef<XRSession | null>(null)
  const scene = useRef<XRWorkspace | null>(null)

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
    if (pending) return
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
      session.current = xrSession
      xrSession.addEventListener('end', () => queueMicrotask(() => {
        if (session.current !== xrSession) return
        session.current = null
        scene.current?.dispose()
        scene.current = null
        setActive(false)
        setPending(false)
        workspace.save()
      }), { once: true })
      const { XRWorkspace } = await import('./xr')
      if (session.current !== xrSession || !output.current) return
      scene.current = new XRWorkspace(workspace, output.current)
      await scene.current.start(xrSession)
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
        <button type="button" className="vr-toggle" role="switch" aria-checked={active} aria-label="VR mode"
          disabled={pending || (!available && !active)}
          title={available ? 'Toggle VR mode' : 'VR sessions are unavailable in this browser'}
          onClick={() => void toggleVr()}>
          <Glasses size={20} /><span>VR mode</span><span className="switch-track" aria-hidden="true" />
        </button>
      </header>
      <div className="app-body">
        <Desktop workspace={workspace} state={state} />
      </div>
      <div className={`xr-output${active ? ' is-active' : ''}`} ref={output} aria-hidden="true" />
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
