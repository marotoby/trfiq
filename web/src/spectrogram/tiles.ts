// Which tile to fetch for a view. A tile is the overview's layout for a sample window
// (`GET /tile`), drawn over the overview so a zoomed-in view gets full time resolution.
//
// The tile spans the visible time range plus half of it on each side, snapped to a power-of-
// two grid, so small pans and zooms reuse the tile already loaded instead of refetching.

import type { View } from './viewModel'

export interface TileWindow {
  start: number
  count: number
}

/** Below this fraction of the recording visible in time, the view gets a tile. */
export const TILE_BELOW = 0.75
/** A tile is replaced once it is more than this many times the visible span (zoomed in far). */
const MAX_OVERSIZE = 4
/** Most rows in a tile, and most cells (the server's limit). */
const MAX_ROWS = 2048
const MAX_CELLS = 16 << 20

/** Rows to ask for in a tile at this FFT size. */
export function tileRows(fft: number): number {
  return Math.max(1, Math.min(MAX_ROWS, Math.floor(MAX_CELLS / fft)))
}

/**
 * The tile for `view` of a recording of `n` samples: `current` if it still covers the view
 * well, a new window if not, or null when the overview is enough (zoomed out).
 */
export function tileFor(view: View, n: number, current: TileWindow | null): TileWindow | null {
  const s0 = Math.max(0, Math.floor(view.y0 * n))
  const s1 = Math.min(n, Math.ceil(view.y1 * n))
  const visible = s1 - s0
  if (n <= 0 || visible <= 0 || visible >= TILE_BELOW * n) return null
  if (current && current.start <= s0 && s1 <= current.start + current.count && current.count <= MAX_OVERSIZE * visible)
    return current
  const q = 2 ** Math.floor(Math.log2(Math.max(1, visible / 4)))
  const start = Math.max(0, Math.floor((s0 - visible / 2) / q) * q)
  const end = Math.min(n, Math.ceil((s1 + visible / 2) / q) * q)
  return { start, count: end - start }
}
