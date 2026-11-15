# trfiq — design

A self-hosted, read-only **visualiser and indexer for IQ recordings** (SigMF and raw),
built as a faster, more stable alternative to IQEngine. S3/MinIO is the primary
storage; local folders are supported through the same code path.

The two things that matter most are **responsiveness** and **stability**. Every
decision below is checked against them.

## Problems being solved

IQEngine's main pain points, which drive this design:

| Pain | Cause | trfiq answer |
|---|---|---|
| Spectrogram slow to render / zoom | FFTs computed in browser JS, Plotly | FFT on the server in Rust; client only colours pre-computed dB tiles in a WebGL2 shader |
| Large files freeze the browser | Samples downloaded to the browser | Browser never downloads raw samples beyond a capped window; server reads byte ranges |
| Slow bucket listing | Listing + parsing metadata on every visit | Persistent SQLite index, incrementally refreshed by ETag |

## Scope

**MVP**

- Browse an index of recordings across several named sources (S3 endpoints/buckets, local folders)
- Search and filter: name, frequency range, date range, sample rate, datatype, hardware/author/description, annotation labels
- Spectrogram viewer with smooth zoom and pan across files of 1–100 GB
- Detail plots for a selected window: time-domain I/Q, PSD, constellation
- SigMF annotation overlay (read-only), Δt/Δf cursors, deep links, keyboard navigation
- Raw files (`.bin .cfile .iq .raw .cu8 .cs8 .cs16 .cf32` …) with user-supplied metadata

**Not in the MVP:** annotation editing, plugins, live SDR, auth, `.sigmf` archives,
WAV and vendor formats, exporting a selection, ARM images, GPU.

## Constraints

- **Read-only on data buckets.** The app needs only `s3:ListBucket` and `s3:GetObject`.
  Nothing the app does can modify a recording.
- Small team on a trusted network. No built-in auth; put a reverse proxy in front if needed.
- Air-gap friendly: one self-contained image, no runtime CDN calls.
- x86-64 only. CPU only.
- Desktop Chrome, Edge and Firefox with WebGL2. Safari/mobile not guaranteed.

## Architecture

```
 browser ──HTTP──▶ trfiq (single Rust binary, one container)
                     ├── web UI (embedded, rust-embed)
                     ├── api (axum)
                     ├── index   (SQLite WAL + FTS5, volume)  ◀── scanner (periodic, ETag-incremental)
                     ├── dsp     (rustfft, rayon pool)
                     ├── tile cache (local volume, LRU, size cap)
                     └── storage (object_store: S3 / MinIO / local)
                                   │ range reads only
                                   ▼
                        MinIO / S3 buckets, local mounts
```

### Crates

| Crate | Responsibility |
|---|---|
| `storage` | Source config, one `ObjectStore` per source, list / head / range reads with a concurrency cap |
| `index` | SQLite schema, scanner (list → diff by ETag → parse `.sigmf-meta` → upsert), queries |
| `dsp` | Sample decoding for every SigMF datatype, windows, FFT, dB, quantisation, overview/tile generation |
| `server` | HTTP API, background tasks, embedded frontend, health and metrics |

### Storage

- Sources are declared in `config.yaml`; secrets come from env vars (`${VAR}` substitution).
- Every source, S3 or local, is an `object_store::ObjectStore`, so the rest of the code
  has one path. Local folders are mounted into the container read-only.
- Reads are always byte ranges. `get_ranges` coalesces nearby ranges into fewer requests.
- A per-source semaphore caps concurrent S3 requests.

### Index

- SQLite in WAL mode on a volume. FTS5 for text search.
- A recording is keyed by `(source, data_key)`.
- Scan: list the source, group objects by stem, re-read a `.sigmf-meta` only when its ETag
  changed, delete rows whose objects vanished. Runs on an interval (default 5 min) and
  on demand (`POST /api/sources/{id}/rescan`).
