# 5. Data buckets are read-only

**Status:** accepted (2026-11-15)

## Context

Recordings are expensive or impossible to recreate. An IQ viewer has no need to modify them
for the MVP (annotation editing is out of scope).

## Decision

trfiq never writes to a data source. It only needs list and get permissions. All derived data
(index, tile cache, pyramids, user-supplied metadata for raw files) lives on the app's own
volume.

## Consequences

- A bug in trfiq cannot corrupt or delete a recording.
- Operators can give trfiq a read-only S3 policy.
- Raw-file metadata entered in the UI is not visible to other SigMF tools unless exported.
- Annotation editing, when added, needs its own ADR (write-back vs. sidecar store).
