import { describe, expect, test } from 'bun:test'
import { tileFor, tileRows } from './tiles'

const N = 1 << 24
const view = (y0: number, y1: number) => ({ x0: 0, x1: 1, y0, y1 })

describe('tileFor', () => {
  test('no tile while the overview is enough', () => {
    expect(tileFor(view(0, 1), N, null)).toBeNull()
    expect(tileFor(view(0.1, 0.9), N, null)).toBeNull()
  })

  test('a zoomed view gets a padded, grid-aligned tile that covers it', () => {
    const t = tileFor(view(0.5, 0.51), N, null)!
    const s0 = 0.5 * N
    const s1 = Math.ceil(0.51 * N)
    expect(t.start).toBeLessThanOrEqual(s0 - (s1 - s0) / 2)
    expect(t.start + t.count).toBeGreaterThanOrEqual(s1 + (s1 - s0) / 2)
    expect(t.count).toBeLessThan(3 * (s1 - s0))
    const q = 2 ** Math.floor(Math.log2((s1 - s0) / 4))
    expect(t.start % q).toBe(0)
  })

  test('small pans keep the tile; leaving it or zooming far in replaces it', () => {
    const t = tileFor(view(0.5, 0.51), N, null)!
    expect(tileFor(view(0.502, 0.512), N, t)).toBe(t)
    expect(tileFor(view(0.52, 0.53), N, t)).not.toBe(t)
    expect(tileFor(view(0.5, 0.501), N, t)).not.toBe(t)
  })

  test('stays inside the recording', () => {
    const t = tileFor(view(0, 0.01), N, null)!
    expect(t.start).toBe(0)
    const u = tileFor(view(0.995, 1), N, null)!
    expect(u.start + u.count).toBe(N)
  })
})

test('tile rows respect the server cell limit', () => {
  expect(tileRows(1024)).toBe(2048)
  expect(tileRows(16384)).toBe(1024)
  expect(tileRows(65536) * 65536).toBeLessThanOrEqual(16 << 20)
})
