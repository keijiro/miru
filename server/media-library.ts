import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, type Stats } from 'node:fs'
import { mkdir, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Plugin } from 'vite'
import type { DirectoryListing, LibraryEntry, MediaKind } from '../src/media-api'

const project = fileURLToPath(new URL('..', import.meta.url))
const configFile = resolve(project, 'miru.config.json')
const sampleRoot = resolve(project, 'samples')
const run = promisify(execFile)
const sorted = new Intl.Collator('en', { numeric: true })

const formats: Record<string, [MediaKind, string]> = {
  '.jpg': ['image', 'image/jpeg'],
  '.jpeg': ['image', 'image/jpeg'],
  '.png': ['image', 'image/png'],
  '.webp': ['image', 'image/webp'],
  '.avif': ['image', 'image/avif'],
  '.bmp': ['image', 'image/bmp'],
  '.gif': ['image', 'image/gif'],
  '.mp4': ['video', 'video/mp4'],
  '.m4v': ['video', 'video/mp4'],
  '.webm': ['video', 'video/webm'],
  '.ogv': ['video', 'video/ogg'],
  '.mov': ['video', 'video/quicktime'],
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function inside(root: string, path: string) {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function version(info: Stats) {
  return `${info.ino}-${info.size}-${info.mtimeMs}-${info.ctimeMs}`
}

async function readConfig() {
  try {
    const config = JSON.parse(await readFile(configFile, 'utf8'))
    if (typeof config.mediaRoot !== 'string' || !config.mediaRoot.trim()) throw new Error()
    if (config.thumbnailCache !== undefined && (typeof config.thumbnailCache !== 'string' || !config.thumbnailCache.trim())) {
      throw new Error()
    }
    return {
      root: resolve(dirname(configFile), config.mediaRoot),
      cache: resolve(dirname(configFile), config.thumbnailCache ?? '.miru-cache'),
    }
  } catch {
    throw new HttpError(503, 'Check mediaRoot and thumbnailCache in miru.config.json.')
  }
}

async function resolveEntry(root: string, path: string) {
  const segments = path ? path.split('/') : []
  if (segments.some(segment => !segment || segment.startsWith('.') || segment.includes('\0'))) {
    throw new HttpError(404, 'The requested item could not be found.')
  }
  const requested = resolve(root, ...segments)
  if (!inside(root, requested)) throw new HttpError(404, 'The requested item could not be found.')
  const actual = await realpath(requested)
  if (!inside(root, actual)) throw new HttpError(404, 'The requested item could not be found.')
  return actual
}

function sendJson(response: ServerResponse, status: number, value: unknown, head = false) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
  })
  response.end(head ? undefined : JSON.stringify(value))
}

async function listDirectory(
  root: string, directory: string, path: string, samples: boolean, cache: string,
): Promise<DirectoryListing> {
  const entries = await Promise.all((await readdir(directory, { withFileTypes: true })).map(async dirent => {
    if (dirent.name.startsWith('.')) return
    const item = resolve(directory, dirent.name)
    if (item === cache) return
    const childPath = path ? `${path}/${dirent.name}` : dirent.name
    if (dirent.isDirectory()) return { kind: 'folder', name: dirent.name, path: childPath } as const
    if (!dirent.isFile()) return

    const format = formats[extname(dirent.name).toLowerCase()]
    if (!format) return

    const info = await stat(item).catch(() => undefined)
    if (!info?.isFile()) return
    return { kind: format[0], name: dirent.name, path: childPath, version: version(info), bytes: info.size }
  }))
  return {
    rootId: hash(root).slice(0, 16),
    rootName: basename(root) || root,
    path,
    entries: entries.filter((entry): entry is LibraryEntry => Boolean(entry)).sort((a, b) =>
      Number(b.kind === 'folder') - Number(a.kind === 'folder') || sorted.compare(a.name, b.name)),
    samples,
  }
}

function byteRange(range: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range)
  if (!match || !size || (!match[1] && !match[2])) return
  const from = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const to = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  if (!Number.isSafeInteger(from) || from < 0 || from > to) return
  return { start: from, end: to }
}

