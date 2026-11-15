# 3. Instant strided overview, then a lazy background max-hold pyramid

**Status:** accepted (2026-11-15)

## Context

Showing a 100 GB recording fully zoomed out at full accuracy requires reading all 100 GB,
which takes minutes. Precomputing for every file at index time would read the whole bucket.

## Decision

1. On first open, compute a **strided overview**: ~1–2k evenly spaced FFT-sized chunks, one
   FFT each, read with coalesced range requests. This meets the < 2 s first-overview budget.
2. In the background, build a **max-hold pyramid** with one full pass, lazily (only for
   files that are opened), cache it on the local volume, and swap it in progressively.

## Consequences

- The first view is fast, but may miss short bursts until the pyramid finishes. The UI shows
  which mode is active and the pyramid's progress.
- Unopened files cost nothing.
- The pyramid is cached by ETag, so a changed file is recomputed and an unchanged one never is.
