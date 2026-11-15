// Decodes the fixtures crates/server/src/wire.rs writes, so both sides agree on every layout.
import { describe, expect, test } from 'bun:test'
import { dbOf, dbPercentiles, decodeOverview, decodePsd, decodeTime, parseTiming, WireError } from './wire'

async function fixture(name: string) {
  const f = await Bun.file(new URL(`./wire-fixtures/${name}.json`, import.meta.url)).json()
  const bytes = Uint8Array.from((f.body_hex as string).match(/../g) ?? [], (h) => parseInt(h, 16))
  const get = (k: string) => (f.headers as Record<string, string>)[k] ?? null
  return { get, body: bytes.buffer }
}

const close = (a: ArrayLike<number>, b: number[]) => expect(Array.from(a)).toEqual(b)

describe('wire fixtures from the server', () => {
  test('overview', async () => {
    const { get, body } = await fixture('overview')
    const o = decodeOverview(get, body)
    expect([o.mode, o.fft, o.rows, o.start, o.count]).toEqual(['strided', 4, 2, 0, 1_000_000])
    expect(o.timing).toEqual({ readMs: 1.5, computeMs: 2 })
    close(o.data, [0, 1, 40000, 65535, 20000, 20001, 20002, 20003])
    expect(dbOf(o.quant, 0)).toBe(-200)
    expect(dbOf(o.quant, 40000)).toBeCloseTo(0, 6)
  })

  test('tile', async () => {
    const { get, body } = await fixture('tile')
    const t = decodeOverview(get, body)
    expect([t.mode, t.fft, t.rows, t.start, t.count]).toEqual(['full', 4, 2, 4096, 8])
    close(t.data, [100, 200, 300, 400, 500, 600, 700, 800])
  })

  test('raw time samples', async () => {
    const { get, body } = await fixture('time-raw')
    const t = decodeTime(get, body)
    if (t.mode !== 'raw') throw new Error(t.mode)
    expect([t.start, t.count]).toEqual([10, 3])
    close(t.i, [0.5, 1, -1])
    close(t.q, [-0.5, 0, 0.25])
  })

  test('min/max envelopes', async () => {
    for (const [name, mode, start, count] of [['time-minmax', 'minmax', 0, 100_000], ['time-sampled', 'sampled', 5, 9_000_000]] as const) {
      const { get, body } = await fixture(name)
      const t = decodeTime(get, body)
      if (t.mode === 'raw') throw new Error('raw')
      expect([t.mode, t.start, t.count]).toEqual([mode, start, count])
      expect(t.buckets).toBe(Number(get('x-trfiq-points')))
      expect(t.iMin[0]).toBe(-1)
      expect(t.iMax[0]).toBe(1)
      expect(t.qMin[0]).toBe(-0.5)
      expect(t.qMax[0]).toBe(0.5)
    }
  })

  test('psd', async () => {
    const { get, body } = await fixture('psd')
    const p = decodePsd(get, body)
    expect([p.mode, p.fft, p.segments, p.start, p.count]).toEqual(['strided', 4, 2048, 1000, 5_000_000])
    close(p.mean, [-100, -90, -6, -95])
    close(p.max, [-80, -70, -3, -75])
  })
})

describe('decoding rejects what it does not understand', () => {
  test('unknown modes and short bodies', async () => {
    const { get, body } = await fixture('psd')
    expect(() => decodePsd((k) => (k === 'x-trfiq-mode' ? 'welch' : get(k)), body)).toThrow(WireError)
    expect(() => decodePsd(get, body.slice(4))).toThrow(WireError)
    expect(() => decodeOverview((k) => (k === 'x-trfiq-fft' ? null : get(k)), body)).toThrow(WireError)
  })

  test('timing is optional', () => {
    expect(parseTiming(null)).toBeNull()
    expect(parseTiming('total;dur=3')).toBeNull()
  })
})

test('dB percentiles skip empty cells', () => {
  const quant = { dbMin: -200, dbStep: 0.005 }
  const data = new Uint16Array([0, 0, 20000, 30000, 40000])
  expect(dbPercentiles({ data, quant }, [0, 0.999])).toEqual([-100, 0])
  expect(dbPercentiles({ data: new Uint16Array(3), quant }, [0.5])).toBeNull()
})
