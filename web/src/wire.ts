// Wire format of the binary sample endpoints, decoded into plot-ready values. The server's
// counterpart is crates/server/src/wire.rs; the fixtures in ./wire-fixtures are written by it
// and decoded by wire.test.ts, so a layout change on one side only fails a test.
//
// Bodies are little-endian, which every browser platform we target is too, so typed arrays
// view them directly.

/** Quantised dB: `dB = dbMin + q × dbStep` (ADR 0002). */
export interface Quant {
  dbMin: number
  dbStep: number
}

/** dB of a quantised value. */
export const dbOf = (q: Quant, v: number) => q.dbMin + v * q.dbStep

/** The `Server-Timing` breakdown, in milliseconds. */
export interface Timing {
  readMs: number
  computeMs: number
}

/** Spectrogram rows of a sample window: the whole recording (overview) or part of it (tile).
 * Row `i` covers the `i`-th of `rows` equal slots of the window. */
export interface Overview {
  /** strided: one FFT from the middle of each slot; full: back-to-back FFTs, every sample used. */
  mode: 'strided' | 'full'
  fft: number
  rows: number
  start: number
  count: number
  quant: Quant
  /** `rows × fft` quantised dB, fftshifted, row-major. */
  data: Uint16Array
  timing: Timing | null
}

/** A tile is an overview of part of the recording. */
export type Tile = Overview

interface Window {
  start: number
  count: number
  timing: Timing | null
}

/** Every sample of the window, normalised to ±1. */
export interface TimeRaw extends Window {
  mode: 'raw'
  i: Float32Array
  q: Float32Array
}

/** Min/max of `buckets` equal buckets across the window: `minmax` from every sample, `sampled`
 * from an evenly spaced slice of each (windows over the detail cap). */
export interface TimeEnvelope extends Window {
  mode: 'minmax' | 'sampled'
  buckets: number
  iMin: Float32Array
  iMax: Float32Array
  qMin: Float32Array
  qMax: Float32Array
}

export type TimeData = TimeRaw | TimeEnvelope

/** Power spectrum (dBFS, fftshifted): mean and max-hold over FFT segments. */
export interface PsdData extends Window {
  /** full: every segment in the window; strided: evenly spaced ones (window over the cap). */
  mode: 'full' | 'strided'
  fft: number
  segments: number
  mean: Float32Array
  max: Float32Array
}

/**
 * dB at percentiles `ps` (0–1) of an overview's non-empty cells, from up to `maxSamples` of
 * them; null when every cell is empty (−200 dB or below).
 */
export function dbPercentiles(o: Pick<Overview, 'data' | 'quant'>, ps: number[], maxSamples = 200_000): number[] | null {
  const stride = Math.max(1, Math.floor(o.data.length / maxSamples))
  const sample: number[] = []
  for (let i = 0; i < o.data.length; i += stride) if (o.data[i] > 0) sample.push(o.data[i])
  if (!sample.length) return null
  sample.sort((a, b) => a - b)
  return ps.map((p) => dbOf(o.quant, sample[Math.min(sample.length - 1, Math.floor(p * sample.length))]))
}

export class WireError extends Error {}

type Get = (name: string) => string | null

function num(get: Get, name: string): number {
  const v = Number(get(name))
  if (get(name) == null || !Number.isFinite(v)) throw new WireError(`missing or bad header ${name}`)
  return v
}

function oneOf<T extends string>(get: Get, name: string, allowed: readonly T[]): T {
  const v = get(name)
  if (!allowed.includes(v as T)) throw new WireError(`unexpected ${name}: ${v}`)
  return v as T
}

export function parseTiming(v: string | null): Timing | null {
  const m = v?.match(/read;dur=([\d.]+).*compute;dur=([\d.]+)/)
  return m ? { readMs: Number(m[1]), computeMs: Number(m[2]) } : null
}

/** Split interleaved records of `width` floats into one array per field. */
function deinterleave(all: Float32Array, width: number): Float32Array[] {
  const n = Math.floor(all.length / width)
  const out = Array.from({ length: width }, () => new Float32Array(n))
  for (let k = 0; k < n; k++) for (let f = 0; f < width; f++) out[f][k] = all[k * width + f]
  return out
}

export function decodeOverview(get: Get, body: ArrayBuffer): Overview {
  const fft = num(get, 'x-trfiq-fft')
  const rows = num(get, 'x-trfiq-rows')
  const data = new Uint16Array(body)
  if (data.length !== fft * rows) throw new WireError(`overview body has ${data.length} values, expected ${fft}×${rows}`)
  return {
    mode: oneOf(get, 'x-trfiq-mode', ['strided', 'full'] as const),
    fft,
    rows,
    start: num(get, 'x-trfiq-start'),
    count: num(get, 'x-trfiq-count'),
    quant: { dbMin: num(get, 'x-trfiq-db-min'), dbStep: num(get, 'x-trfiq-db-step') },
    data,
    timing: parseTiming(get('server-timing')),
  }
}

export function decodeTime(get: Get, body: ArrayBuffer): TimeData {
  const mode = oneOf(get, 'x-trfiq-mode', ['raw', 'minmax', 'sampled'] as const)
  const base = { start: num(get, 'x-trfiq-start'), count: num(get, 'x-trfiq-count'), timing: parseTiming(get('server-timing')) }
  const all = new Float32Array(body)
  if (mode === 'raw') {
    const [i, q] = deinterleave(all, 2)
    return { ...base, mode, i, q }
  }
  const [iMin, iMax, qMin, qMax] = deinterleave(all, 4)
  return { ...base, mode, buckets: iMin.length, iMin, iMax, qMin, qMax }
}

export function decodePsd(get: Get, body: ArrayBuffer): PsdData {
  const fft = num(get, 'x-trfiq-fft')
  const all = new Float32Array(body)
  if (all.length !== 2 * fft) throw new WireError(`psd body has ${all.length} values, expected 2×${fft}`)
  return {
    mode: oneOf(get, 'x-trfiq-mode', ['full', 'strided'] as const),
    fft,
    segments: num(get, 'x-trfiq-segments'),
    start: num(get, 'x-trfiq-start'),
    count: num(get, 'x-trfiq-count'),
    mean: all.subarray(0, fft),
    max: all.subarray(fft, 2 * fft),
    timing: parseTiming(get('server-timing')),
  }
}
