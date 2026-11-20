export type MediaKind = 'image' | 'video'

export interface MediaEntry {
  kind: MediaKind
  path: string
  name: string
  version: string
  bytes: number
}

export interface FolderEntry {
  kind: 'folder'
  path: string
  name: string
}

export type LibraryEntry = MediaEntry | FolderEntry

export interface DirectoryListing {
  rootId: string
  rootName: string
  path: string
  entries: LibraryEntry[]
  samples: boolean
}

export function mediaUrl(entry: MediaEntry, route: 'file' | 'thumbnail' = 'file') {
  return `/api/miru/${route}?${new URLSearchParams({ path: entry.path, v: entry.version })}`
}

export async function fetchDirectory(path: string, signal?: AbortSignal): Promise<DirectoryListing> {
  const response = await fetch(`/api/miru/library?${new URLSearchParams({ path })}`, { signal })
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(error?.message || 'Could not load the folder.')
  }
  return response.json()
}
