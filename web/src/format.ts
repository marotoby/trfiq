const SI = [
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
] as const

function si(v: number, unit: string, digits = 3): string {
  const a = Math.abs(v)
  for (const [scale, prefix] of SI) {
    if (a >= scale) return `${+(v / scale).toPrecision(digits)} ${prefix}${unit}`
  }
  return `${+v.toPrecision(digits)} ${unit}`
}

export const hz = (v: number | null | undefined, digits = 6) => (v == null ? '—' : si(v, 'Hz', digits))
export const sps = (v: number | null | undefined) => (v == null ? '—' : si(v, 'S/s', 4))

/** A sample count or index, e.g. `512 samples`, `1.5M samples`. */
export function samples(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return '—'
  for (const [scale, prefix] of SI) {
    if (Math.abs(v) >= scale) return `${+(v / scale).toPrecision(4)}${prefix} samples`
  }
  return `${+v.toPrecision(4)} samples`
}

/** A normalised frequency in cycles per sample (−0.5 to 0.5 across the band). */
export function cycles(v: number | null | undefined, digits = 4): string {
  if (v == null || !isFinite(v)) return '—'
  return `${Math.abs(v) < 1e-12 ? 0 : +v.toPrecision(Math.min(digits, 5))} cyc/sample`
}

export function bytes(v: number | null | undefined): string {
  if (v == null) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${+v.toPrecision(3)} ${units[i]}`
}

export function seconds(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a === 0) return '0 s'
  if (a < 1e-3) return `${+(v * 1e6).toPrecision(3)} µs`
  if (a < 1) return `${+(v * 1e3).toPrecision(3)} ms`
  if (a < 120) return `${+v.toPrecision(4)} s`
  const m = Math.floor(a / 60)
  return `${m}m ${Math.round(a - m * 60)}s`
}

export function duration(r: { num_samples: number | null; sample_rate: number | null }) {
  return r.num_samples != null && r.sample_rate ? r.num_samples / r.sample_rate : null
}

export function ago(unix: number | null): string {
  if (unix == null) return 'never'
  const s = Math.max(0, Date.now() / 1000 - unix)
  if (s < 60) return `${Math.round(s)}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

/** "Nice" tick values covering [a, b], about `count` of them. */
export function ticks(a: number, b: number, count: number): number[] {
  const span = b - a
  if (!(span > 0) || !isFinite(span)) return []
  const raw = span / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag
  const out: number[] = []
  for (let v = Math.ceil(a / step) * step; v <= b + step * 1e-9; v += step) out.push(v)
  return out
}
