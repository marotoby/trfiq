## v0.3.0 (2026-11-15)

### Feat

- full-resolution tiles when zoomed in on time

### Fix

- **index**: decide once whether a recording can be drawn
- **wiki**: commit wiki syncs with the main repo's git identity

### Refactor

- **web**: one view model for the spectrogram's visible region
- own each response layout in one wire module per side

## v0.2.1 (2026-11-15)

### Fix

- **web**: place spectrogram columns at their bin centres and use honest units
- **server**: centre each overview row in its time slot

### Refactor

- **web**: one recording geometry for every axis and conversion
- **server**: read sample windows through one SampleReader

## v0.2.0 (2026-11-15)

### Feat

- **web**: folders view with source and directory tree

## v0.2.0-beta.0 (2026-11-15)

### Feat

- **web**: gallery view and waterfall preview on hover
- **web**: show annotations on the time plot
- **web**: spectrum and time plots for the visible window
- **api**: spectrum and time-domain endpoints for a sample window
- **web**: T-RF/IQ branding with logo, favicon and cyan accent
- **samples**: generate demo recordings including an annotated 433 MHz band
- **web**: recording browser and WebGL2 spectrogram viewer
- **server**: HTTP API with strided overview, health checks and embedded UI
- **index**: SQLite + FTS5 recording index with ETag-incremental scanner
- **storage**: read-only S3 and local sources over object_store
- **dsp**: decode SigMF datatypes and compute quantised dB spectra