function serveFile(
  request: IncomingMessage, response: ServerResponse, file: string, info: Stats, mime: string, cacheControl: string,
) {
  const etag = `"${hash(`${file}:\0${version(info)}`).slice(0, 32)}"`
  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
    'Content-Type': mime,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    ETag: etag,
  }
  if (request.headers['if-none-match']?.split(/\s*,\s*/).some(tag => tag === etag || tag === '*')) {
    response.writeHead(304, headers).end()
    return
  }
  const ifRange = request.headers['if-range']
  const range = !ifRange || ifRange === etag ? request.headers.range : undefined
  const bounds = range ? byteRange(range, info.size) : undefined
  if (range && !bounds) {
    response.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}` }).end()
    return
  }
  if (bounds) {
    response.writeHead(206, {
      ...headers,
      'Content-Length': bounds.end - bounds.start + 1,
      'Content-Range': `bytes ${bounds.start}-${bounds.end}/${info.size}`,
    })
  } else {
    response.writeHead(200, { ...headers, 'Content-Length': info.size })
  }
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  const stream = createReadStream(file, bounds)
  response.on('close', () => stream.destroy())
  stream.on('error', () => response.destroy())
  stream.pipe(response)
}

class Thumbnails {
  #active = 0
  #queue: (() => void)[] = []
  #inflight = new Map<string, Promise<void>>()

  async get(cache: string, file: string, revision: string, kind: MediaKind) {
    const output = resolve(cache, `${hash(`midpoint-jpeg-v2\0${file}\0${revision}`)}.jpg`)
    if (!(await stat(output).catch(() => null))?.size) {
      let pending = this.#inflight.get(output)
      if (!pending) {
        pending = this.#generate(file, output, kind).finally(() => this.#inflight.delete(output))
        this.#inflight.set(output, pending)
      }
      await pending
    }
    return { output, info: await stat(output) }
  }

  async #generate(file: string, output: string, kind: MediaKind) {
    if (this.#active < 3) this.#active++
    else await new Promise<void>(ready => this.#queue.push(ready))
    const temp = `${output}.${randomUUID()}.tmp.jpg`
    const options = { timeout: 30_000, maxBuffer: 256 * 1024 }
    try {
      await mkdir(dirname(output), { recursive: true })
      let midpoint: number | undefined
      if (kind === 'video') {
        const { stdout } = await run('ffprobe', [
          '-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'V:0',
          '-show_entries', 'stream=duration:format=duration', '-of', 'json', '-i', file,
        ], options)
        const { streams, format } = JSON.parse(stdout)
        const streamDuration = Number(streams?.[0]?.duration)
        const duration = streamDuration > 0 ? streamDuration : Number(format?.duration)
        if (duration > 0 && Number.isFinite(duration)) midpoint = duration * 0.5
      }

      const extract = async (seek?: number) => {
        await run('ffmpeg', [
          '-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe',
          ...(seek === undefined ? [] : ['-ss', seek.toFixed(4)]),
          '-i', file, '-map', kind === 'video' ? '0:V:0' : '0:v:0', '-frames:v', '1',
          '-vf', 'scale=480:320:force_original_aspect_ratio=decrease', '-c:v', 'mjpeg', '-q:v', '4', '-update', '1', temp,
        ], options)
        if (!(await stat(temp).catch(() => null))?.size) throw new Error('No thumbnail frame')
      }

      if (midpoint === undefined) await extract()
      else await extract(midpoint).catch(() => extract())
      await rename(temp, output)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HttpError(503, 'Install ffmpeg and ffprobe.')
      }
      throw new HttpError(422, 'Could not generate a thumbnail for this file.')
    } finally {
      await rm(temp, { force: true }).catch(() => {})
      const next = this.#queue.shift()
      if (next) next()
      else this.#active--
    }
  }
}

export function mediaLibrary(): Plugin {
  const thumbnails = new Thumbnails()

  async function route(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (request.method !== 'HEAD' && request.method !== 'GET') {
      response.setHeader('Allow', 'GET, HEAD')
      throw new HttpError(405, 'This operation is not supported.')
    }
    const config = await readConfig()
    const root = await realpath(config.root).catch(() => {
      throw new HttpError(503, 'Could not open the media folder specified in miru.config.json.')
    })
    if (!(await stat(root)).isDirectory()) throw new HttpError(503, 'Set mediaRoot to a folder.')
    const cache = await realpath(config.cache).catch(() => config.cache)
    if (inside(cache, root)) {
      throw new HttpError(503, 'Set thumbnailCache to a location that does not contain the media folder.')
    }
    const path = url.searchParams.get('path') ?? ''
    const file = await resolveEntry(root, path)
    const info = await stat(file)
    if (inside(cache, file)) throw new HttpError(404, 'The requested item could not be found.')

    if (url.pathname === '/api/miru/library' && info.isDirectory()) {
      const listing = await listDirectory(root, file, path, config.root === sampleRoot, cache)
      sendJson(response, 200, listing, request.method === 'HEAD')
      return
    }

    const format = formats[extname(path).toLowerCase()]
    if (info.isFile() && format) {
      if (url.pathname === '/api/miru/file') {
        serveFile(request, response, file, info, format[1], 'private, no-cache')
        return
      }
      if (url.pathname === '/api/miru/thumbnail') {
        const revision = version(info)
        const { output, info: thumbnail } = await thumbnails.get(config.cache, file, revision, format[0])
        const policy = url.searchParams.get('v') === revision ? 'private, max-age=31536000, immutable' : 'private, no-cache'
        serveFile(request, response, output, thumbnail, 'image/jpeg', policy)
        return
      }
    }
    throw new HttpError(404, 'The requested item could not be found.')
  }

  function middleware(request: IncomingMessage, response: ServerResponse, next: () => void) {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/api/miru/')) {
      next()
      return
    }
    void route(request, response, url).catch(error => {
      if (response.headersSent) {
        response.destroy()
        return
      }
      const code = (error as NodeJS.ErrnoException).code
      const status = error instanceof HttpError ? error.status : code === 'ENOENT' ? 404 : code === 'EACCES' ? 403 : 500
      const message = error instanceof HttpError ? error.message : 'Could not load the requested item.'
      sendJson(response, status, { message }, request.method === 'HEAD')
    })
  }

  return {
    name: 'miru-media-library',
    async config() {
      const config = await readConfig().catch(() => null)
      if (!config) return
      const deny = [config.root, config.cache]
        .filter(path => !inside(path, project))
        .map(path => `${path.replaceAll(sep, '/')}/**`)
      return { server: { fs: { deny }, watch: { ignored: deny } } }
    },
    configureServer(server) { server.middlewares.use(middleware) },
    configurePreviewServer(server) { server.middlewares.use(middleware) },
  }
}
