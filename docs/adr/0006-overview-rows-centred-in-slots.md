# 6. Overview rows are centred in equal time slots

**Status:** accepted (2026-11-15)

## Context

The strided overview (ADR 0003) reads one FFT per row. Rows used to be spaced evenly from
sample 0 to the last full FFT, so row 0 started at the first sample and the last row ended at
the last one. The viewer, though, draws row `i` of `R` over the time slot `[i/R, (i+1)/R)` of
the recording. The two disagreed: a burst near either end of a file was drawn up to half a
slot away from where it really is. The server also sent an `x-trfiq-last-offset` header
describing its spacing, which the viewer never used.

## Decision

Split the recording into `R` equal slots and centre each row's FFT in its slot: row `i` starts
at `(i + ½)·N/R − fft/2`, shifted inwards at the edges so it stays inside the file.
`R = min(rows, max(1, ⌊N/fft⌋))`. The rule lives in `ReadPlan::overview`
(`crates/server/src/samples.rs`). `x-trfiq-last-offset` is gone.

## Consequences

- What a row shows and where the viewer draws it now agree, whatever the file length.
- Rows no longer touch the very first and last samples of a long file; a burst confined to the
  first or last half-slot can be missed. The max-hold pyramid (ADR 0003) is the fix for
  missed bursts in general.
- A file with exactly `R` FFTs is still read back to back, with no gaps.
