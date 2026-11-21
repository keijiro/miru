import { fetchDirectory } from './media-api'
import { WorkspaceScene } from './scene'
import { uiColors, uiControlRadius, uiFontFamily, uiFontWeight } from './ui-style'
import { Workspace } from './workspace'
import './style.css'

const lifecycle = new AbortController()
const { signal } = lifecycle
window.addEventListener('pagehide', event => {
  if (!event.persisted) lifecycle.abort()
})

function mountWorkspace(workspace: Workspace) {
  const template = document.querySelector<HTMLTemplateElement>('#workspace')!
  boot.replaceWith(template.content.cloneNode(true))

  const stage = document.querySelector<HTMLElement>('.stage')!
  const fit = document.querySelector<HTMLButtonElement>('#fit-all')!
  const vr = document.querySelector<HTMLButtonElement>('#vr-mode')!
  const storageError = document.querySelector<HTMLElement>('#storage-error')!
  const vrError = document.querySelector<HTMLElement>('#vr-error')!
  const vrMessage = vrError.querySelector('span')!
  const xr = navigator.xr
  let scene: WorkspaceScene | undefined
  let session: XRSession | undefined
  let available = false
  let active = false
  let pending = false

  try {
    scene = new WorkspaceScene(workspace, stage)
  } catch {
    stage.querySelector('p')!.hidden = false
  }

  function updateWorkspaceControls() {
    const state = workspace.snapshot()
    fit.toggleAttribute('disabled', !scene || active || pending || !state.views.length)
    storageError.toggleAttribute('hidden', !state.storageError)
  }

  function updateVrControls() {
    vr.disabled = !scene || pending || (!available && !active)
    vr.setAttribute('aria-checked', String(active))
    vr.title = available ? 'Toggle VR mode' : 'VR sessions are unavailable in this browser'
    updateWorkspaceControls()
  }

  function setVrError(message: string) {
    vrMessage.textContent = message
    vrError.hidden = !message
  }

  async function toggleVr() {
    if (pending || !scene) return
    setVrError('')
    if (session) {
      try {
        await session.end()
      } catch {
        setVrError('Could not exit VR mode.')
      }
      return
    }
    if (!xr) return
    pending = true
    updateVrControls()
    try {
      const optionalFeatures = typeof XRMediaBinding === 'function' ? ['layers'] : []
      const nextSession = await xr.requestSession('immersive-vr', { optionalFeatures })
      if (signal.aborted) {
        await nextSession.end()
        return
      }
      session = nextSession
      session.addEventListener('end', () => {
        if (session !== nextSession) return
        session = undefined
        active = false
        workspace.save()
        updateVrControls()
      }, { once: true, signal })
      await scene.start(nextSession)
      active = session === nextSession
    } catch (failure) {
      if (session) await session.end().catch(() => {})
      setVrError(failure instanceof DOMException && failure.name === 'NotSupportedError'
        ? 'No VR session is available.'
        : 'Could not start VR mode. Check your headset and its connection to the browser.')
    } finally {
      pending = false
      if (!signal.aborted) updateVrControls()
    }
  }

  fit.addEventListener('click', () => scene?.fit(), { signal })
  vr.addEventListener('click', () => void toggleVr(), { signal })
  vrError.querySelector('button')!.addEventListener('click', () => setVrError(''), { signal })
  const unsubscribe = workspace.subscribe(updateWorkspaceControls)
  signal.addEventListener('abort', () => {
    unsubscribe()
    if (session) void session.end().catch(() => {}).finally(() => scene?.dispose())
    else scene?.dispose()
    session = undefined
  }, { once: true })
  updateVrControls()

  if (xr) {
    const updateAvailability = async () => {
      available = await xr.isSessionSupported('immersive-vr').catch(() => false)
      if (!signal.aborted) updateVrControls()
    }
    void updateAvailability()
    xr.addEventListener('devicechange', updateAvailability, { signal })
    window.addEventListener('focus', updateAvailability, { signal })
  }
}

const { style } = document.documentElement
for (const [name, color] of Object.entries(uiColors)) style.setProperty(`--ui-${name}`, color)
style.setProperty('--ui-font-family', uiFontFamily)
style.setProperty('--ui-font-weight', String(uiFontWeight))
style.setProperty('--ui-control-radius', `${uiControlRadius}px`)

const boot = document.querySelector('.boot')!
const heading = boot.querySelector('h1')!
const bootError = boot.querySelector('p')!
const retry = boot.querySelector('button')!

async function loadLibrary() {
  heading.textContent = 'Loading library…'
  bootError.hidden = retry.hidden = true
  let workspace: Workspace
  try {
    const listing = await fetchDirectory('', signal)
    if (signal.aborted) return
    workspace = new Workspace(listing)
  } catch (failure) {
    if (signal.aborted) return
    heading.textContent = 'Could not open the library'
    bootError.textContent = failure instanceof Error ? failure.message : 'Could not load the folder.'
    bootError.hidden = retry.hidden = false
    return
  }
  mountWorkspace(workspace)
}

retry.addEventListener('click', () => void loadLibrary(), { signal })
void loadLibrary()
