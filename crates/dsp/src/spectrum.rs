//! Windowed FFT → power (dBFS) → fftshift → quantised rows.
//!
//! Power is normalised by `(Σw)²`, so a full-scale complex tone centred on a bin reads 0 dB
//! regardless of FFT size or window.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use num_complex::Complex32;
use rayon::prelude::*;
use rustfft::{Fft, FftPlanner};

use crate::{Datatype, DspError, FFT_MAX, FFT_MIN, Window, quant};

static PLANNER: LazyLock<Mutex<FftPlanner<f32>>> = LazyLock::new(|| Mutex::new(FftPlanner::new()));

/// A configured spectrogram: datatype + FFT size + window. Cheap to clone, `Send + Sync`.
#[derive(Clone)]
pub struct Spectrogram {
    dtype: Datatype,
    n: usize,
    fft: Arc<dyn Fft<f32>>,
    window: Arc<[f32]>,
    inv_norm: f32,
}

impl Spectrogram {
    pub fn new(dtype: Datatype, n: usize, window: Window) -> Result<Self, DspError> {
        if !n.is_power_of_two() || !(FFT_MIN..=FFT_MAX).contains(&n) {
            return Err(DspError::BadFftSize(n));
        }
        let fft = PLANNER.lock().unwrap().plan_fft_forward(n);
        let window = window.coefficients(n);
        let sum: f32 = window.iter().sum();
        Ok(Self {
            dtype,
            n,
            fft,
            window: window.into(),
            inv_norm: 1.0 / (sum * sum),
        })
    }

    pub fn fft_size(&self) -> usize {
        self.n
    }

    /// Bytes of input one row consumes.
    pub fn row_bytes(&self) -> usize {
        self.n * self.dtype.sample_size()
    }

    /// Power spectrum in dBFS, fftshifted (DC in the middle). Short input is zero-padded.
    pub fn row_db(&self, bytes: &[u8], out: &mut [f32]) {
        let mut buf = Vec::with_capacity(self.n);
        let mut scratch = vec![Complex32::default(); self.fft.get_inplace_scratch_len()];
        self.row_with(bytes, &mut buf, &mut scratch, |k, p| out[k] = to_db(p));
    }

    fn row_with(
        &self,
        bytes: &[u8],
        buf: &mut Vec<Complex32>,
        scratch: &mut [Complex32],
        mut emit: impl FnMut(usize, f32),
    ) {
        // Emits normalised linear power per fftshifted bin.
        let n = self.n;
        self.dtype
            .decode_into(&bytes[..bytes.len().min(self.row_bytes())], buf);
        buf.resize(n, Complex32::default());
        for (s, w) in buf.iter_mut().zip(self.window.iter()) {
            *s *= *w;
        }
        self.fft.process_with_scratch(buf, scratch);
        let half = n / 2;
        for (k, x) in buf.iter().enumerate() {
            // fftshift: bin k lands at (k + n/2) mod n.
            emit((k + half) % n, x.norm_sqr() * self.inv_norm);
        }
    }

    /// Compute one quantised row per input chunk, in parallel on the rayon pool.
    /// Returns `rows × n` values, row-major. Checks `cancel` between rows.
    pub fn rows<B: AsRef<[u8]> + Sync>(
        &self,
        chunks: &[B],
        cancel: &AtomicBool,
    ) -> Result<Vec<u16>, DspError> {
        let n = self.n;
        let mut out = vec![0u16; chunks.len() * n];
        out.par_chunks_mut(n)
            .zip(chunks.par_iter())
            .try_for_each_init(
                || {
                    let scratch = vec![Complex32::default(); self.fft.get_inplace_scratch_len()];
                    (Vec::with_capacity(n), scratch)
                },
                |(buf, scratch), (row, chunk)| {
                    if cancel.load(Ordering::Relaxed) {
                        return Err(DspError::Cancelled);
                    }
                    self.row_with(chunk.as_ref(), buf, scratch, |k, p| {
                        row[k] = quant::quantize(to_db(p))
                    });
                    Ok(())
                },
            )?;
        Ok(out)
    }

    /// Welch-style power spectral density: one windowed FFT per chunk, combined in linear
    /// power. Returns `(mean_db, max_db)`, each `n` values in dBFS, fftshifted.
    pub fn psd<B: AsRef<[u8]> + Sync>(
        &self,
        chunks: &[B],
        cancel: &AtomicBool,
    ) -> Result<(Vec<f32>, Vec<f32>), DspError> {
        let n = self.n;
        let (sum, max) = chunks
            .par_iter()
            .try_fold(
                || {
                    let scratch = vec![Complex32::default(); self.fft.get_inplace_scratch_len()];
                    (Vec::with_capacity(n), scratch, vec![0f64; n], vec![0f32; n])
                },
                |(mut buf, mut scratch, mut sum, mut max), chunk| {
                    if cancel.load(Ordering::Relaxed) {
                        return Err(DspError::Cancelled);
                    }
                    self.row_with(chunk.as_ref(), &mut buf, &mut scratch, |k, p| {
                        sum[k] += p as f64;
                        max[k] = max[k].max(p);
                    });
                    Ok((buf, scratch, sum, max))
                },
            )
            .map(|r| r.map(|(_, _, s, m)| (s, m)))
            .try_reduce(
                || (vec![0f64; n], vec![0f32; n]),
                |(mut s1, mut m1), (s2, m2)| {
                    for k in 0..n {
                        s1[k] += s2[k];
                        m1[k] = m1[k].max(m2[k]);
                    }
                    Ok((s1, m1))
                },
            )?;
        let count = chunks.len().max(1) as f64;
        Ok((
            sum.iter().map(|&s| to_db((s / count) as f32)).collect(),
            max.iter().map(|&p| to_db(p)).collect(),
        ))
    }
}

