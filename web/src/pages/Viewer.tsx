import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { WINDOWS, api, type Overview, type RecordingDetail, type WindowFn } from '../api'
import { parseAnnotations, toPlot, type Annotation } from '../annotations'
import * as fmt from '../format'
import { geometry, type Geometry } from '../geometry'
import { COLORMAPS, colormapStops, type Colormap } from '../spectrogram/colormaps'
import { SpectrumPlot, TimePlot } from '../plots/DetailPlots'
import {
  FULL_VIEW,
  SpectrogramView,
  autoDbRange,
  type CursorInfo,
  type Mode,
  type PlotAnnotation,
  type View,
} from '../spectrogram/SpectrogramView'
import { Divider, Field, Icon, IconButton, Segmented } from '../ui'

const FFT_SIZES = [256, 512, 1024, 2048, 4096, 8192, 16384]
const ROWS = 1024
const MODE_KEY = 'trfiq.mode'
const PANELS_KEY = 'trfiq.panels'

interface Panels {
  spectrum: boolean
  time: boolean
}

function parseView(v?: string): View | null {
  const p = v?.split(',').map(Number)
  if (!p || p.length !== 4 || p.some((n) => !Number.isFinite(n))) return null
  return { x0: p[0], x1: p[1], y0: p[2], y1: p[3] }
}

function loadPanels(): Panels {
  try {
    const p = JSON.parse(localStorage.getItem(PANELS_KEY) ?? 'null')
    if (p && typeof p === 'object') return { spectrum: p.spectrum !== false, time: p.time !== false }
  } catch {
    /* unavailable or corrupt: defaults */
  }
  return { spectrum: true, time: true }
}

function loadMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'pan' ? 'pan' : 'zoom'
  } catch {
    return 'zoom'
  }
}

