import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type RefObject } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { api, type Recording, type SourceInfo, type Status } from '../api'
import { labelColor } from '../annotations'
import * as fmt from '../format'
import { geometry } from '../geometry'
import type { ListSearch, ListView } from '../router'
import { THUMB_FFT, Thumbnail, hasPreview } from '../spectrogram/Thumbnail'
import { FolderView } from './FolderView'
import { Icon, IconButton, Segmented } from '../ui'

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric },
})
const col = createColumnHelper<typeof features, Recording>()

const STATUS_TEXT: Record<Status, string> = { ok: 'Ready', needs_meta: 'Needs metadata', broken: 'Broken' }

const columns = col.columns([
  col.accessor('stem', {
    header: 'Name',
    sortFn: 'alphanumeric',
    cell: (c) => {
      const stem = c.getValue()
      const i = stem.lastIndexOf('/')
      return (
        <span className="name-cell" title={stem}>
          <Icon name="file" />
          <span className="name-text">
            {i >= 0 && <span className="muted">{stem.slice(0, i + 1)}</span>}
            <span className="name-main">{stem.slice(i + 1)}</span>
          </span>
        </span>
      )
    },
  }),
  col.accessor('source', { header: 'Source', cell: (c) => <span className="pill">{c.getValue()}</span> }),
  col.accessor('status', {
    header: 'Status',
    cell: (c) => (
      <span className={`status status-${c.getValue()}`} title={c.row.original.error ?? undefined}>
        <span className="dot" />
        {STATUS_TEXT[c.getValue()]}
      </span>
    ),
  }),
  col.accessor('datatype', { header: 'Type', cell: (c) => <span className="mono">{c.getValue() ?? '—'}</span> }),
  col.accessor('sample_rate', { header: 'Rate', cell: (c) => fmt.sps(c.getValue()), sortUndefined: 'last' }),
  col.accessor('center_freq', { header: 'Center', cell: (c) => fmt.hz(c.getValue()), sortUndefined: 'last' }),
  col.accessor((r) => fmt.duration(r) ?? undefined, {
    id: 'duration',
    header: 'Duration',
    cell: (c) => fmt.seconds(c.getValue()),
    sortUndefined: 'last',
  }),
  col.accessor('size', { header: 'Size', cell: (c) => fmt.bytes(c.getValue()), sortUndefined: 'last' }),
  col.accessor((r) => r.labels.join(', '), {
    id: 'labels',
    header: 'Annotations',
    cell: (c) => {
      const labels = c.row.original.labels
      if (!labels.length) return <span className="muted">—</span>
      return (
        <span className="tags">
          {labels.slice(0, 3).map((l) => (
            <span key={l} className="tag" style={{ '--c': labelColor(l) } as CSSProperties}>{l}</span>
          ))}
          {labels.length > 3 && <span className="muted">+{labels.length - 3}</span>}
        </span>
      )
    },
  }),
])

const VIEW_KEY = 'trfiq.listView'

function loadView(): ListView {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    return v === 'gallery' || v === 'folders' ? v : 'table'
  } catch {
    return 'table'
  }
}

function splitStem(stem: string) {
  const i = stem.lastIndexOf('/')
  return { folder: stem.slice(0, i + 1), name: stem.slice(i + 1) }
}

const GRID = 'minmax(240px, 3fr) 90px 150px 84px 96px 116px 84px 80px minmax(160px, 2fr)'
const EMPTY: Recording[] = []