fn to_db(p: f32) -> f32 {
    10.0 * (p + 1e-30).log10()
}

/// Sample offsets for a strided overview: `rows` evenly spaced FFT-sized reads covering
/// the whole recording. Files with fewer than `rows` FFTs worth of samples are read
/// contiguously instead (one row per non-overlapping FFT).
pub fn strided_offsets(num_samples: u64, n: usize, rows: usize) -> Vec<u64> {
    let n = n as u64;
    let available = (num_samples / n).max(1);
    if available <= rows as u64 {
        return (0..available).map(|i| i * n).collect();
    }
    let rows = rows.max(2) as u64;
    let span = num_samples - n;
    (0..rows).map(|i| i * span / (rows - 1)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::TAU;

    fn tone_cf32(n: usize, bin: f32, amp: f32) -> Vec<u8> {
        (0..n)
            .flat_map(|i| {
                let ph = TAU * bin * i as f32 / n as f32;
                [amp * ph.cos(), amp * ph.sin()]
            })
            .flat_map(f32::to_le_bytes)
            .collect()
    }

    #[test]
    fn full_scale_tone_reads_0_db_in_right_bin() {
        let n = 1024;
        let s = Spectrogram::new(Datatype::parse("cf32_le").unwrap(), n, Window::Hann).unwrap();
        let mut db = vec![0.0; n];
        s.row_db(&tone_cf32(n, 100.0, 1.0), &mut db);
        let (peak, &val) = db
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .unwrap();
        assert_eq!(peak, n / 2 + 100, "positive freq right of centre");
        assert!(val.abs() < 0.01, "peak {val} dB");
    }

    #[test]
    fn rows_match_row_db_and_honour_cancel() {
        let n = 256;
        let s = Spectrogram::new(Datatype::parse("cf32_le").unwrap(), n, Window::Rect).unwrap();
        let chunks = vec![tone_cf32(n, -20.0, 0.5), tone_cf32(n, 7.0, 0.1)];
        let q = s.rows(&chunks, &AtomicBool::new(false)).unwrap();
        let mut db = vec![0.0; n];
        s.row_db(&chunks[1], &mut db);
        for k in 0..n {
            assert!((quant::dequantize(q[n + k]) - db[k].max(quant::DB_MIN)).abs() < 0.01);
        }
        assert!(matches!(
            s.rows(&chunks, &AtomicBool::new(true)),
            Err(DspError::Cancelled)
        ));
    }

    #[test]
    fn psd_averages_in_linear_power_and_tracks_max() {
        let n = 256;
        let s = Spectrogram::new(Datatype::parse("cf32_le").unwrap(), n, Window::Hann).unwrap();
        // Same tone, full scale then -20 dB: mean power is (1 + 0.01) / 2 → -2.97 dB.
        let chunks = vec![tone_cf32(n, 10.0, 1.0), tone_cf32(n, 10.0, 0.1)];
        let (mean, max) = s.psd(&chunks, &AtomicBool::new(false)).unwrap();
        let k = n / 2 + 10;
        assert!((max[k] - 0.0).abs() < 0.01, "max {}", max[k]);
        assert!(
            (mean[k] - 10.0 * (1.01f32 / 2.0).log10()).abs() < 0.01,
            "mean {}",
            mean[k]
        );
        assert!(mean.iter().zip(&max).all(|(a, b)| a <= &(b + 1e-3)));
        assert!(matches!(
            s.psd(&chunks, &AtomicBool::new(true)),
            Err(DspError::Cancelled)
        ));
    }

    #[test]
    fn rejects_bad_fft_sizes() {
        let dt = Datatype::parse("cu8").unwrap();
        for n in [0, 8, 1000, 131072] {
            assert!(Spectrogram::new(dt, n, Window::Hann).is_err());
        }
    }

    #[test]
    fn strided_offsets_cover_file() {
        assert_eq!(strided_offsets(4096, 1024, 100), vec![0, 1024, 2048, 3072]);
        assert_eq!(strided_offsets(10, 1024, 100), vec![0]);
        let o = strided_offsets(1_000_000, 1024, 3);
        assert_eq!(o, vec![0, (1_000_000 - 1024) / 2, 1_000_000 - 1024]);
    }
}
