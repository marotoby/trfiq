# Development

## Toolchain

| Need | Notes |
|---|---|
| Podman or Docker | `scripts/cargo.sh` runs cargo in a pinned Rust 1.100 container (with clippy and rustfmt), so no host Rust is needed. The first run builds the image from `scripts/rust-dev.Containerfile` |
| [bun](https://bun.sh) 1.4 | Frontend package manager, scripts and test runner |
| Python 3 | Demo data and golden-test fixtures |

## Run locally

```sh
deploy/dev-s3.sh                       # S3 on :9000 with demo data in bucket `recordings`
scripts/cargo.sh run --release -p trfiq-server -- --config deploy/config.dev.yaml   # API on :8080
cd web && bun install && bun run dev   # UI with hot reload on :5173 (proxies /api to :8080)
```

## Checks (CI runs all of them)

```sh
scripts/cargo.sh fmt --all --check
scripts/cargo.sh clippy --workspace --all-targets -- -D warnings
scripts/cargo.sh test --workspace
cd web && bun run typecheck && bun run test && bun run build
cd web && bunx playwright test         # needs a running server; TRFIQ_URL, default http://127.0.0.1:8080
```

| Tests | Cover |
|---|---|
| `crates/dsp` unit tests | Datatype decoding, spectra, PSD, envelopes, cancellation |
| `crates/dsp/tests/golden.rs` | Spectra against numpy/scipy references (`scripts/gen_golden.py`) |
| `crates/index` | SigMF parsing, scanner grouping and statuses, queries |
| `crates/server/src/samples.rs` | The sample-window reader: window checks, read plans and the detail cap, range reads against a local source, cancellation |
| `crates/server/tests/api.rs` | Smoke tests of the HTTP API end to end over a local source |
| `crates/server/src/wire.rs` | Writes `web/src/wire-fixtures/` from the response encoders and fails if they're stale (`TRFIQ_UPDATE_FIXTURES=1 scripts/cargo.sh test -p trfiq-server wire` rewrites them) |
| `web/src/*.test.ts` (`bun run test`) | Recording geometry (texture space ↔ samples and frequencies, bin centres, units, annotation placement) and the wire decoders, against the server's fixtures |
| `web/e2e/app.spec.ts` | Playwright: list, search, hover preview, gallery, viewer, box zoom, annotations, detail plots. Fails on any console error |

## Layout

| Path | |
|---|---|
| `crates/dsp` | Decoding, windows, FFT → dB, quantisation, PSD, envelopes |
| `crates/storage` | Read-only S3 and local sources |
| `crates/index` | SQLite + FTS5 index and the scanner |
| `crates/server` | HTTP API, the sample-window reader (`samples.rs`), scans, embedded UI, `trfiq` binary |
| `web/src/geometry.ts` | Recording geometry: every texture-space ↔ sample / frequency conversion and its units |
| `web/src/wire.ts` | Decodes every binary response into plot-ready values; the counterpart of `crates/server/src/wire.rs` |
| `web/src/pages` | Recording list (table, gallery, folders) and viewer |
| `web/src/spectrogram` | WebGL2 spectrogram, colormaps, thumbnails |
| `web/src/plots` | uPlot Spectrum and Time panels |
| `deploy/` | Dockerfile, compose demo stack, configs |
| `scripts/` | Demo data, golden fixtures, logo generator, containerised cargo |
| `docs/` | Design doc, ADRs, images, this wiki |

## Conventions

- Commits follow [Conventional Commits](https://www.conventionalcommits.org) and are checked by
  commitizen: `feat(web): …`, `fix(api): …`, `docs: …`. Scopes in use: `dsp`, `storage`,
  `index`, `server`/`api`, `web`, `samples`.
- `CHANGELOG.md` is generated from commits; don't edit it by hand.
- The frontend uses TanStack Table **v9** (`useTable`, `tableFeatures`); its docs are in
  `web/node_modules/@tanstack/react-table/skills/`.
- Anything that defines a view goes in the URL; personal preferences go in `localStorage`
  (`trfiq.mode`, `trfiq.panels`, `trfiq.listView`).
- Record decisions that are expensive to change as an ADR in `docs/adr/`.
- Domain terms (sample window, slot, read plan, recording geometry…) are defined in
  [`GLOSSARY.md`](../../GLOSSARY.md). Use them, and add new ones there.

## Regenerating assets

```sh
python3 scripts/gen_samples.py <dir>   # demo recordings (skips files that exist)
python3 scripts/gen_golden.py          # DSP golden fixtures (needs numpy, scipy)
python3 scripts/gen_logo.py            # logo.svg, mark.svg, favicon.svg
```

See also: [Releasing](Releasing.md).