- Status per recording: `ok`, `needs_meta` (raw file with no metadata yet), `broken`
  (a `.sigmf-data` without `.sigmf-meta` or the reverse, or unparseable metadata).
- User-supplied metadata for raw files lives in the index (never written to buckets) and
  can be exported/imported as JSON.
- The index is disposable apart from that user metadata: deleting it and rescanning
  rebuilds everything from S3.

### Spectrogram pipeline

- **Tile format:** power in dB, quantised to `u16` with a fixed global mapping
  (`dB = DB_MIN + q * DB_STEP`), zstd-compressed over HTTP. Because the mapping is fixed,
  colormap, dB floor/ceiling and contrast are applied in the client shader:
  **changing them never refetches**.
- **Recompute triggers:** only FFT size (256–65536), window (Hann, Blackman-Harris,
  rectangular) and overlap. Cache key = object ETag + those parameters + tile coordinates.
- **Overview (zoomed fully out):**
  1. *Strided:* read ~1–2k evenly spaced FFT-sized chunks and FFT each one. Instant, but
     can miss short bursts between chunks.
  2. *Max-hold pyramid:* one full pass in the background, built lazily on first open,
     swapped in progressively, cached. Accurate.
- **Cancellation:** tiles that leave the view are aborted in the browser (`AbortController`);
  the server drops the future, which stops the S3 read and sets a cancel flag the FFT loop
  checks per row.
- **Placeholders:** while a tile loads, its coarser parent is shown upscaled, so the view
  never goes blank.
- **Detail plots:** capped at ~2M raw samples per request; beyond that the server returns
  min/max-decimated time series, Welch PSD and a subsampled constellation, and the UI
  says so.

### Frontend

- React + Vite + TypeScript.
- TanStack Query (server state), TanStack Router (URL = state, so every view is a deep link),
  TanStack Table + Virtual (10k+ rows).
- Spectrogram: hand-written WebGL2, outside React's render cycle. Tiles are uploaded as
  `R16UI` textures; the fragment shader maps quantised dB → colour through a colormap LUT.
- Plots: uPlot.
- UI preferences in `localStorage`.

### Operations

- `/healthz` (process up), `/readyz` (index open, sources reachable), `/metrics` (Prometheus):
  tile latency, cache hit rate, S3 bytes read, scan duration.
- Structured JSON logs.
- Per-source status panel in the UI.

### Packaging

- One x86-64 image: frontend embedded in the Rust binary, `debian:bookworm-slim` runtime.
- `deploy/compose.yml` brings up an S3 server with seeded sample SigMF files for development
  and demos. (Upstream MinIO no longer publishes community images, so the dev stack uses
  RustFS, a MinIO-compatible S3 server. Production points at your own MinIO.)

## Performance budgets (acceptance criteria)

Assuming the S3 server is on a LAN of 1 Gbps or faster:

| Operation | Budget |
|---|---|
| Recording list (10k objects) | < 300 ms (served from the index) |
| First overview of a 100 GB file | < 2 s (strided) |
| Cached tile | < 50 ms |
| Uncached tile at FFT 1024 | < 300 ms |
| Pan / zoom | 60 fps |
| Full max-hold pyramid of 100 GB | S3-throughput-bound, progress shown |

These are checked by the Playwright suite and a 100 GB synthetic-file load test.

## Testing

1. **DSP golden tests:** Rust output compared against `numpy`/`scipy` reference data for
   every datatype (endianness and scaling bugs are the classic failure here).
2. **Integration tests:** storage and scanner against an S3 server in a container.
3. **End-to-end:** Playwright against the compose stack, plus the 100 GB load test.
4. GitHub Actions CI.

## Repository layout

```
crates/{server,dsp,index,storage}   Cargo workspace
web/                                Vite app
deploy/                             Dockerfile, compose.yml, sample config
scripts/                            sample-data generator, dev helpers
docs/                               this file, ADRs
```

## Decisions

See [`docs/adr/`](adr/).
