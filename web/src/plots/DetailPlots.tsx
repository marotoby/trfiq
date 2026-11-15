// Detail plots for the time window visible in the spectrogram: power spectrum (mean and
// max-hold) and time-domain I/Q. The server does the reading and maths (capped at ~2M
// samples per request); the browser only draws a few thousand points.

import { useEffect, useRef, type ReactNode } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { api, type PsdData, type RecordingDetail, type TimeData, type WindowFn } from '../api'
import type { Annotation } from '../annotations'
import * as fmt from '../format'
import { Icon, type IconName } from '../ui'

/** Envelope buckets requested for the time plot (≈ one per pixel on a wide screen). */
const TIME_POINTS = 2048

const C = {
  axis: '#8b93a5',
  grid: 'rgba(255, 255, 255, 0.055)',
  i: '#22d3ee',
  q: 'rgba(244, 114, 182, 0.6)',
  mean: '#22d3ee',
  max: 'rgba(251, 191, 36, 0.75)',
  font: '11px Inter, ui-sans-serif, system-ui, sans-serif',
}

function axis(format: (v: number) => string, extra: Partial<uPlot.Axis> = {}): uPlot.Axis {
  return {
    stroke: C.axis,
    font: C.font,
    grid: { stroke: C.grid, width: 1 },
    ticks: { stroke: C.grid, width: 1, size: 4 },
    values: (_u, splits) => splits.map(format),
    ...extra,
  }
}

/** A uPlot instance that lives as long as the component and tracks its container's size. */
function usePlot(
  makeOpts: () => Omit<uPlot.Options, 'width' | 'height'>,
  data: uPlot.AlignedData | null,
  afterData?: (u: uPlot) => void,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const after = useRef(afterData)
  after.current = afterData

  useEffect(() => {
    const host = hostRef.current!
    // uPlot's height excludes its legend, which it appends below the canvas.
    const size = () => ({
      width: host.clientWidth,
      height: Math.max(60, host.clientHeight - (host.querySelector<HTMLElement>('.u-legend')?.offsetHeight ?? 0)),
    })
    const u = new uPlot({ ...makeOpts(), ...size() }, [[]], host)
    u.setSize(size())
    plotRef.current = u
    const ro = new ResizeObserver(() => u.setSize(size()))
    ro.observe(host)
    return () => {
      ro.disconnect()
      u.destroy()
      plotRef.current = null
    }
    // Options are fixed for the plot's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const u = plotRef.current
    if (!u || !data) return
    u.setData(data)
    after.current?.(u)
  }, [data])

  return { hostRef, plotRef }
}

function PlotCard(props: {
  icon: IconName
  title: string
  info: ReactNode
  loading: boolean
  error: Error | null
  testId: string
  children: ReactNode
}) {
  return (
    <section className="detail-card" data-testid={props.testId}>
      <header className="detail-head">
        <h3>
          <Icon name={props.icon} /> {props.title}
        </h3>
        <span className="detail-info">{props.info}</span>
      </header>
      {props.loading && <div className="loading-bar" />}
      {props.error ? <div className="error small">{props.error.message}</div> : props.children}
    </section>
  )
}

export interface DetailWindow {
  start: number
  count: number
  /** Visible frequency range (Hz), for the spectrum's x axis. */
  fLo: number
  fHi: number
}

// ---- spectrum ------------------------------------------------------------------------------

export function SpectrumPlot(p: { r: RecordingDetail; win: DetailWindow; fft: number; window: WindowFn }) {
  const { r, win } = p
  const q = useQuery({
    queryKey: ['psd', r.id, win.start, win.count, p.fft, p.window],
    queryFn: ({ signal }) =>
      api.psd(r.id, { start: win.start, count: win.count, fft: p.fft, window: p.window }, signal),
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  })

  const range = useRef(win)
  range.current = win
  const data = usePsdData(q.data, r)
  const { hostRef, plotRef } = usePlot(
    () => ({
      scales: { x: { time: false } },
      cursor: { drag: { x: true, y: false } },
      legend: { live: true },
      series: [
        { label: 'Freq', value: (_u, v) => (v == null ? '—' : fmt.hz(v, 9)) },
        { label: 'Mean', stroke: C.mean, width: 1.5, value: dbValue, points: { show: false } },
        { label: 'Max hold', stroke: C.max, width: 1, value: dbValue, points: { show: false } },
      ],
      axes: [axis((v) => fmt.hz(v, 6), { space: 90 }), axis((v) => `${v}`, { size: 44, label: 'dBFS', labelSize: 14, labelFont: C.font })],
    }),
    data,
    (u) => u.setScale('x', { min: range.current.fLo, max: range.current.fHi }),
  )

  // Follow frequency zoom on the spectrogram without refetching.
  useEffect(() => {
    plotRef.current?.setScale('x', { min: win.fLo, max: win.fHi })
  }, [win.fLo, win.fHi, plotRef])

  const d = q.data
  return (
    <PlotCard
      icon="spectrum"
      title="Spectrum"
      testId="spectrum-plot"
      loading={q.isFetching}
      error={q.error}
      info={
        d && (
          <>
            {d.segments.toLocaleString()} × {d.fft} FFT
            {d.mode === 'strided' && <span className="badge" title="Window is over 2M samples: FFT segments are evenly spaced across it">sampled</span>}
          </>
        )
      }
    >
      <div className="uplot-host" ref={hostRef} />
    </PlotCard>
  )
}

