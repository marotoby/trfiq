// Recording geometry: where a sample or a frequency sits in the spectrogram, and how to show it.
//
// The spectrogram texture is [0, 1]² (see View): x is frequency (fftshifted bins left to
// right), y is time (row i of R covers the i-th R-th of the recording, ADR 0006). Everything
// that converts between texture space, sample indices, frequencies and the labels on screen
// goes through one Geometry, built per (recording, FFT size).

import * as fmt from './format'

/** Texture-space rectangle, as used by the spectrogram view. */
export interface Rect {
  x0: number
  x1: number
  y0: number
  y1: number
}

/** The sample window and frequency range a view rectangle covers. */
export interface DetailWindow {
  start: number
  count: number
  /** Visible frequency range, in the geometry's frequency unit. */
  fLo: number
  fHi: number
}

export interface Geometry {
  readonly fft: number
  readonly numSamples: number
  /** Frequency at texture x. */
  freqAt(x: number): number
  /** Texture x of a frequency (inverse of freqAt). */
  xAt(freq: number): number
  /** Frequency of fftshifted bin k (0 ≤ k < fft). */
  binFreq(k: number): number
  /** Time of a sample index, in the geometry's time unit. */
  timeOf(sample: number): number
  /** Sample index at a time (inverse of timeOf). */
  sampleOf(time: number): number
  /** Time at texture y. */
  timeAt(y: number): number
  /** Texture y of a sample index. */
  yOf(sample: number): number
  /** Length of the recording, in the time unit. */
  readonly duration: number
  /** The samples and frequencies a view rectangle covers, clamped to the recording. */
  window(view: Rect): DetailWindow
  formatFreq(freq: number, digits?: number): string
  formatTime(time: number): string
}

export interface RecordingLike {
  center_freq: number | null
  sample_rate: number | null
  num_samples: number | null
}

export function geometry(r: RecordingLike, fft: number): Geometry {
  const n = Math.max(1, r.num_samples ?? 0)
  const sr = r.sample_rate ?? 1
  const cf = r.center_freq ?? 0
  const clamp = (x: number) => Math.min(1, Math.max(0, x))
  const freqAt = (x: number) => cf + (x - 0.5) * sr
  const g: Geometry = {
    fft,
    numSamples: n,
    freqAt,
    xAt: (f) => (f - cf) / sr + 0.5,
    binFreq: (k) => cf + ((k - fft / 2) * sr) / fft,
    timeOf: (s) => s / sr,
    sampleOf: (t) => t * sr,
    timeAt: (y) => (y * n) / sr,
    yOf: (s) => s / n,
    duration: n / sr,
    window(view) {
      const y0 = clamp(Math.min(view.y0, view.y1))
      const y1 = clamp(Math.max(view.y0, view.y1))
      const start = Math.min(Math.floor(y0 * n), n - 1)
      return {
        start,
        count: Math.max(1, Math.min(n - start, Math.ceil((y1 - y0) * n))),
        fLo: freqAt(Math.min(view.x0, view.x1)),
        fHi: freqAt(Math.max(view.x0, view.x1)),
      }
    },
    formatFreq: (f, digits = 6) => fmt.hz(f, digits),
    formatTime: (t) => fmt.seconds(t),
  }
  return g
}
