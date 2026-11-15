# Troubleshooting

Start with `GET /readyz`: it shows each source's scan state and last error. Then check the
container logs (`docker logs trfiq`; set `RUST_LOG=info,trfiq_server=debug` for more).

## Startup

**`config references unset environment variable X`**: the config uses `${X}` and `X` isn't set.
Pass it with `-e X=…`, or give it a default: `${X:-value}`.

**`unknown field …`**: a top-level config key is misspelled. Allowed keys are `listen`,
`data_dir`, `scan_interval_secs` and `sources`.

**`source id "…" must be non-empty [A-Za-z0-9_-]`** or **`duplicate source id`**: fix the
`id` values.

**`create data_dir …: Permission denied`**: the container runs as uid 65532. Use a named
volume, or `chown 65532:65532` the bind-mounted directory.

## Sources

**Source card says "Scan failed"**: hover it for the error. Common S3 causes:

| Error mentions | Likely fix |
|---|---|
| connection refused / DNS | `endpoint` is wrong or unreachable *from inside the container*. `localhost` there means the container itself; use the host name, or put both on one network |
| 403 / AccessDenied / SignatureDoesNotMatch | Wrong keys, or the key lacks `s3:ListBucket` on the bucket |
| NoSuchBucket | Wrong `bucket`, or a `virtual_hosted` mismatch (MinIO wants `false`) |
| region | AWS needs `region` |

**Recordings are missing**: check `prefix`, and that the files use `.sigmf-meta`/`.sigmf-data`
or a [raw extension](Recordings-and-Formats.md#what-gets-indexed). New uploads appear after the
next scan (`scan_interval_secs`), or click ↻ on the source card.

**`/readyz` stays at 503**: a source hasn't completed a scan yet, or its scans keep failing.
The body says which.

## Recordings

**Broken: `missing .sigmf-meta`** (or `-data`): the pair is incomplete; both halves must share
the same name and folder.

**Broken: `missing core:datatype`** or **`unsupported SigMF datatype`**: fix the metadata. See
[datatypes](Recordings-and-Formats.md#datatypes); multi-byte types need `_le`/`_be`.

**Raw file shows strange axes**: raw files have no sample rate or centre frequency. Add a
`.sigmf-meta` ([how](Recordings-and-Formats.md#raw-files)).

**Everything looks like noise**: try **Auto** levels, a larger FFT, or Blackman-Harris for weak
signals near strong ones. Sparse short bursts can fall between the overview's slices: zoom in
on the time axis, or use the Time panel.

**Zoomed in, the spectrogram is blocky**: in time, it shouldn't be once the tile has loaded
(the status bar shows *tile*); if it stays blocky, check the browser console for a failed
`/tile` request. Each row is one FFT, so for finer time detail pick a smaller FFT. In
frequency, the resolution is the FFT's bin width: pick a larger FFT.

## Browser

**"WebGL2 is not available"**: enable hardware acceleration in the browser settings, or try
another browser. Remote desktops and some VMs disable WebGL.

**A view link doesn't open the same view**: the mouse mode and panel visibility are personal
settings and aren't in the URL. Everything else is.

## Demo stack

**`trfiq` stays "Created" under podman-compose**: start it once `seed` has exited (see
[Getting started](Getting-Started.md#using-podman)).

**Pull errors for MinIO images**: MinIO no longer publishes community images; the demo uses
RustFS instead. Your own MinIO server still works with T-RF/IQ.

**Permission denied on bind mounts (Fedora/RHEL)**: SELinux. Add `:z` to the volume.
