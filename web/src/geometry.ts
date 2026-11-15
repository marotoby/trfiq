// Recording geometry: where a sample or a frequency sits in the spectrogram, and how to show it.
//
// The spectrogram texture is [0, 1]² (see View): x is frequency (fftshifted bins left to
// right), y is time (row i of R covers the i-th R-th of the recording, ADR 0006). Everything
// that converts between texture space, sample indices, frequencies and the labels on screen
// goes through one Geometry, built per (recording, FFT size).
//
// Texel k of a row is FFT bin k, so its centre, x = (k + ½)/fft, is at the bin's frequency
// cf + (k − fft/2)·sr/fft. The band therefore runs from half a bin below cf − sr/2 to half a
// bin below cf + sr/2.
//
// Without a sample rate there are no Hz or seconds: frequencies are in cycles per sample
// (−0.5 to 0.5) and times in samples. Without a centre frequency, frequencies are relative to
// the band centre (0 Hz).

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
  /** The sample rate is known: Hz and seconds. Otherwise cycles/sample and samples. */
  readonly calibrated: boolean
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
  const calibrated = !!r.sample_rate && r.sample_rate > 0
  const sr = calibrated ? r.sample_rate! : 1
  const cf = calibrated ? (r.center_freq ?? 0) : 0
  const clamp = (x: number) => Math.min(1, Math.max(0, x))
  // Texture x of the DC bin's centre: half a bin right of the middle.
  const xDc = 0.5 + 0.5 / fft
  const freqAt = (x: number) => cf + (x - xDc) * sr
  const g: Geometry = {
    fft,
    numSamples: n,
    calibrated,
    freqAt,
    xAt: (f) => (f - cf) / sr + xDc,
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
    formatFreq: (f, digits = 6) => (calibrated ? fmt.hz(f, digits) : fmt.cycles(f, digits)),
    formatTime: (t) => (calibrated ? fmt.seconds(t) : fmt.samples(t)),
  }
  return g
}
