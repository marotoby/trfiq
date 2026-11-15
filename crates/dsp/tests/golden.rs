//! Compare Rust spectra against numpy/scipy references (scripts/gen_golden.py).

use std::path::Path;

use trfiq_dsp::{Datatype, Spectrogram, Window};

#[derive(serde::Deserialize)]
struct Cases {
    fft_size: usize,
    cases: Vec<Case>,
}

#[derive(serde::Deserialize)]
struct Case {
    datatype: String,
    window: Window,
    input: String,
    expected: String,
}

#[test]
fn matches_numpy_reference() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden");
    let cases: Cases =
        serde_json::from_slice(&std::fs::read(dir.join("cases.json")).unwrap()).unwrap();
    assert!(cases.cases.len() >= 30);
    let n = cases.fft_size;
    for c in &cases.cases {
        let input = std::fs::read(dir.join(&c.input)).unwrap();
        let expected: Vec<f32> = std::fs::read(dir.join(&c.expected))
            .unwrap()
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| f32::from_le_bytes(*b))
            .collect();
        let s = Spectrogram::new(Datatype::parse(&c.datatype).unwrap(), n, c.window).unwrap();
        let mut got = vec![0.0; n];
        s.row_db(&input, &mut got);
        for k in 0..n {
            // Bins well above the noise floor must agree tightly; deep sidelobes of
            // the rect window are dominated by f32 rounding, so compare those loosely.
            let tol = if expected[k] > -80.0 { 0.01 } else { 1.0 };
            assert!(
                (got[k] - expected[k]).abs() < tol,
                "{} {:?} bin {k}: got {} expected {}",
                c.datatype,
                c.window,
                got[k],
                expected[k]
            );
        }
    }
}
