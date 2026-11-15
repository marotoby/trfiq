# 2. Server-side spectrogram tiles as quantised `u16` dB

**Status:** accepted (2026-11-15)

## Context

Rendering a spectrogram in the browser from raw samples means shipping gigabytes to the client
and running FFTs in JavaScript. Shipping colour images instead means every colormap or
contrast change needs a round trip.

## Decision

The server computes power spectra and sends **dB values quantised to `u16`** using one fixed,
global mapping:

```
dB = DB_MIN + q * DB_STEP      DB_MIN = -200 dB, DB_STEP = 0.005 dB  (range -200 … +127.7 dB)
```

Responses are zstd/gzip-compressed. The client uploads them as `R16UI` textures and the WebGL2
fragment shader applies the dB window and colormap.

Only FFT size, window function and overlap cause a recompute.

## Consequences

- Colormap, dB floor/ceiling and contrast changes are instant (shader uniforms only).
- 2 bytes per bin: a 1024 × 1024 tile is 2 MiB raw, much less compressed.
- The fixed mapping makes tiles comparable across files, and the client never needs
  per-tile scaling metadata.
- 0.005 dB resolution is far below anything visible.