export function RecordingList() {
  const search = useSearch({ from: '/' })
  const navigate = useNavigate({ from: '/' })
  const [text, setText] = useState(search.q ?? '')

  // Debounce typing into the URL; the URL drives the query.
  useEffect(() => {
    const t = setTimeout(() => {
      if ((search.q ?? '') !== text) navigate({ search: (s) => ({ ...s, q: text || undefined }), replace: true })
    }, 200)
    return () => clearTimeout(t)
  }, [text, search.q, navigate])

  // The view mode is UI only: keep it out of the API query (and its cache key).
  const params = { q: search.q, source: search.source, status: search.status }
  const recordings = useQuery({
    queryKey: ['recordings', params],
    queryFn: ({ signal }) => api.recordings(params, signal),
    placeholderData: keepPreviousData,
  })
  const view = search.view ?? loadView()
  const setView = (v: ListView) => {
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* private mode etc. */
    }
    navigate({ search: (s) => ({ ...s, view: v }), replace: true })
  }

  return (
    <main className="list-page">
      <div className="page-head">
        <div>
          <h1>Recordings</h1>
          <p className="muted">
            {recordings.data ? `${recordings.data.length.toLocaleString()} shown` : 'Loading…'}
            {recordings.isFetching ? ' · updating…' : ''}
          </p>
        </div>
      </div>
      <Sources />
      <div className="filters">
        <div className="search-box">
          <Icon name="search" />
          <input
            className="search"
            placeholder="Search names, descriptions, hardware, annotation labels…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
          {text && (
            <button type="button" className="clear" onClick={() => setText('')} aria-label="Clear search">
              ×
            </button>
          )}
        </div>
        <Segmented
          ariaLabel="Status filter"
          value={search.status ?? 'all'}
          onChange={(v) =>
            navigate({ search: (s) => ({ ...s, status: v === 'all' ? undefined : (v as ListSearch['status']) }) })
          }
          options={[
            { value: 'all', label: 'All' },
            { value: 'ok', label: 'Ready' },
            { value: 'needs_meta', label: 'Needs metadata' },
            { value: 'broken', label: 'Broken' },
          ]}
        />
        <div className="view-switch">
          <Segmented
            ariaLabel="View"
            value={view}
            onChange={setView}
            options={[
              { value: 'table', label: <><Icon name="list" /> Table</>, title: 'Table: hover a recording to preview its waterfall' },
              { value: 'gallery', label: <><Icon name="grid" /> Gallery</>, title: 'Gallery: waterfall thumbnails' },
              { value: 'folders', label: <><Icon name="folder" /> Folders</>, title: 'Folders: browse by source and directory' },
            ]}
          />
        </div>
      </div>
      {recordings.error ? (
        <div className="error">Failed to load recordings: {String(recordings.error.message)}</div>
      ) : view === 'gallery' ? (
        <Gallery data={recordings.data ?? EMPTY} />
      ) : view === 'folders' ? (
        <FolderView
          data={recordings.data ?? EMPTY}
          dir={search.dir}
          onDir={(dir) => navigate({ search: (s) => ({ ...s, dir }) })}
          renderFiles={(files, emptyText) => <RecordingTable data={files} emptyText={emptyText} />}
        />
      ) : (
        <RecordingTable data={recordings.data ?? EMPTY} />
      )}
    </main>
  )
}

