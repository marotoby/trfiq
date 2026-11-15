# 4. Embedded SQLite index, refreshed by ETag-incremental rescans

**Status:** accepted (2026-11-15)

## Context

Listing a bucket and parsing every `.sigmf-meta` on each page load is what makes IQEngine's
browser slow. Buckets hold 10k+ objects.

## Decision

- Keep an index in **SQLite** (WAL mode, FTS5 for text search) on a Docker volume, inside the
  app container. No separate database service.
- Refresh it with a **periodic incremental rescan** (default every 5 min): list the source,
  re-read only `.sigmf-meta` objects whose ETag changed, delete rows whose objects vanished.
  A "rescan now" button triggers the same scan.
- MinIO bucket notifications may be added later as an optimisation, but the rescan remains,
  because notifications differ between S3 providers and can drop events.

## Consequences

- Listing and filtering 10k–1M recordings is a local query (milliseconds).
- New files appear within the rescan interval, or immediately via the button.
- The index can be deleted and rebuilt from S3 at any time. The exception is user-supplied
  metadata for raw files, which is exported/imported as JSON.
