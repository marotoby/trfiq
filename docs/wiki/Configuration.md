# Configuration

T-RF/IQ reads one YAML file, `/etc/trfiq/config.yaml` by default. Change the path with
`--config <path>` or the `TRFIQ_CONFIG` environment variable.

## Quickest: one bucket, environment only

The image ships with a config for a single S3 source that takes everything from the environment:

```sh
docker run -d --name trfiq -p 8080:8080 \
  -e S3_ENDPOINT=http://minio.lan:9000 \
  -e S3_BUCKET=recordings \
  -e S3_ACCESS_KEY_ID=… -e S3_SECRET_ACCESS_KEY=… \
  -v trfiq-data:/var/lib/trfiq \
  trfiq
```

| Variable | Default | |
|---|---|---|
| `S3_ENDPOINT` | `http://minio:9000` | S3 endpoint URL |
| `S3_BUCKET` | `recordings` | Bucket to index |
| `S3_ACCESS_KEY_ID` | *(required)* | Access key |
| `S3_SECRET_ACCESS_KEY` | *(required)* | Secret key |

## Full example

```yaml
listen: 0.0.0.0:8080          # address:port to serve on
data_dir: /var/lib/trfiq      # index and caches only; never recordings
scan_interval_secs: 300       # incremental rescan interval (minimum 10)

sources:
  - id: lab                   # stable id: used in URLs and the index
    name: Lab MinIO           # shown in the UI (defaults to id)
    kind: s3
    endpoint: http://minio.lan:9000
    bucket: recordings
    prefix: captures/2026/    # optional: only index under this prefix
    access_key_id: ${S3_ACCESS_KEY_ID}
    secret_access_key: ${S3_SECRET_ACCESS_KEY}
    max_concurrency: 32       # optional: concurrent requests to this server

  - id: aws
    kind: s3
    bucket: my-iq-archive
    region: eu-west-1         # AWS: omit endpoint, set region
    virtual_hosted: true      # AWS-style bucket.host URLs (MinIO wants false, the default)
    access_key_id: ${AWS_ACCESS_KEY_ID}
    secret_access_key: ${AWS_SECRET_ACCESS_KEY}

  - id: archive
    name: NAS archive
    kind: local
    path: /mnt/recordings     # mount it read-only
```

## Reference

### Top level

| Key | Default | |
|---|---|---|
| `listen` | `0.0.0.0:8080` | Address and port |
| `data_dir` | `/var/lib/trfiq` | Holds `index.sqlite`. Safe to delete: everything is rebuilt by rescanning |
| `scan_interval_secs` | `300` | How often each source is rescanned (values under 10 are raised to 10). The **Rescan** button on a source card triggers a scan immediately |
| `sources` | *(required)* | One or more sources |

Unknown top-level keys are rejected, so typos fail at startup.

### Every source

| Key | Default | |
|---|---|---|
| `id` | *(required)* | Letters, digits, `-` and `_`; unique. **Don't rename it**: it keys the index, so a new id means a full reindex and old links break |
| `name` | the id | Display name |
| `kind` | *(required)* | `s3` or `local` |
| `prefix` | none | Only objects under this prefix are indexed |
| `max_concurrency` | `32` | Upper bound on simultaneous requests to this source |

### `kind: s3`

| Key | Default | |
|---|---|---|
| `bucket` | *(required)* | |
| `endpoint` | AWS | e.g. `http://minio:9000`. Omit for AWS S3 |
| `region` | none | Needed for AWS |
| `access_key_id`, `secret_access_key` | none | Use `${VAR}` so secrets stay out of the file |
| `virtual_hosted` | `false` | `true` for `bucket.host` URLs (AWS); MinIO and most self-hosted servers want path style (`false`) |

**Permissions:** `s3:ListBucket` and `s3:GetObject` are enough. T-RF/IQ never writes, so give it a
read-only key. Example MinIO policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": ["arn:aws:s3:::recordings"] },
    { "Effect": "Allow", "Action": ["s3:GetObject"], "Resource": ["arn:aws:s3:::recordings/*"] }
  ]
}
```

### `kind: local`

| Key | |
|---|---|
| `path` | A directory inside the container. Mount it read-only (`-v /data/iq:/mnt/recordings:ro`) |

## Environment variables in the config

`${VAR}` is replaced by the variable's value and `${VAR:-default}` falls back to `default`. A
`${VAR}` that is unset and has no default **stops startup** with
`config references unset environment variable VAR`, so a missing secret is caught at once
rather than showing up later as an S3 authentication error.

## Other settings

| Variable | Default | |
|---|---|---|
| `TRFIQ_CONFIG` | `/etc/trfiq/config.yaml` | Config path (same as `--config`) |
| `RUST_LOG` | `info,tower_http=warn` | Log filter, e.g. `info,trfiq_server=debug` |
| `TRFIQ_LOG_FORMAT` | JSON | `pretty` for human-readable logs |

See also: [Deployment](Deployment.md).