function RecordingTable({ data, emptyText = 'No recordings match.' }: { data: Recording[]; emptyText?: string }) {
  const table = useTable({ features, columns, data })
  const rows = table.getRowModel().rows
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 40,
    getItemKey: (i) => rows[i].id,
    overscan: 20,
  })

  // Hover preview: shown after a short pause on a row, follows the pointer.
  const [preview, setPreview] = useState<Recording | null>(null)
  const pointer = useRef({ x: 0, y: 0 })
  const popRef = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const place = () => {
    const el = popRef.current
    if (!el) return
    const { x, y } = pointer.current
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = x + 18 + w > innerWidth - 8 ? x - 18 - w : x + 18
    const top = Math.max(8, Math.min(y + 16, innerHeight - h - 8))
    el.style.transform = `translate(${left}px, ${top}px)`
  }
  useLayoutEffect(place, [preview])
  useEffect(() => () => clearTimeout(timer.current), [])
  const hover = (r: Recording | null, e?: MouseEvent) => {
    clearTimeout(timer.current)
    if (e) pointer.current = { x: e.clientX, y: e.clientY }
    if (!r || !hasPreview(r)) return setPreview(null)
    timer.current = setTimeout(() => setPreview(r), 300)
  }

  return (
    <div className="table card">
      <div className="thead" style={{ gridTemplateColumns: GRID }}>
        {table.getHeaderGroups()[0].headers.map((h) => {
          const sorted = h.column.getIsSorted()
          return (
            <button key={h.id} type="button" className={`th${sorted ? ' sorted' : ''}`} onClick={h.column.getToggleSortingHandler()}>
              <table.FlexRender header={h} />
              <span className="sort">{sorted === 'asc' ? '↑' : sorted === 'desc' ? '↓' : ''}</span>
            </button>
          )
        })}
      </div>
      <div className="tbody" ref={scrollRef} onScroll={() => hover(null)}>
        {rows.length === 0 && (
          <div className="empty-state">
            <Icon name="search" size={28} />
            <p>{emptyText}</p>
          </div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]
            return (
              <Link
                key={row.id}
                to="/r/$id"
                params={{ id: String(row.original.id) }}
                search={{}}
                className={`tr row-${row.original.status}`}
                style={{ gridTemplateColumns: GRID, transform: `translateY(${item.start}px)` }}
                onMouseEnter={(e) => hover(row.original, e)}
                onMouseMove={(e) => {
                  pointer.current = { x: e.clientX, y: e.clientY }
                  place()
                }}
                onMouseLeave={() => hover(null)}
              >
                {row.getAllCells().map((cell) => (
                  <span key={cell.id} className="td">
                    <table.FlexRender cell={cell} />
                  </span>
                ))}
              </Link>
            )
          })}
        </div>
      </div>
      {preview && <PreviewPopover r={preview} popRef={popRef} />}
    </div>
  )
}

function PreviewPopover({ r, popRef }: { r: Recording; popRef: RefObject<HTMLDivElement | null> }) {
  const g = geometry(r, THUMB_FFT)
  const end = g.formatTime(g.duration)
  return (
    <div className="preview-pop" ref={popRef} role="tooltip">
      <div className="preview-head">
        <strong>{splitStem(r.stem).name}</strong>
        <span className="muted">{end}</span>
      </div>
      <div className="preview-plot">
        <Thumbnail r={r} />
        <span className="preview-t0">{g.formatTime(0)}</span>
        <span className="preview-t1">{end}</span>
      </div>
      <div className="preview-axis">
        {[0, 0.5, 1].map((x) => (
          <span key={x}>{g.formatFreq(g.freqAt(x))}</span>
        ))}
      </div>
    </div>
  )
}

// ---- gallery -------------------------------------------------------------------------------

const CARD_MIN = 250
const CARD_H = 232
const GAP = 14

