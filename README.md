# trfiq

A fast, self-hosted, **read-only visualiser and indexer for IQ recordings** (SigMF and raw),
built as an alternative to IQEngine. S3/MinIO first; local folders work through the same code
path. One container.

- **Index:** recordings across S3 buckets and local folders are indexed in SQLite and refreshed
  incrementally (only changed `.sigmf-meta` files are re-read). The list and search come from the
  index, so they're instant even with tens of thousands of objects.
- **Spectrogram:** FFTs run on the server in Rust, reading only the byte ranges they need. The
  browser receives quantised dB and colours it in a WebGL2 shader, so colormap and dB-range
  changes are instant and large files never reach the browser.
- **Safe:** trfiq never writes to your buckets; it only needs list/get permissions.

Design and decisions: [`docs/DESIGN.md`](docs/DESIGN.md), [`docs/adr/`](docs/adr/).

## Quick start (demo stack)

```sh
docker compose -f deploy/compose.yml up --build
# → http://localhost:8080   (S3 console: http://localhost:9001, trfiq / trfiq-dev-secret)
```

This starts an S3 server (RustFS, MinIO-compatible), generates demo recordings, uploads them to
bucket `recordings`, and runs trfiq with that bucket and the same files as a local folder.

> **podman-compose:** it can't start a service that depends on a one-shot service having
> *completed* (`seed`), so `trfiq` stays in "Created". Use Docker Compose, or run `podman start`
> on the trfiq container after `seed` has finished.

## Running against your MinIO

```sh
docker run -d --name trfiq -p 8080:8080 \
  -e S3_ENDPOINT=http://minio.lan:9000 -e S3_BUCKET=recordings \
  -e S3_ACCESS_KEY_ID=… -e S3_SECRET_ACCESS_KEY=… \
  -v trfiq-data:/var/lib/trfiq \
  trfiq
```

The built-in config ([`deploy/config.example.yaml`](deploy/config.example.yaml)) reads those
variables. For several buckets/endpoints or local folders, mount your own config at
`/etc/trfiq/config.yaml`. The volume holds only the index and caches, and can be deleted at any
time; it's rebuilt by rescanning.

Build the image: `docker build -f deploy/Dockerfile -t trfiq .`

### Recording statuses

| Status | Meaning |
|---|---|
| ok | SigMF pair with valid metadata; viewable |
| needs meta | Raw file (`.bin .cfile .iq .raw .dat .cu8 .cs8 .cs16 .cf32` …); datatype guessed from the extension where possible |
| broken | Half of a SigMF pair is missing, or the metadata doesn't parse |

## Development

Requires podman (or Docker) and [bun](https://bun.sh). No host Rust toolchain needed:
`scripts/cargo.sh` runs cargo in a pinned Rust container.

```sh
deploy/dev-s3.sh                       # S3 server on :9000 with demo data in bucket `recordings`
scripts/cargo.sh run --release -p trfiq-server -- --config deploy/config.dev.yaml   # API on :8080
cd web && bun install && bun run dev   # UI with hot reload on :5173 (proxies /api to :8080)
```

Checks:

```sh
scripts/cargo.sh fmt --all --check
scripts/cargo.sh clippy --workspace --all-targets -- -D warnings
scripts/cargo.sh test --workspace      # unit, numpy golden, index/scanner, HTTP API
cd web && bun run typecheck && bun run build
cd web && bunx playwright test         # e2e against a running server (TRFIQ_URL, default :8080)
```

DSP golden fixtures come from numpy/scipy: `python3 scripts/gen_golden.py`.

### Commits and releases

Commits follow [Conventional Commits](https://www.conventionalcommits.org) via
[commitizen](https://commitizen-tools.github.io/commitizen/) (config in `.cz.toml`):

```sh
uvx --from commitizen cz commit        # guided commit message
uvx --from commitizen cz bump          # bump version (Cargo.toml + web/package.json), update CHANGELOG.md, tag
```

## API

| Endpoint | |
|---|---|
| `GET /api/sources` | Sources with scan status and counts per status |
| `POST /api/sources/{id}/rescan` | Trigger an incremental rescan |
| `GET /api/recordings?q=&source=&status=&datatype=&fmin=&fmax=&from=&to=&limit=` | Search the index (`q` is prefix full-text; `fmin`/`fmax` match by band overlap) |
| `GET /api/recordings/{id}` | One recording plus its full SigMF metadata |
| `GET /api/recordings/{id}/overview?fft=&rows=&window=` | Strided overview: `rows × fft` little-endian `u16`, `dB = -200 + q × 0.005`, fftshifted |
| `GET /healthz`, `GET /readyz` | Liveness, and readiness (every source scanned at least once) |

## Status

Done (first vertical slice):
- Cargo workspace (`dsp`, `storage`, `index`, `server`) with tests, including numpy golden tests
  for 11 datatypes × 3 windows
- S3 and local sources, ETag-incremental scanner, SQLite + FTS5 index, search/filter API
- Strided overview endpoint with cancellation when the client disconnects
- React UI: virtualised recording list, source status and rescan, WebGL2 spectrogram with max-hold
  downsampling, axes, cursor readout, pan/zoom, keyboard navigation, deep links
- Box zoom with live Δf/Δt readout, zoom history (Back), zoom/pan modes, dual-handle levels on a colorbar
- SigMF annotation overlay: coloured boxes and labels, a side-panel list (click to zoom), per-label
  show/hide, hover readout. Demo: `demo/ism_433_annotated` (OOK, 2-FSK, LoRa, Morse CW, jammer)
- 44 MB distroless non-root image, compose demo stack, Playwright e2e

Next, in order:
1. Zoomed tiles: full-resolution tiles for the visible region when zoomed past the overview,
   with the parent shown upscaled while loading
2. Lazy background max-hold pyramid (ADR 0003) and the local disk tile cache (LRU, size cap)
3. Detail plots for a selection (time-domain I/Q, PSD, constellation) with uPlot, ~2M sample cap
4. Raw-file metadata entry in the UI (stored in the index) and JSON export/import
5. Frequency and date filters in the UI (the API already supports them)
6. Prometheus `/metrics`
7. Byte-plane shuffle before compression (raw u16 dB only compresses about 10% today)
8. 100 GB synthetic-file load test against the performance budgets
