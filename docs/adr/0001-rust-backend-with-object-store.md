# 1. Rust backend with `object_store` for all storage

**Status:** accepted (2026-11-15)

## Context

The hot path is: read byte ranges from S3, decode samples, window, FFT, convert to dB,
quantise, compress. It must stay fast on 100 GB files and must not fall over under load.
IQEngine uses Python for its backend and JavaScript for FFTs, and both are part of why it's slow.

Storage must be S3/MinIO-first, but local folders must also work.

## Decision

- Backend in **Rust**: axum + tokio for HTTP, `rustfft` for FFTs, rayon for CPU parallelism.
- All storage goes through the **`object_store`** crate. S3, MinIO and local folders are each an
  `Arc<dyn ObjectStore>`, so there is one code path. Local support costs almost nothing.

## Consequences

- Predictable latency (no GC pauses), easy multi-core FFT, single static-ish binary.
- Memory safety and a strong type system help stability.
- Rust has a steeper learning curve than Go or Python; the maintainer has accepted that.
- DSP plugins in Python are not possible in-process. That's fine because plugins are out of scope.