function Gallery({ data }: { data: Recording[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = scrollRef.current!
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  const cols = Math.max(1, Math.floor((width + GAP) / (CARD_MIN + GAP)))
  const virtualizer = useVirtualizer({
    count: Math.ceil(data.length / cols),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CARD_H + GAP,
    overscan: 3,
  })

  return (
    <div className="gallery" ref={scrollRef}>
      {data.length === 0 && (
        <div className="empty-state">
          <Icon name="search" size={28} />
          <p>No recordings match.</p>
        </div>
      )}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            className="gallery-row"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: GAP, height: CARD_H, transform: `translateY(${row.start}px)` }}
          >
            {data.slice(row.index * cols, row.index * cols + cols).map((r) => (
              <GalleryCard key={r.id} r={r} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function GalleryCard({ r }: { r: Recording }) {
  const { folder, name } = splitStem(r.stem)
  const meta = [fmt.hz(r.center_freq), fmt.sps(r.sample_rate), fmt.seconds(fmt.duration(r)), fmt.bytes(r.size)]
  return (
    <Link to="/r/$id" params={{ id: String(r.id) }} search={{}} className={`gcard row-${r.status}`} title={r.stem}>
      <div className="gcard-thumb">
        {hasPreview(r) ? (
          <Thumbnail r={r} />
        ) : (
          <div className="thumb-empty">
            <Icon name="file" size={22} />
            <span className={`status status-${r.status}`}>
              <span className="dot" />
              {STATUS_TEXT[r.status]}
            </span>
            {r.error && <small>{r.error}</small>}
          </div>
        )}
        <span className="pill gcard-source">{r.source}</span>
        {r.annotation_count > 0 && (
          <span className="gcard-count" title={`${r.annotation_count} annotations`}>
            <Icon name="tag" size={12} /> {r.annotation_count}
          </span>
        )}
      </div>
      <div className="gcard-body">
        <div className="gcard-name">
          {folder && <span className="muted">{folder}</span>}
          <span className="name-main">{name}</span>
        </div>
        <div className="gcard-meta">
          {r.status === 'ok' ? (
            meta.filter((m) => m !== '—').join(' · ')
          ) : (
            <span className={`status status-${r.status}`}>
              <span className="dot" />
              {STATUS_TEXT[r.status]}
              {r.datatype && <span className="mono muted"> · {r.datatype}</span>}
            </span>
          )}
        </div>
        <span className="tags">
          {r.labels.slice(0, 4).map((l) => (
            <span key={l} className="tag" style={{ '--c': labelColor(l) } as CSSProperties}>{l}</span>
          ))}
          {r.labels.length > 4 && <span className="muted">+{r.labels.length - 4}</span>}
        </span>
      </div>
    </Link>
  )
}

function Sources() {
  const qc = useQueryClient()
  const sources = useQuery({
    queryKey: ['sources'],
    queryFn: ({ signal }) => api.sources(signal),
    refetchInterval: (q) => (q.state.data?.some((s) => s.scan.scanning) ? 1000 : 10_000),
  })
  const prevScanning = useRef(false)
  const scanning = sources.data?.some((s) => s.scan.scanning) ?? false
  // When a scan finishes, refresh the list.
  useEffect(() => {
    if (prevScanning.current && !scanning) qc.invalidateQueries({ queryKey: ['recordings'] })
    prevScanning.current = scanning
  }, [scanning, qc])

  const rescan = useMutation({
    mutationFn: api.rescan,
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ['sources'] }), 300),
  })

  if (sources.error) return <div className="error">Sources unavailable: {sources.error.message}</div>
  return (
    <div className="sources">
      {(sources.data ?? []).map((s) => (
        <SourceCard key={s.id} s={s} onRescan={() => rescan.mutate(s.id)} />
      ))}
    </div>
  )
}

function SourceCard({ s, onRescan }: { s: SourceInfo; onRescan: () => void }) {
  const total = Object.values(s.counts).reduce((a, b) => a + (b ?? 0), 0)
  const state = s.scan.last_error ? 'error' : s.scan.scanning ? 'scanning' : s.scan.ready ? 'ok' : 'pending'
  return (
    <div className={`source card state-${state}`} title={s.scan.last_error ?? undefined}>
      <div className="source-icon">
        <Icon name={s.kind === 's3' ? 'database' : 'folder'} size={18} />
      </div>
      <div className="source-body">
        <div className="source-title">
          <strong>{s.name}</strong>
          <span className="pill">{s.kind === 's3' ? 'S3' : 'Local'}</span>
        </div>
        <div className="source-stats">
          <span><b>{total.toLocaleString()}</b> recordings</span>
          {!!s.counts.needs_meta && <span className="warn-text">{s.counts.needs_meta} need metadata</span>}
          {!!s.counts.broken && <span className="error-text">{s.counts.broken} broken</span>}
        </div>
        <div className="source-scan">
          <span className="dot" />
          {s.scan.scanning ? 'Scanning…' : s.scan.last_error ? 'Scan failed' : `Scanned ${fmt.ago(s.scan.last_scan_unix)}`}
          {s.scan.last_stats && !s.scan.scanning && <span className="muted"> · {s.scan.last_stats.duration_ms} ms</span>}
        </div>
      </div>
      <IconButton icon="refresh" label={`Rescan ${s.name}`} onClick={onRescan} disabled={s.scan.scanning} spin={s.scan.scanning} />
    </div>
  )
}
