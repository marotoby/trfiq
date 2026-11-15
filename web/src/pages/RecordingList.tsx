import { useEffect, useRef, useState, type CSSProperties } from 'react'
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
import type { ListSearch } from '../router'
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

  const recordings = useQuery({
    queryKey: ['recordings', search],
    queryFn: ({ signal }) => api.recordings(search, signal),
    placeholderData: keepPreviousData,
  })

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
      </div>
      {recordings.error ? (
        <div className="error">Failed to load recordings: {String(recordings.error.message)}</div>
      ) : (
        <RecordingTable data={recordings.data ?? EMPTY} />
      )}
    </main>
  )
}

function RecordingTable({ data }: { data: Recording[] }) {
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
      <div className="tbody" ref={scrollRef}>
        {rows.length === 0 && (
          <div className="empty-state">
            <Icon name="search" size={28} />
            <p>No recordings match.</p>
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
    </div>
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
