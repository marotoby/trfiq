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

export const WINDOWS = ['hann', 'blackman-harris', 'rect'] as const
export type WindowFn = (typeof WINDOWS)[number]

export interface Overview {
  data: Uint16Array
  fft: number
  rows: number
  dbMin: number
  dbStep: number
  mode: string
  timing: string
}

/** Time-domain I/Q (normalised to ±1) for a window of samples. */
export interface TimeData {
  /** raw: `count × [i, q]`. minmax / sampled: `points × [iMin, iMax, qMin, qMax]`. */
  mode: 'raw' | 'minmax' | 'sampled'
  start: number
  count: number
  points: number
  data: Float32Array
  timing: string
}

/** Power spectrum (dBFS, fftshifted) of a window: mean and max-hold over FFT segments. */
export interface PsdData {
  /** full: every segment in the window; strided: evenly spaced segments (window > 2M samples). */
  mode: 'full' | 'strided'
  fft: number
  segments: number
  start: number
  count: number
  mean: Float32Array
  max: Float32Array
  timing: string
}

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
  sources: (signal?: AbortSignal) => json<SourceInfo[]>('/api/sources', signal),

  rescan: async (id: string) => {
    await check(await fetch(`/api/sources/${encodeURIComponent(id)}/rescan`, { method: 'POST' }))
  },

  recordings: (p: ListParams, signal?: AbortSignal) =>
    json<Recording[]>(`/api/recordings${qs({ ...p })}`, signal),

  recording: (id: number, signal?: AbortSignal) =>
    json<RecordingDetail>(`/api/recordings/${id}`, signal),

  overview: async (
    id: number,
    p: { fft: number; rows: number; window: WindowFn },
    signal?: AbortSignal,
  ): Promise<Overview> => {
    const r = await check(await fetch(`/api/recordings/${id}/overview${qs(p)}`, { signal }))
    const h = (k: string) => r.headers.get(k) ?? ''
    const buf = await r.arrayBuffer()
    return {
      // The server sends little-endian u16; every browser platform we target is little-endian.
      data: new Uint16Array(buf),
      fft: Number(h('x-trfiq-fft')),
      rows: Number(h('x-trfiq-rows')),
      dbMin: Number(h('x-trfiq-db-min')),
      dbStep: Number(h('x-trfiq-db-step')),
      mode: h('x-trfiq-mode'),
      timing: h('server-timing'),
    }
  },

  time: async (id: number, p: WindowParams & { points: number }, signal?: AbortSignal): Promise<TimeData> => {
    const r = await check(await fetch(`/api/recordings/${id}/time${qs({ ...p })}`, { signal }))
    const h = (k: string) => r.headers.get(k) ?? ''
    return {
      mode: h('x-trfiq-mode') as TimeData['mode'],
      start: Number(h('x-trfiq-start')),
      count: Number(h('x-trfiq-count')),
      points: Number(h('x-trfiq-points')),
      data: new Float32Array(await r.arrayBuffer()),
      timing: h('server-timing'),
    }
  },

  psd: async (
    id: number,
    p: WindowParams & { fft: number; window: WindowFn },
    signal?: AbortSignal,
  ): Promise<PsdData> => {
    const r = await check(await fetch(`/api/recordings/${id}/psd${qs({ ...p })}`, { signal }))
    const h = (k: string) => r.headers.get(k) ?? ''
    const fft = Number(h('x-trfiq-fft'))
    const all = new Float32Array(await r.arrayBuffer())
    return {
      mode: h('x-trfiq-mode') as PsdData['mode'],
      fft,
      segments: Number(h('x-trfiq-segments')),
      start: Number(h('x-trfiq-start')),
      count: Number(h('x-trfiq-count')),
      mean: all.subarray(0, fft),
      max: all.subarray(fft, 2 * fft),
      timing: h('server-timing'),
    }
  },
}
