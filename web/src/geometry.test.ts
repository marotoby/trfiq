import { describe, expect, test } from 'bun:test'
import { toPlot, type Annotation } from './annotations'
import { geometry } from './geometry'

const rec = { center_freq: 433.92e6, sample_rate: 2e6, num_samples: 4_000_000 }

describe('geometry', () => {
  const g = geometry(rec, 1024)

  test('frequency and texture x round-trip', () => {
    for (const x of [0, 0.25, 0.5, 0.9]) expect(g.xAt(g.freqAt(x))).toBeCloseTo(x, 12)
  })

  test('the view spans one sample rate', () => {
    expect(g.freqAt(1) - g.freqAt(0)).toBeCloseTo(rec.sample_rate, 3)
  })

  test('bins are one bin width apart, DC bin at the centre frequency', () => {
    expect(g.binFreq(512)).toBe(rec.center_freq)
    expect(g.binFreq(513) - g.binFreq(512)).toBeCloseTo(rec.sample_rate / 1024, 6)
  })

  test('time follows sample index and texture y', () => {
    expect(g.timeOf(2_000_000)).toBe(1)
    expect(g.sampleOf(1)).toBe(2_000_000)
    expect(g.timeAt(0.5)).toBe(1)
    expect(g.yOf(1_000_000)).toBe(0.25)
    expect(g.duration).toBe(2)
  })

  test('a view rectangle becomes a clamped sample window', () => {
    expect(g.window({ x0: 0, x1: 1, y0: 0, y1: 1 })).toMatchObject({ start: 0, count: 4_000_000 })
    expect(g.window({ x0: 0, x1: 1, y0: 0.25, y1: 0.5 })).toMatchObject({ start: 1_000_000, count: 1_000_000 })
    // Upside-down and out-of-range rectangles are normalised.
    expect(g.window({ x0: 0, x1: 1, y0: 1.5, y1: 0.75 })).toMatchObject({ start: 3_000_000, count: 1_000_000 })
    // Never empty, never past the end.
    expect(g.window({ x0: 0, x1: 1, y0: 1, y1: 1 })).toMatchObject({ start: 3_999_999, count: 1 })
    const w = g.window({ x0: 0.75, x1: 0.25, y0: 0, y1: 1 })
    expect(w.fLo).toBe(g.freqAt(0.25))
    expect(w.fHi).toBe(g.freqAt(0.75))
  })
})

describe('annotations on the spectrogram', () => {
  const g = geometry(rec, 1024)
  const ann = (fLo: number | null, fHi: number | null): Annotation => ({
    id: 0, start: 1_000_000, count: 2_000_000, fLo, fHi, label: 'x', comment: null, color: '#fff',
  })

  test('cover their samples and band', () => {
    const p = toPlot(ann(433.42e6, 434.42e6), g)
    expect(p.y0).toBe(0.25)
    expect(p.y1).toBe(0.75)
    expect(g.freqAt(p.x0)).toBeCloseTo(433.42e6, 3)
    expect(g.freqAt(p.x1)).toBeCloseTo(434.42e6, 3)
  })

  test('without frequency edges span the whole band', () => {
    const p = toPlot(ann(null, null), g)
    expect([p.x0, p.x1]).toEqual([0, 1])
  })
})
