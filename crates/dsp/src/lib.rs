//! Sample decoding, spectra and spectrogram rows.
//!
//! Output power is in dB relative to full scale, quantised to `u16` with the fixed global
//! mapping in [`quant`] (see ADR 0002).

pub mod datatype;
pub mod quant;
pub mod spectrum;
pub mod window;

pub use datatype::Datatype;
pub use spectrum::{Spectrogram, strided_offsets};
pub use window::Window;

/// Smallest and largest FFT sizes the API accepts.
pub const FFT_MIN: usize = 16;
pub const FFT_MAX: usize = 65536;

#[derive(Debug, thiserror::Error)]
pub enum DspError {
    #[error("unsupported SigMF datatype `{0}`")]
    UnsupportedDatatype(String),
    #[error("fft size must be a power of two in {FFT_MIN}..={FFT_MAX}, got {0}")]
    BadFftSize(usize),
    #[error("unknown window `{0}`")]
    UnknownWindow(String),
    #[error("cancelled")]
    Cancelled,
}
