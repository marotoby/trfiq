# Recordings and formats

## What gets indexed

On each scan T-RF/IQ lists every object in each source (under `prefix`, if set) and groups them
into recordings:

| Objects | Becomes |
|---|---|
| `name.sigmf-meta` + `name.sigmf-data` | One SigMF recording `name` |
| A file with a raw IQ extension (below) | One raw recording, named with its extension |
| Anything else | Ignored |

Raw extensions: `.bin .cfile .iq .raw .dat .cu8 .cs8 .cs16 .sc16 .cf32 .fc32` (any case).

Scans are **incremental**: metadata is re-read only when an object's ETag changes, and rows for
deleted objects are removed. Rescanning an unchanged bucket takes milliseconds.

## Status

| Status | Meaning | Viewable? |
|---|---|---|
| **Ready** | A valid SigMF pair | Yes |
| **Needs metadata** | A raw file. The datatype is guessed from the extension where a convention exists | When the datatype was guessed (see below), with placeholder axes |
| **Broken** | Something is wrong; the UI shows exactly what | No |

Reasons a recording is **Broken**:

- `missing .sigmf-meta`: a `.sigmf-data` without its metadata
- `missing .sigmf-data`: metadata without data
- The `.sigmf-meta` isn't valid JSON, lacks `global`, or lacks `core:datatype`
- `unsupported SigMF datatype …`

## SigMF fields used

| Field | Used for |
|---|---|
| `global.core:datatype` | Decoding (required) |
| `global.core:sample_rate` | Time and frequency axes |
| `captures[0].core:frequency` | Centre frequency |
| `captures[0].core:datetime` | Capture date (searchable and filterable) |
| `global.core:description`, `core:author`, `core:hw` | Shown in Details; full-text searchable |
| `annotations[]` | Overlay, panel and label search (below) |

The whole metadata document is stored in the index and returned by the API, so other fields
are kept, just not interpreted yet.

### Annotations

| Field | |
|---|---|
| `core:sample_start` | Required; annotations without it are skipped |
| `core:sample_count` | Duration (defaults to 1 sample) |
| `core:freq_lower_edge`, `core:freq_upper_edge` | Frequency extent in Hz. Without them the annotation spans the full band |
| `core:label` | Label, colour and filter chip (defaults to `annotation`) |
| `core:comment` | Shown in the panel |

Each label always gets the same colour, everywhere.

## Datatypes

Every SigMF datatype is supported:

| | Complex | Real |
|---|---|---|
| Float | `cf64` `cf32` | `rf64` `rf32` |
| Signed int | `ci32` `ci16` `ci8` | `ri32` `ri16` `ri8` |
| Unsigned int | `cu32` `cu16` `cu8` | `ru32` `ru16` `ru8` |

Multi-byte types need `_le` or `_be` (e.g. `ci16_le`); 8-bit types must not have it.

Samples are normalised to about ±1 full scale: signed integers divide by 2^(bits−1); unsigned
integers are first shifted to mid-scale (the rtl_sdr convention for `cu8`); real types have
imaginary part 0. Power is shown in **dBFS**: a full-scale complex tone reads 0 dB whatever
the FFT size or window.

## Raw files

| Extension | Datatype guessed |
|---|---|
| `.cu8` | `cu8` (rtl_sdr) |
| `.cs8` | `ci8` (HackRF) |
| `.cs16`, `.sc16` | `ci16_le` |
| `.cf32`, `.cfile`, `.fc32` | `cf32_le` (GNU Radio) |
| `.bin .iq .raw .dat` | not guessed |

A raw file has no sample rate or centre frequency, so even when it can be drawn its axes are
in cycles per sample and samples (see [Axes and units](Using-the-Viewer.md#axes-and-units)).
Entering metadata for raw files in the UI is on the roadmap. Until then, the fix is to write a
`.sigmf-meta` next to the data, renaming the data to `.sigmf-data`:

```json
{
  "global": { "core:datatype": "cu8", "core:sample_rate": 2400000, "core:version": "1.2.0" },
  "captures": [{ "core:sample_start": 0, "core:frequency": 433920000 }],
  "annotations": []
}
```
