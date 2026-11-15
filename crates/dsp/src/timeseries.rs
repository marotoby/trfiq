//! Time-domain I/Q for plotting: raw samples, or a min/max envelope with one bucket per chunk.
//!
//! The envelope keeps every peak in a bucket visible however far the plot is zoomed out,
//! the time-domain counterpart of the spectrogram's max-hold.

use std::sync::atomic::{AtomicBool, Ordering};

use num_complex::Complex32;
use rayon::prelude::*;

use crate::{Datatype, DspError};

/// Decode to interleaved `[i0, q0, i1, q1, …]`, normalised like the spectrogram input.
pub fn iq(dtype: Datatype, bytes: &[u8]) -> Vec<f32> {
    let mut buf = Vec::new();
    dtype.decode_into(bytes, &mut buf);
    buf.iter().flat_map(|c| [c.re, c.im]).collect()
}

/// One `[i_min, i_max, q_min, q_max]` per chunk, flattened. An empty chunk yields zeros.
/// Checks `cancel` between chunks.
pub fn envelope<B: AsRef<[u8]> + Sync>(
    dtype: Datatype,
    chunks: &[B],
    cancel: &AtomicBool,
) -> Result<Vec<f32>, DspError> {
    let mut out = vec![0f32; chunks.len() * 4];
    out.par_chunks_mut(4)
        .zip(chunks.par_iter())
        .try_for_each_init(Vec::new, |buf: &mut Vec<Complex32>, (o, chunk)| {
            if cancel.load(Ordering::Relaxed) {
                return Err(DspError::Cancelled);
            }
            dtype.decode_into(chunk.as_ref(), buf);
            if !buf.is_empty() {
                let e = buf.iter().fold(
                    [f32::MAX, f32::MIN, f32::MAX, f32::MIN],
                    |[a, b, c, d], s| [a.min(s.re), b.max(s.re), c.min(s.im), d.max(s.im)],
                );
                o.copy_from_slice(&e);
            }
            Ok(())
        })?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iq_and_envelope() {
        let dt = Datatype::parse("ci8").unwrap();
        let bytes: Vec<u8> = [64i8, -64, -128, 32, 0, 0, 127, -1]
            .map(|v| v as u8)
            .to_vec();
        assert_eq!(iq(dt, &bytes[..4]), vec![0.5, -0.5, -1.0, 0.25]);
        let env = envelope(
            dt,
            &[&bytes[..4], &bytes[4..], &[][..]],
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(
            env,
            vec![
                -1.0,
                0.5,
                -0.5,
                0.25, // bucket 0
                0.0,
                127.0 / 128.0,
                -1.0 / 128.0,
                0.0, // bucket 1
                0.0,
                0.0,
                0.0,
                0.0, // empty
            ]
        );
        assert!(matches!(
            envelope(dt, &[&bytes[..]], &AtomicBool::new(true)),
            Err(DspError::Cancelled)
        ));
    }
}