export function Viewer() {
  const { id: idParam } = useParams({ from: '/r/$id' })
  const id = Number(idParam)
  const search = useSearch({ from: '/r/$id' })
  const navigate = useNavigate({ from: '/r/$id' })
  const fft = search.fft ?? 1024
  const windowFn = search.window ?? 'hann'
  const cmap = search.cmap ?? 'turbo'

  const viewRef = useRef<SpectrogramView | null>(null)
  const [mode, setModeState] = useState<Mode>(loadMode)
  const [canBack, setCanBack] = useState(false)
  const [showAnn, setShowAnn] = useState(true)
  const [hiddenLabels, setHiddenLabels] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<number | null>(null)
  const [panels, setPanels] = useState<Panels>(loadPanels)
  const togglePanel = (k: keyof Panels) =>
    setPanels((p) => {
      const n = { ...p, [k]: !p[k] }
      try {
        localStorage.setItem(PANELS_KEY, JSON.stringify(n))
      } catch {
        /* private mode etc. */
      }
      return n
    })

  const setMode = (m: Mode) => {
    setModeState(m)
    try {
      localStorage.setItem(MODE_KEY, m)
    } catch {
      /* private mode etc. */
    }
  }

  const rec = useQuery({
    queryKey: ['recording', id],
    queryFn: ({ signal }) => api.recording(id, signal),
  })
  const viewable = !!rec.data?.datatype && rec.data.status !== 'broken'

  const overview = useQuery({
    queryKey: ['overview', id, fft, windowFn, ROWS],
    queryFn: ({ signal }) => api.overview(id, { fft, window: windowFn, rows: ROWS }, signal),
    enabled: viewable,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  })

  const auto = useMemo(
    () => (overview.data ? autoDbRange(overview.data.data, overview.data) : null),
    [overview.data],
  )
  const lo = search.lo ?? auto?.lo ?? -120
  const hi = search.hi ?? auto?.hi ?? 0
  const setSearch = (patch: Partial<typeof search>) =>
    navigate({ search: (s) => ({ ...s, ...patch }), replace: true })

  // Follows the FFT size of the overview on screen (the previous one while a new one loads).
  const shownFft = overview.data?.fft ?? fft
  const geo = useMemo(() => (rec.data ? geometry(rec.data, shownFft) : null), [rec.data, shownFft])
  const annotations = useMemo(() => parseAnnotations(rec.data?.meta), [rec.data])
  const plotAnnotations = useMemo(() => {
    if (!geo) return []
    return annotations.filter((a) => !hiddenLabels.has(a.label)).map((a) => toPlot(a, geo))
  }, [annotations, hiddenLabels, geo])

  const listedAnnotations = useMemo(
    () => (showAnn ? annotations.filter((a) => !hiddenLabels.has(a.label)) : NO_ANNOTATIONS),
    [annotations, hiddenLabels, showAnn],
  )

  const selectAnnotation = (a: Annotation | null, zoom: boolean) => {
    setSelected(a?.id ?? null)
    if (!a || !zoom || !geo) return
    viewRef.current?.zoomTo(toPlot(a, geo))
  }

  if (rec.error) return <div className="error page">Failed to load recording: {rec.error.message}</div>
  if (!rec.data || !geo) return <div className="page muted">Loading…</div>
  const r = rec.data
  const folder = r.stem.includes('/') ? r.stem.slice(0, r.stem.lastIndexOf('/')) : ''

  return (
    <main className="viewer">
      <header className="viewer-header">
        <Link to="/" search={{}} className="icon-btn" title="Back to recordings" aria-label="Back to recordings">
          <Icon name="arrowLeft" />
        </Link>
        <div className="title">
          <div className="crumbs">
            {r.source}
            {folder && <> / {folder}</>}
          </div>
          <h1 title={r.stem}>{r.name}</h1>
        </div>
        <div className="chips">
          <span className="chip mono">{r.datatype ?? '—'}</span>
          <span className="chip">{fmt.sps(r.sample_rate)}</span>
          <span className="chip">{fmt.hz(r.center_freq, 9)}</span>
          <span className="chip">{fmt.seconds(fmt.duration(r))}</span>
          <span className="chip">{fmt.bytes(r.size)}</span>
        </div>
      </header>

      <div className="toolbar">
        <Segmented
          ariaLabel="Mouse mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'zoom', label: <><Icon name="boxZoom" /> Zoom</>, title: 'Drag a box to zoom (Z)' },
            { value: 'pan', label: <><Icon name="pan" /> Pan</>, title: 'Drag to pan (H). Right-drag always pans.' },
          ]}
        />
        <IconButton icon="back" label="Previous view (Backspace)" disabled={!canBack} onClick={() => viewRef.current?.back()} />
        <IconButton icon="fit" label="Show everything (0 / double-click)" onClick={() => viewRef.current?.reset()} />
        <Divider />
        <Field label="FFT">
          <select value={fft} onChange={(e) => setSearch({ fft: Number(e.target.value) })}>
            {FFT_SIZES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </Field>
        <Field label="Window">
          <select value={windowFn} onChange={(e) => setSearch({ window: e.target.value as typeof windowFn })}>
            {WINDOWS.map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
        </Field>
        <Field label="Colormap">
          <select value={cmap} onChange={(e) => setSearch({ cmap: e.target.value as Colormap })}>
            {COLORMAPS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Divider />
        <Levels
          lo={lo}
          hi={hi}
          min={Math.floor(Math.min(lo, (auto?.lo ?? -120) - 40))}
          max={Math.ceil(Math.max(hi, (auto?.hi ?? 0) + 20))}
          cmap={cmap}
          onChange={(l, h) => setSearch({ lo: l, hi: h })}
        />
        <button
          type="button"
          className="btn ghost"
          onClick={() => setSearch({ lo: undefined, hi: undefined })}
          disabled={search.lo == null && search.hi == null}
        >
          Auto
        </button>
        <Divider />
        <IconButton icon="spectrum" label="Spectrum of the visible time range (S)" className="toggle"
          active={panels.spectrum} disabled={!viewable} onClick={() => togglePanel('spectrum')}>
          Spectrum
        </IconButton>
        <IconButton icon="wave" label="I/Q over the visible time range (T)" className="toggle"
          active={panels.time} disabled={!viewable} onClick={() => togglePanel('time')}>
          Time
        </IconButton>
      </div>

      <div className="workspace">
        <div className="main-col">
        <section className="plot-card">
          {!viewable ? (
            <div className="empty-state">
              <Icon name="file" size={28} />
              <p>
                {r.status === 'broken'
                  ? <>This recording is broken: <strong className="error-text">{r.error}</strong></>
                  : 'This raw file needs a datatype and sample rate before it can be shown.'}
              </p>
            </div>
          ) : overview.error ? (
            <div className="error">Overview failed: {overview.error.message}</div>
          ) : (
            <Spectrogram
              viewRef={viewRef}
              geo={geo}
              overview={overview.data}
              loading={overview.isFetching}
              cmap={cmap}
              lo={lo}
              hi={hi}
              mode={mode}
              annotations={plotAnnotations}
              showAnnotations={showAnn}
              selected={selected}
              initialView={parseView(search.v)}
              onMode={setMode}
              onToggleAnnotations={() => setShowAnn((s) => !s)}
              onTogglePanel={togglePanel}
              onCanBack={setCanBack}
              onAnnotationClick={(aid) => selectAnnotation(annotations.find((a) => a.id === aid) ?? null, false)}
              onViewChange={(v) =>
                setSearch({
                  v: v.x0 === 0 && v.x1 === 1 && v.y0 === 0 && v.y1 === 1
                    ? undefined
                    : [v.x0, v.x1, v.y0, v.y1].map((n) => +n.toFixed(5)).join(','),
                })
              }
            />
          )}
        </section>
        {viewable && (panels.spectrum || panels.time) && (
          <DetailRow
            r={r}
            geo={geo}
            v={search.v}
            fft={fft}
            windowFn={windowFn}
            panels={panels}
            annotations={listedAnnotations}
            selected={selected}
            onSelect={(a) => selectAnnotation(a, false)}
          />
        )}
        </div>

        <aside className="side">
          <Details r={r} />
          <AnnotationPanel
            geo={geo}
            annotations={annotations}
            show={showAnn}
            onToggleShow={() => setShowAnn((s) => !s)}
            hiddenLabels={hiddenLabels}
            onToggleLabel={(l) =>
              setHiddenLabels((s) => {
                const n = new Set(s)
                if (n.has(l)) n.delete(l)
                else n.add(l)
                return n
              })
            }
            selected={selected}
            onSelect={(a) => selectAnnotation(a, true)}
          />
        </aside>
      </div>
    </main>
  )
}

// ---- detail plots for the visible window ---------------------------------------------------

const NO_ANNOTATIONS: Annotation[] = []

function DetailRow(p: {
  r: RecordingDetail
  geo: Geometry
  v?: string
  fft: number
  windowFn: WindowFn
  panels: Panels
  annotations: Annotation[]
  selected: number | null
  onSelect: (a: Annotation) => void
}) {
  const { r, v, geo } = p
  // Driven by the (debounced) view in the URL, so panning doesn't flood the server.
  const win = useMemo(() => geo.window(parseView(v) ?? FULL_VIEW), [v, geo])
  return (
    <div className={`detail-row${p.panels.spectrum && p.panels.time ? ' two' : ''}`}>
      {p.panels.spectrum && <SpectrumPlot r={r} win={win} fft={p.fft} window={p.windowFn} />}
      {p.panels.time && (
        <TimePlot r={r} geo={geo} win={win} annotations={p.annotations} selected={p.selected} onSelect={p.onSelect} />
      )}
    </div>
  )
}

// ---- levels (dual-thumb dB range over a colorbar) ------------------------------------------

function Levels(props: {
  lo: number
  hi: number
  min: number
  max: number
  cmap: Colormap
  onChange: (lo: number, hi: number) => void
}) {
  const { lo, hi, min, max } = props
  const stops = colormapStops(props.cmap, 10)
  const pct = (v: number) => ((v - min) / (max - min)) * 100
  const a = pct(lo)
  const b = pct(hi)
  const grad = [
    `${stops[0]} 0%`,
    ...stops.map((c, i) => `${c} ${a + ((b - a) * i) / (stops.length - 1)}%`),
    `${stops[stops.length - 1]} 100%`,
  ].join(', ')
  return (
    <div className="levels-wrap" title="Display range: drag the handles (colours only, no refetch)">
      <span className="num muted">{lo}</span>
      <div className="levels">
        <div className="bar" style={{ background: `linear-gradient(to right, ${grad})` }} />
        <input type="range" aria-label="Floor (dB)" min={min} max={max} step={1} value={lo}
          onChange={(e) => props.onChange(Math.min(Number(e.target.value), hi - 1), hi)} />
        <input type="range" aria-label="Ceiling (dB)" min={min} max={max} step={1} value={hi}
          onChange={(e) => props.onChange(lo, Math.max(Number(e.target.value), lo + 1))} />
      </div>
      <span className="num muted">{hi} dB</span>
    </div>
  )
}

// ---- side panel ----------------------------------------------------------------------------

function Details({ r }: { r: RecordingDetail }) {
  const items: [string, string][] = [
    ['Samples', r.num_samples?.toLocaleString() ?? '—'],
    ['Duration', fmt.seconds(fmt.duration(r))],
    ['Sample rate', fmt.sps(r.sample_rate)],
    ['Center', fmt.hz(r.center_freq, 9)],
    ['Datatype', r.datatype ?? '—'],
    ['Size', fmt.bytes(r.size)],
  ]
  if (r.datetime) items.push(['Captured', r.datetime.replace('T', ' ').replace('Z', ' UTC')])
  if (r.hw) items.push(['Hardware', r.hw])
  if (r.author) items.push(['Author', r.author])
  return (
    <section className="card">
      <h3>Details</h3>
      {r.description && <p className="desc">{r.description}</p>}
      <dl className="kv">
        {items.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function AnnotationPanel(props: {
  geo: Geometry
  annotations: Annotation[]
  show: boolean
  onToggleShow: () => void
  hiddenLabels: Set<string>
  onToggleLabel: (l: string) => void
  selected: number | null
  onSelect: (a: Annotation) => void
}) {
  const { annotations, selected } = props
  const listRef = useRef<HTMLUListElement>(null)
  const labels = useMemo(() => {
    const m = new Map<string, { color: string; n: number }>()
    for (const a of annotations) m.set(a.label, { color: a.color, n: (m.get(a.label)?.n ?? 0) + 1 })
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [annotations])

  // Keep the selected item visible when it's picked on the plot.
  useEffect(() => {
    if (selected == null) return
    listRef.current?.querySelector(`[data-id="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const { geo } = props
  const visible = annotations.filter((a) => !props.hiddenLabels.has(a.label))
  const LIMIT = 500

  return (
    <section className="card ann-card">
      <header className="card-head">
        <h3>
          Annotations <span className="count">{annotations.length}</span>
        </h3>
        <IconButton
          icon={props.show ? 'eye' : 'eyeOff'}
          label={props.show ? 'Hide annotations on the plot (A)' : 'Show annotations on the plot (A)'}
          active={props.show}
          onClick={props.onToggleShow}
        />
      </header>
      {annotations.length === 0 ? (
        <p className="muted small">This recording has no annotations.</p>
      ) : (
        <>
          <div className="label-chips">
            {labels.map(([label, { color, n }]) => (
              <button
                key={label}
                type="button"
                className={`label-chip${props.hiddenLabels.has(label) ? ' off' : ''}`}
                style={{ '--c': color } as CSSProperties}
                onClick={() => props.onToggleLabel(label)}
                title={props.hiddenLabels.has(label) ? `Show ${label}` : `Hide ${label}`}
              >
                <span className="swatch" />
                {label} <span className="muted">{n}</span>
              </button>
            ))}
          </div>
          <ul className="ann-list" ref={listRef}>
            {visible.slice(0, LIMIT).map((a) => (
              <li key={a.id} data-id={a.id}>
                <button
                  type="button"
                  className={`ann-item${a.id === selected ? ' selected' : ''}`}
                  style={{ '--c': a.color } as CSSProperties}
                  onClick={() => props.onSelect(a)}
                  title="Zoom to this annotation"
                >
                  <span className="ann-label">{a.label}</span>
                  <span className="ann-meta">
                    {geo.formatTime(geo.timeOf(a.start))} · {geo.formatTime(geo.timeOf(a.count))}
                    {a.fLo != null && a.fHi != null && geo.calibrated && <> · {geo.formatFreq(a.fHi - a.fLo, 4)} wide</>}
                  </span>
                  {a.comment && <span className="ann-comment">{a.comment}</span>}
                </button>
              </li>
            ))}
            {visible.length > LIMIT && <li className="muted small">…and {visible.length - LIMIT} more</li>}
          </ul>
        </>
      )}
    </section>
  )
}

// ---- spectrogram ---------------------------------------------------------------------------

interface SpectrogramProps {
  viewRef: RefObject<SpectrogramView | null>
  geo: Geometry
  overview: Overview | undefined
  loading: boolean
  cmap: Colormap
  lo: number
  hi: number
  mode: Mode
  annotations: PlotAnnotation[]
  showAnnotations: boolean
  selected: number | null
  initialView: View | null
  onMode: (m: Mode) => void
  onToggleAnnotations: () => void
  onTogglePanel: (k: keyof Panels) => void
  onCanBack: (b: boolean) => void
  onAnnotationClick: (id: number | null) => void
  onViewChange: (v: View) => void
}

function Spectrogram(p: SpectrogramProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const readout = {
    freq: useRef<HTMLSpanElement>(null),
    time: useRef<HTMLSpanElement>(null),
    db: useRef<HTMLSpanElement>(null),
    ann: useRef<HTMLSpanElement>(null),
  }
  const [glError, setGlError] = useState<string | null>(null)
  // Latest callbacks, so the long-lived view never calls stale closures.
  const cb = useRef(p)
  cb.current = p

  // Create the GL view once; it lives outside React rendering.
  useEffect(() => {
    let view: SpectrogramView
    try {
      view = new SpectrogramView(hostRef.current!)
    } catch (e) {
      setGlError(String(e))
      return
    }
    p.viewRef.current = view
    if (cb.current.initialView) view.setView(cb.current.initialView)
    let t: ReturnType<typeof setTimeout>
    view.onViewChange = (v) => {
      clearTimeout(t)
      t = setTimeout(() => cb.current.onViewChange(v), 250)
    }
    view.onHistoryChange = (b) => cb.current.onCanBack(b)
    view.onAnnotationClick = (id) => cb.current.onAnnotationClick(id)
    // Cursor readout is written straight to the DOM: no React render per mouse move.
    view.onCursor = (c: CursorInfo | null) => {
      const set = (el: HTMLSpanElement | null, s: string) => el && (el.textContent = s)
      const g = cb.current.geo
      set(readout.freq.current, c ? g.formatFreq(c.freq, 9) : '')
      set(readout.time.current, c ? g.formatTime(c.time) : '')
      set(readout.db.current, c?.db != null ? `${c.db.toFixed(1)} dB` : '')
      set(readout.ann.current, c?.annotation ?? '')
      readout.ann.current?.classList.toggle('visible', !!c?.annotation)
    }
    return () => {
      clearTimeout(t)
      view.destroy()
      p.viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const v = p.viewRef.current
    if (!v || !p.overview) return
    try {
      v.setData(p.overview.data, p.overview.fft, p.overview.rows, p.overview)
      setGlError(null)
    } catch (e) {
      setGlError(String(e))
    }
  }, [p.overview, p.viewRef])

  const { geo, viewRef } = p
  useEffect(() => viewRef.current?.setGeometry(geo), [geo, viewRef])
  useEffect(() => viewRef.current?.setColormap(p.cmap), [p.cmap, viewRef])
  useEffect(() => viewRef.current?.setDbRange(p.lo, p.hi), [p.lo, p.hi, viewRef])
  useEffect(() => viewRef.current?.setMode(p.mode), [p.mode, viewRef])
  useEffect(() => viewRef.current?.setAnnotations(p.annotations), [p.annotations, viewRef])
  useEffect(() => viewRef.current?.setShowAnnotations(p.showAnnotations), [p.showAnnotations, viewRef])
  useEffect(() => viewRef.current?.setSelected(p.selected), [p.selected, viewRef])

  const timing = p.overview?.timing.match(/read;dur=([\d.]+).*compute;dur=([\d.]+)/)

  return (
    <>
      <div
        className="spectrogram"
        ref={hostRef}
        tabIndex={0}
        aria-label="Spectrogram"
        onKeyDown={(e) => {
          const k = e.key.toLowerCase()
          if (!e.ctrlKey && !e.metaKey && !e.altKey) {
            if (k === 'z') return p.onMode('zoom')
            if (k === 'h' || k === 'p') return p.onMode('pan')
            if (k === 'a') return p.onToggleAnnotations()
            if (k === 's') return p.onTogglePanel('spectrum')
            if (k === 't') return p.onTogglePanel('time')
          }
          if (viewRef.current?.handleKey(e.nativeEvent)) e.preventDefault()
        }}
      >
        {p.loading && <div className="loading-bar" />}
      </div>
      <div className="statusbar">
        <div className="readout">
          <span ref={readout.freq} />
          <span ref={readout.time} />
          <span ref={readout.db} />
          <span ref={readout.ann} className="readout-ann" />
        </div>
        <span className="muted small timing">
          {p.overview && (
            <>
              {p.overview.mode} overview · {p.overview.rows}×{p.overview.fft}
              {timing && <> · read {timing[1]} ms · compute {timing[2]} ms</>}
            </>
          )}
        </span>
        <span
          className="shortcuts"
          title={[
            'Drag: box zoom (Zoom mode) or pan (Pan mode)',
            'Right/middle-drag: pan',
            'Wheel: zoom time · Shift+wheel: zoom frequency · Ctrl+wheel: both',
            'Double-click / 0: show everything · Backspace: previous view',
            'Arrows: pan · + −: zoom time · [ ]: zoom frequency',
            'Z / H: zoom / pan mode · A: toggle annotations',
            'S / T: spectrum / time plots of the visible time range',
            'Click an annotation to select it',
          ].join('\n')}
        >
          <Icon name="keyboard" /> Shortcuts
        </span>
      </div>
      {glError && <div className="error">{glError}</div>}
    </>
  )
}
