# HTTP API

The UI uses this API, and so can your scripts. It's read-only, unauthenticated and served on
the same port as the UI.

- Errors are JSON, `{"error": "message"}`, with status `400` (bad parameters), `404` (no such
  recording or source), `422` (the recording can't be read: broken, no datatype or empty) or `500`.
- Binary responses are little-endian. They describe their layout in `x-trfiq-*` headers and
  report a `Server-Timing` breakdown.

## Sources

### `GET /api/sources`

```json
[{
  "id": "lab", "name": "Lab MinIO", "kind": "s3",
  "counts": { "ok": 5210, "needs_meta": 12, "broken": 3 },
  "scan": {
    "scanning": false, "ready": true, "last_scan_unix": 1794771362, "last_error": null,
    "last_stats": { "objects": 10450, "recordings": 5225, "updated": 4, "removed": 0, "duration_ms": 182 }
  }
}]
```

### `POST /api/sources/{id}/rescan`

Starts an incremental scan now. Returns `202 Accepted`, or `404` for an unknown source.

## Recordings

### `GET /api/recordings`

| Parameter | |
|---|---|
| `q` | Full-text search (words and prefixes) over path, description, author, hardware and annotation labels |
| `source` | Source id |
| `status` | `ok`, `needs_meta` or `broken` |
| `datatype` | e.g. `ci16_le` |
| `fmin`, `fmax` | Hz; matches recordings whose band overlaps `[fmin, fmax]` |
| `from`, `to` | ISO-8601 bounds on the capture datetime |
| `limit` | Default 100,000 |

Results are ordered by source, then path.

```sh
curl 'http://localhost:8080/api/recordings?q=lora&status=ok&fmin=433e6&fmax=435e6'
```

Each item has `id, source, stem, name, data_key, meta_key, size, last_modified, status, error,
datatype, sample_rate, center_freq, datetime, description, author, hw, labels,
annotation_count, num_samples`.

### `GET /api/recordings/{id}`

The same fields plus `meta`, the full SigMF metadata document.

## Sample data

All three endpoints read only the byte ranges they need. They stop computing if the client
disconnects.

### `GET /api/recordings/{id}/overview`

A strided spectrogram of the whole recording: `rows` FFTs evenly spaced from start to end.

| Parameter | Default | |
|---|---|---|
| `fft` | 1024 | Power of two, 16 to 65536 |
| `rows` | 1024 | Up to 4096; `rows × fft` ≤ 16M |
| `window` | `hann` | `hann`, `blackman-harris` or `rect` |

Body: `rows × fft` `u16`, row-major, fftshifted (DC in the middle), in quantised dB:
**dB = −200 + q × 0.005**. A value of 0 means −200 dB or below.

| Header | |
|---|---|
| `x-trfiq-fft`, `x-trfiq-rows` | Layout (rows can be fewer than asked for short files) |
| `x-trfiq-db-min`, `x-trfiq-db-step` | Quantisation (−200, 0.005) |
| `x-trfiq-last-offset` | Sample offset of the last row (rows are evenly spaced from 0 to it) |
| `x-trfiq-mode` | `strided` |

Decode it in Python:

```python
import numpy as np, requests
r = requests.get(f"{base}/api/recordings/{rid}/overview", params={"fft": 1024, "rows": 512})
db = -200 + np.frombuffer(r.content, "<u2").reshape(int(r.headers["x-trfiq-rows"]), -1) * 0.005
```

### `GET /api/recordings/{id}/psd`

Power spectrum of a sample window: the mean and max hold of FFTs across it.

| Parameter | Default | |
|---|---|---|
| `start` | 0 | First sample |
| `count` | to the end | Number of samples |
| `fft`, `window` | 1024, `hann` | As for `overview` |

Body: `fft` mean values then `fft` max-hold values, `f32` dBFS, fftshifted. `x-trfiq-mode` is
`full` (every FFT segment in the window) or `strided` (the window is over 2,097,152 samples, so
that many samples' worth of segments are spread evenly across it). Also returns
`x-trfiq-segments`, `x-trfiq-fft`, `x-trfiq-start` and `x-trfiq-count`.

### `GET /api/recordings/{id}/time`

I/Q of a sample window, normalised to about ±1.

| Parameter | Default | |
|---|---|---|
| `start`, `count` | whole file | Sample window |
| `points` | 2048 | Envelope buckets, 64 to 8192 |

`x-trfiq-mode` tells you the layout:

| Mode | When | Body (`f32`) |
|---|---|---|
| `raw` | `count` ≤ 65,536 | `count × [i, q]` |
| `minmax` | `count` ≤ 2,097,152 | `points × [i_min, i_max, q_min, q_max]`, from every sample |
| `sampled` | larger | Same layout, each bucket from an evenly spaced slice |

Also returns `x-trfiq-start`, `x-trfiq-count` and `x-trfiq-points`.

## Health

| | |
|---|---|
| `GET /healthz` | `200 ok` while the process is up |
| `GET /readyz` | `200` once every source has been scanned, else `503`; the body has per-source status |