const dbValue = (_u: uPlot, v: number | null) => (v == null ? '—' : `${v.toFixed(1)} dB`)

function usePsdData(d: PsdData | undefined, r: RecordingDetail): uPlot.AlignedData | null {
  const cache = useRef<{ d: PsdData; out: uPlot.AlignedData } | null>(null)
  if (!d) return null
  if (cache.current?.d === d) return cache.current.out
  const sr = r.sample_rate ?? 1
  const cf = r.center_freq ?? 0
  const n = d.fft
  const f = Float64Array.from({ length: n }, (_, k) => cf + ((k - n / 2) * sr) / n)
  const out: uPlot.AlignedData = [f as unknown as number[], d.mean as unknown as number[], d.max as unknown as number[]]
  cache.current = { d, out }
  return out
}

// ---- time ----------------------------------------------------------------------------------

export function TimePlot(p: {
  r: RecordingDetail
  win: DetailWindow
  /** Annotations to draw (already filtered by label / visibility). */
  annotations: Annotation[]
  selected: number | null
  onSelect: (a: Annotation) => void
}) {
  const { r, win } = p
  const sr = r.sample_rate ?? 1
  const ann = useRef({ list: p.annotations, selected: p.selected, sr, onSelect: p.onSelect })
  ann.current = { list: p.annotations, selected: p.selected, sr, onSelect: p.onSelect }
  const q = useQuery({
    queryKey: ['time', r.id, win.start, win.count],
    queryFn: ({ signal }) => api.time(r.id, { start: win.start, count: win.count, points: TIME_POINTS }, signal),
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  })
  const data = useTimeData(q.data, r)
  const { hostRef, plotRef } = usePlot(
    () => ({
      hooks: {
        // Bands under the traces, labels on top of them.
        drawClear: [(u) => drawAnnotationBands(u, ann.current.list, ann.current.selected, ann.current.sr)],
        draw: [(u) => drawAnnotationLabels(u, ann.current.list, ann.current.selected, ann.current.sr)],
        ready: [(u) => clickToSelect(u, (t) => {
          const a = annotationAt(ann.current.list, t * ann.current.sr)
          if (a) ann.current.onSelect(a)
        })],
      },
      scales: { x: { time: false } },
      cursor: { drag: { x: true, y: false } },
      legend: { live: true },
      series: [
        { label: 'Time', value: (_u, v) => (v == null ? '—' : fmt.seconds(v)) },
        { label: 'I', stroke: C.i, width: 1, value: ampValue, points: { show: false } },
        { label: 'Q', stroke: C.q, width: 1, value: ampValue, points: { show: false } },
      ],
      axes: [axis(fmt.seconds, { space: 80 }), axis((v) => `${+v.toFixed(3)}`, { size: 44, space: 24 })],
    }),
    data,
  )

  useEffect(() => {
    // Redrawing before the first data would draw axes uPlot hasn't laid out yet (it throws).
    const u = plotRef.current
    if (u && u.data[0]?.length) u.redraw(false)
  }, [p.annotations, p.selected, plotRef])

  const d = q.data
  return (
    <PlotCard
      icon="wave"
      title="Time"
      testId="time-plot"
      loading={q.isFetching}
      error={q.error}
      info={
        d && (
          <>
            {d.count.toLocaleString()} samples · {fmt.seconds(d.count / sr)}
            {d.mode !== 'raw' && (
              <span
                className="badge"
                title={
                  d.mode === 'minmax'
                    ? 'Min/max envelope: every sample is read, each bucket shows its extremes'
                    : 'Window is over 2M samples: the envelope is built from evenly spaced slices'
                }
              >
                {d.mode === 'minmax' ? 'envelope' : 'sampled envelope'}
              </span>
            )}
          </>
        )
      }
    >
      <div className="uplot-host" ref={hostRef} />
    </PlotCard>
  )
}

const ampValue = (_u: uPlot, v: number | null) => (v == null ? '—' : v.toFixed(4))

