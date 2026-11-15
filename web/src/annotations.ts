// SigMF annotations → plot rectangles in [0,1] texture space.

import type { Geometry } from './geometry'
import type { PlotAnnotation } from './spectrogram/SpectrogramView'

export interface Annotation {
  id: number
  start: number
  count: number
  fLo: number | null
  fHi: number | null
  label: string
  comment: string | null
  color: string
}

const PALETTE = ['#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#fb7185', '#22d3ee', '#fb923c', '#a3e635']

/** Stable colour per label, so the same signal type looks the same everywhere. */
export function labelColor(label: string): string {
  let h = 0
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

export function parseAnnotations(meta: unknown): Annotation[] {
  const list = (meta as { annotations?: unknown })?.annotations
  if (!Array.isArray(list)) return []
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return list.flatMap((a, id) => {
    const start = num(a?.['core:sample_start'])
    if (start == null) return []
    const label = typeof a['core:label'] === 'string' && a['core:label'] ? a['core:label'] : 'annotation'
    return [
      {
        id,
        start,
        count: num(a['core:sample_count']) ?? 1,
        fLo: num(a['core:freq_lower_edge']),
        fHi: num(a['core:freq_upper_edge']),
        label,
        comment: typeof a['core:comment'] === 'string' ? a['core:comment'] : null,
        color: labelColor(label),
      },
    ]
  })
}

export function toPlot(a: Annotation, g: Geometry): PlotAnnotation {
  // Missing frequency edges mean "the whole band".
  const x = (f: number | null, dflt: number) => (f == null ? dflt : g.xAt(f))
  return {
    id: a.id,
    label: a.label,
    color: a.color,
    x0: x(a.fLo, 0),
    x1: x(a.fHi, 1),
    y0: g.yOf(a.start),
    y1: g.yOf(a.start + a.count),
  }
}
