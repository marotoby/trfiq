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
cd web && bun run typecheck && bun run build
cd web && bunx playwright test         # needs a running server; TRFIQ_URL, default http://127.0.0.1:8080
```

| Tests | Cover |
|---|---|
| `crates/dsp` unit tests | Datatype decoding, spectra, PSD, envelopes, cancellation |
| `crates/dsp/tests/golden.rs` | Spectra against numpy/scipy references (`scripts/gen_golden.py`) |
| `crates/index` | SigMF parsing, scanner grouping and statuses, queries |
| `crates/server/tests/api.rs` | The HTTP API end to end over a local source |
| `web/e2e/app.spec.ts` | Playwright: list, search, hover preview, gallery, viewer, box zoom, annotations, detail plots. Fails on any console error |

## Layout

| Path | |
|---|---|
| `crates/dsp` | Decoding, windows, FFT → dB, quantisation, PSD, envelopes |
| `crates/storage` | Read-only S3 and local sources |
| `crates/index` | SQLite + FTS5 index and the scanner |
| `crates/server` | HTTP API, scans, embedded UI, `trfiq` binary |
| `web/src/pages` | Recording list (table, gallery) and viewer |
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

## Regenerating assets

```sh
python3 scripts/gen_samples.py <dir>   # demo recordings (skips files that exist)
python3 scripts/gen_golden.py          # DSP golden fixtures (needs numpy, scipy)
python3 scripts/gen_logo.py            # logo.svg, mark.svg, favicon.svg
```

See also: [Releasing](Releasing.md).