function useTimeData(d: TimeData | undefined, r: RecordingDetail): uPlot.AlignedData | null {
  const cache = useRef<{ d: TimeData; out: uPlot.AlignedData } | null>(null)
  if (!d) return null
  if (cache.current?.d === d) return cache.current.out
  const sr = r.sample_rate ?? 1
  let t: Float64Array, i: Float32Array, q: Float32Array
  if (d.mode === 'raw') {
    const n = d.data.length / 2
    t = Float64Array.from({ length: n }, (_, k) => (d.start + k) / sr)
    i = new Float32Array(n)
    q = new Float32Array(n)
    for (let k = 0; k < n; k++) {
      i[k] = d.data[2 * k]
      q[k] = d.data[2 * k + 1]
    }
  } else {
    // Each bucket becomes two points (min, then max) half a bucket apart: drawn as a line
    // this zig-zags between the extremes and reads as a filled envelope.
    const b = d.points
    t = new Float64Array(2 * b)
    i = new Float32Array(2 * b)
    q = new Float32Array(2 * b)
    for (let k = 0; k < b; k++) {
      const t0 = (d.start + (k * d.count) / b) / sr
      const half = d.count / b / 2 / sr
      t[2 * k] = t0
      t[2 * k + 1] = t0 + half
      i[2 * k] = d.data[4 * k]
      i[2 * k + 1] = d.data[4 * k + 1]
      q[2 * k] = d.data[4 * k + 2]
      q[2 * k + 1] = d.data[4 * k + 3]
    }
  }
  const out: uPlot.AlignedData = [t as unknown as number[], i as unknown as number[], q as unknown as number[]]
  cache.current = { d, out }
  return out
}

// ---- annotations on the time plot ----------------------------------------------------------

/** The shortest annotation covering `sample`, so nested ones stay clickable. */
function annotationAt(list: Annotation[], sample: number): Annotation | null {
  let best: Annotation | null = null
  for (const a of list) {
    if (sample >= a.start && sample <= a.start + a.count && (!best || a.count < best.count)) best = a
  }
  return best
}

/** Visible annotations as canvas x ranges, clipped to the plot area. */
function bands(u: uPlot, list: Annotation[], sr: number) {
  const { min, max } = u.scales.x
  if (min == null || max == null) return []
  const { left, width } = u.bbox
  return list.flatMap((a) => {
    const t0 = a.start / sr
    const t1 = (a.start + a.count) / sr
    if (t1 < min || t0 > max) return []
    const x0 = Math.max(left, u.valToPos(t0, 'x', true))
    const x1 = Math.min(left + width, u.valToPos(t1, 'x', true))
    return [{ a, x0, x1: Math.max(x1, x0 + 1) }]
  })
}

function drawAnnotationBands(u: uPlot, list: Annotation[], selected: number | null, sr: number) {
  const { ctx, bbox } = u
  const px = devicePixelRatio
  ctx.save()
  for (const { a, x0, x1 } of bands(u, list, sr)) {
    const sel = a.id === selected
    ctx.globalAlpha = sel ? 0.24 : 0.1
    ctx.fillStyle = a.color
    ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height)
    ctx.globalAlpha = sel ? 1 : 0.55
    ctx.strokeStyle = a.color
    ctx.lineWidth = (sel ? 1.5 : 1) * px
    ctx.beginPath()
    for (const x of [x0, x1]) {
      ctx.moveTo(x, bbox.top)
      ctx.lineTo(x, bbox.top + bbox.height)
    }
    ctx.stroke()
  }
  ctx.restore()
}

function drawAnnotationLabels(u: uPlot, list: Annotation[], selected: number | null, sr: number) {
  const { ctx, bbox } = u
  const px = devicePixelRatio
  const h = 15 * px
  const rowEnds = [-Infinity, -Infinity]
  ctx.save()
  ctx.font = `600 ${10 * px}px Inter, ui-sans-serif, system-ui, sans-serif`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left' // uPlot leaves whatever its axes used
  // Selected first, so it always gets a slot; others take the first free row or are skipped.
  const items = bands(u, list, sr).sort((p, q) => Number(q.a.id === selected) - Number(p.a.id === selected) || p.x0 - q.x0)
  for (const { a, x0 } of items) {
    const w = ctx.measureText(a.label).width + 10 * px
    const x = Math.min(x0, bbox.left + bbox.width - w)
    const row = rowEnds.findIndex((end) => x >= end + 3 * px)
    if (row < 0) continue
    rowEnds[row] = x + w
    const y = bbox.top + 3 * px + row * (h + 2 * px)
    ctx.globalAlpha = 0.92
    ctx.fillStyle = a.id === selected ? a.color : 'rgba(17, 19, 25, 0.9)'
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, 4 * px)
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.strokeStyle = a.color
    ctx.lineWidth = px
    ctx.stroke()
    ctx.fillStyle = a.id === selected ? '#0a0b0f' : '#e7e9ee'
    ctx.fillText(a.label, x + 5 * px, y + h / 2)
  }
  ctx.restore()
}

/** Call `onClick(time)` for clicks on the plot, but not at the end of a drag-zoom. */
function clickToSelect(u: uPlot, onClick: (t: number) => void) {
  let down: { x: number; y: number } | null = null
  u.over.addEventListener('mousedown', (e) => (down = { x: e.clientX, y: e.clientY }))
  u.over.addEventListener('click', (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3) return
    onClick(u.posToVal(e.offsetX, 'x'))
  })
}
