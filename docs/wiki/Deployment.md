# Deployment

T-RF/IQ is one container: a static Rust binary with the web UI embedded, on a distroless,
non-root base image (about 44 MB).

## Build the image

```sh
docker build -f deploy/Dockerfile -t trfiq:0.2.1 .
```

The build has three stages: bun builds the UI, Rust compiles the server with the UI embedded,
and the result is copied onto `gcr.io/distroless/cc-debian12:nonroot`.

To serve it under a sub-path behind a reverse proxy (for example `https://lab.example/trfiq/`),
build the UI for that path:

```sh
docker build -f deploy/Dockerfile --build-arg TRFIQ_BASE_PATH=/trfiq/ -t trfiq:0.2.1 .
```

The proxy must strip the prefix before forwarding, since the server itself always serves from
`/` (`/trfiq/api/…` → `/api/…`). The published image is built for `/`.

## Run

```sh
docker run -d --name trfiq --restart unless-stopped -p 8080:8080 \
  -e S3_ACCESS_KEY_ID=… -e S3_SECRET_ACCESS_KEY=… \
  -v "$PWD/config.yaml:/etc/trfiq/config.yaml:ro" \
  -v trfiq-data:/var/lib/trfiq \
  -v /data/iq:/mnt/recordings:ro \
  trfiq:0.2.1
```

| Mount | |
|---|---|
| `/etc/trfiq/config.yaml` | Your [configuration](Configuration.md) (the image has a default single-bucket config) |
| `/var/lib/trfiq` | The index. Keep it on a volume so restarts don't trigger a full reindex. Losing it is harmless: it's rebuilt by scanning |
| Local folders | Only if you use `kind: local` sources; mount them `:ro` |

On SELinux hosts add `z` to bind mounts (`:ro,z`).

The container runs as uid/gid `65532`. A named volume is set up with the right owner
automatically; a bind-mounted data dir must be writable by that uid.

## Health and readiness

| Check | Meaning |
|---|---|
| `GET /healthz` → `200 ok` | The process is up |
| `GET /readyz` → `200` / `503` | Every source has finished at least one scan. The JSON body has each source's scan status and last error |
| `trfiq healthcheck [addr]` | Exits 0 if `/healthz` answers; the image's `HEALTHCHECK` uses it (there's no curl in a distroless image). Default address `127.0.0.1:8080` |

Docker honours the image's `HEALTHCHECK`. Podman ignores it for OCI-format images; use
`--health-cmd '/trfiq healthcheck'` there if you want one.

Kubernetes example:

```yaml
livenessProbe:  { httpGet: { path: /healthz, port: 8080 } }
readinessProbe: { httpGet: { path: /readyz,  port: 8080 }, periodSeconds: 5 }
```

## Logs

JSON lines on stdout by default (`TRFIQ_LOG_FORMAT=pretty` for humans). Control verbosity with
`RUST_LOG`, e.g. `RUST_LOG=info,trfiq_server=debug` logs per-request timings for overviews and
detail plots. Scan results and S3 errors are logged at `info` / `warn`.

## Sizing

- **Memory:** small. The index is SQLite on disk; requests hold at most one overview
  (≤ 16M cells) or one detail window (~2M samples) in memory at a time.
- **CPU:** FFTs run on all cores (rayon). A 1024×1024 overview is a few ms of CPU.
- **Disk:** the index is a few KB per recording.
- **Network to S3:** opening a recording reads about `rows × fft × sample size` bytes, e.g.
  1024 × 1024 × 4 B ≈ 4 MB for `ci16`, however large the file is.

## Security notes

- There is **no authentication** (it was designed for a small trusted team). Put it behind
  your VPN or a reverse proxy that does auth if it must be reachable more widely.
- Give it **read-only** S3 credentials. The code has no write path to data sources, by design
  (ADR 0005).
- Secrets belong in environment variables referenced as `${VAR}` in the config, not in the
  file itself.

## Upgrading

Pull or build the new image and recreate the container with the same volume. The index
schema is created on start; if an upgrade ever needs a fresh index, deleting the volume is
always safe (it costs one full scan).
