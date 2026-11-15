// Typed client for the trfiq HTTP API. Every call takes an AbortSignal so TanStack Query can
// cancel requests that are no longer needed (and the server stops the work, see api.rs).

export type Status = 'ok' | 'needs_meta' | 'broken'

export interface Recording {
  id: number
  source: string
  stem: string
  name: string
  data_key: string | null
  meta_key: string | null
  size: number | null
  last_modified: string | null
  status: Status
  error: string | null
  datatype: string | null
  sample_rate: number | null
  center_freq: number | null
  datetime: string | null
  description: string | null
  author: string | null
  hw: string | null
  labels: string[]
  annotation_count: number
  user_meta: boolean
  num_samples: number | null
  /** Decided by the index: whether the samples can be read and drawn. */
  viewable: boolean
  /** Why not, when `viewable` is false. */
  not_viewable_reason: string | null
}

export interface RecordingDetail extends Recording {
  meta: unknown
}

export interface ScanStats {
  objects: number
  recordings: number
  updated: number
  removed: number
  duration_ms: number
}

export interface SourceInfo {
  id: string
  name: string
  kind: 's3' | 'local'
  scan: {
    scanning: boolean
    last_scan_unix: number | null
    last_error: string | null
    last_stats: ScanStats | null
    ready: boolean
  }
  counts: Partial<Record<Status, number>>
}

export interface ListParams {
  q?: string
  source?: string
  status?: Status
}

import { decodeOverview, decodePsd, decodeTime, type Overview, type PsdData, type Tile, type TimeData } from './wire'

export type { Overview, PsdData, Tile, TimeData } from './wire'

export const WINDOWS = ['hann', 'blackman-harris', 'rect'] as const
export type WindowFn = (typeof WINDOWS)[number]

export interface WindowParams {
  start: number
  count: number
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

async function check(r: Response): Promise<Response> {
  if (r.ok) return r
  let msg = `${r.status} ${r.statusText}`
  try {
    const body = await r.json()
    if (body?.error) msg = body.error
  } catch {
    /* not JSON */
  }
  throw new ApiError(r.status, msg)
}

/** Where the UI is served from (vite `--base`), without the trailing slash; the API sits beside it. */
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')

async function json<T>(url: string, signal?: AbortSignal): Promise<T> {
  return (await check(await fetch(url, { signal }))).json()
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

export const api = {
  sources: (signal?: AbortSignal) => json<SourceInfo[]>(`${BASE}/api/sources`, signal),

  rescan: async (id: string) => {
    await check(await fetch(`${BASE}/api/sources/${encodeURIComponent(id)}/rescan`, { method: 'POST' }))
  },

  recordings: (p: ListParams, signal?: AbortSignal) =>
    json<Recording[]>(`${BASE}/api/recordings${qs({ ...p })}`, signal),

  recording: (id: number, signal?: AbortSignal) =>
    json<RecordingDetail>(`${BASE}/api/recordings/${id}`, signal),

  overview: async (
    id: number,
    p: { fft: number; rows: number; window: WindowFn },
    signal?: AbortSignal,
  ): Promise<Overview> => {
    const r = await check(await fetch(`${BASE}/api/recordings/${id}/overview${qs(p)}`, { signal }))
    return decodeOverview((k) => r.headers.get(k), await r.arrayBuffer())
  },

  /** The overview's layout for part of the recording (full time resolution when zoomed in). */
  tile: async (
    id: number,
    p: WindowParams & { fft: number; rows: number; window: WindowFn },
    signal?: AbortSignal,
  ): Promise<Tile> => {
    const r = await check(await fetch(`${BASE}/api/recordings/${id}/tile${qs({ ...p })}`, { signal }))
    return decodeOverview((k) => r.headers.get(k), await r.arrayBuffer())
  },

  time: async (id: number, p: WindowParams & { points: number }, signal?: AbortSignal): Promise<TimeData> => {
    const r = await check(await fetch(`${BASE}/api/recordings/${id}/time${qs({ ...p })}`, { signal }))
    return decodeTime((k) => r.headers.get(k), await r.arrayBuffer())
  },

  psd: async (
    id: number,
    p: WindowParams & { fft: number; window: WindowFn },
    signal?: AbortSignal,
  ): Promise<PsdData> => {
    const r = await check(await fetch(`${BASE}/api/recordings/${id}/psd${qs({ ...p })}`, { signal }))
    return decodePsd((k) => r.headers.get(k), await r.arrayBuffer())
  },
}
