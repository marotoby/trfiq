# Glossary

The words this codebase uses for its own concepts. Code, docs and commit messages use them
with these meanings.

**Recording**
A data object plus its metadata (usually a SigMF `.sigmf-data` / `.sigmf-meta` pair) in a
source. Its samples are indexed `0 … N−1`.

**Viewable**
A recording whose samples can be read and drawn: not broken, with a data file, a supported
datatype and at least one sample. Decided once, by the index (`viewability` in
`crates/index/src/db.rs`), and exposed as `viewable` / `not_viewable_reason`. The sample
endpoints, the viewer, previews and the gallery all go by it.

**Sample window**
A non-empty range `[start, start + count)` of one recording's samples. Requests name one with
`start` and `count`; a window that runs past the end is trimmed, one that starts past it is an
error. `SampleWindow` in `crates/server/src/samples.rs`.

**Slot**
One of `R` equal parts of a recording: slot `i` is `[i·N/R, (i+1)·N/R)`. Overview row `i`
stands for slot `i`, and the spectrogram draws it there.

**Read plan**
The sample ranges a request reads from a window, in order, each handed to the compute as one
chunk. Either every sample, read in one range, or (past the detail cap of 2M samples) evenly
spread slices. The only place the cap is applied. `ReadPlan`.
_Avoid_: offsets, strides.

**Sample-window reader**
The module every sample endpoint goes through: it fetches a read plan's byte ranges, runs the
DSP compute on the rayon pool with a cancel flag that trips if the client goes away, and times
both phases (`Server-Timing: read, compute`). `SampleReader`.

**Overview**
The whole-recording spectrogram the viewer opens with: one FFT per row, each centred in its
slot (ADR 0003, ADR 0006). Also used, smaller, for thumbnails.
_Avoid_: tile (reserved for the future full-resolution tiles).

**Detail window**
The sample window and frequency range visible in the spectrogram, which the Spectrum and Time
panels analyse. `DetailWindow` in `web/src/geometry.ts`.

**Recording geometry**
How one recording, at one FFT size, maps onto the spectrogram's `[0, 1]²` texture space and
back: texture x ↔ frequency (each column at its FFT bin's centre), texture y ↔ sample index ↔
time, and the units to show them in (Hz and seconds, or cycles/sample and samples without a
sample rate). `Geometry` in `web/src/geometry.ts`.

**Annotation**
A SigMF annotation: a sample range, optionally a frequency range, a label and a comment. Drawn
as a box on the spectrogram (the whole band when it has no frequency range) and a band on the
Time panel.
