//! Wire format of the binary sample endpoints: every response layout, its headers and its
//! mode values, in one place. The browser's counterpart is `web/src/wire.ts`; the fixtures in
//! `web/src/wire-fixtures/` are written from this module and decoded by that one, so a layout
//! change that only one side knows about fails a test.
//!
//! All numbers are little-endian. Every response also carries
//! `Server-Timing: read;dur=…, compute;dur=…`.

use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Response};
use trfiq_dsp::quant;

use crate::samples::SampleWindow;

/// How the time endpoint summarised its window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeMode {
    /// Every sample: `count × [i, q]` `f32`.
    Raw,
    /// `points × [i_min, i_max, q_min, q_max]` `f32`, from every sample.
    MinMax,
    /// Same layout as `MinMax`, each bucket from an evenly spaced slice (window over the cap).
    Sampled,
}

/// How the PSD endpoint covered its window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PsdMode {
    /// Every FFT segment in the window.
    Full,
    /// Evenly spaced segments (window over the cap).
    Strided,
}

impl TimeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Raw => "raw",
            Self::MinMax => "minmax",
            Self::Sampled => "sampled",
        }
    }
}

impl PsdMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Strided => "strided",
        }
    }
}

/// An encoded response: `x-trfiq-*` headers and the body.
#[derive(Debug, Clone, PartialEq)]
pub struct Encoded {
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl Encoded {
    /// The HTTP response, with the `Server-Timing` value from the sample reader.
    pub fn respond(self, server_timing: String) -> Response {
        let mut h = HeaderMap::new();
        h.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/octet-stream"),
        );
        h.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, max-age=60"),
        );
        for (k, v) in self
            .headers
            .iter()
            .chain([&("server-timing", server_timing)])
        {
            h.insert(*k, HeaderValue::from_str(v).expect("ascii header"));
        }
        (h, self.body).into_response()
    }
}

fn f32s(data: &[f32]) -> impl Iterator<Item = u8> + '_ {
    data.iter().flat_map(|v| v.to_le_bytes())
}

/// Overview: `rows × fft` `u16` quantised dB (`dB = db_min + q × db_step`), fftshifted,
/// row-major.
pub fn overview(fft: usize, data: &[u16]) -> Encoded {
    Encoded {
        headers: vec![
            ("x-trfiq-mode", "strided".into()),
            ("x-trfiq-fft", fft.to_string()),
            ("x-trfiq-rows", (data.len() / fft.max(1)).to_string()),
            ("x-trfiq-db-min", quant::DB_MIN.to_string()),
            ("x-trfiq-db-step", quant::DB_STEP.to_string()),
        ],
        body: data.iter().flat_map(|v| v.to_le_bytes()).collect(),
    }
}

/// Time-domain I/Q of a window. `data` is laid out as `mode` says (see [`TimeMode`]).
pub fn time(mode: TimeMode, window: SampleWindow, data: &[f32]) -> Encoded {
    let per_point = if mode == TimeMode::Raw { 2 } else { 4 };
    Encoded {
        headers: vec![
            ("x-trfiq-mode", mode.as_str().into()),
            ("x-trfiq-start", window.start.to_string()),
            ("x-trfiq-count", window.count.to_string()),
            ("x-trfiq-points", (data.len() / per_point).to_string()),
        ],
        body: f32s(data).collect(),
    }
}

/// PSD of a window: `fft` mean dBFS then `fft` max-hold dBFS, `f32`, fftshifted.
pub fn psd(
    mode: PsdMode,
    window: SampleWindow,
    segments: usize,
    mean: &[f32],
    max: &[f32],
) -> Encoded {
    Encoded {
        headers: vec![
            ("x-trfiq-mode", mode.as_str().into()),
            ("x-trfiq-fft", mean.len().to_string()),
            ("x-trfiq-segments", segments.to_string()),
            ("x-trfiq-start", window.start.to_string()),
            ("x-trfiq-count", window.count.to_string()),
        ],
        body: f32s(mean).chain(f32s(max)).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn w(start: u64, count: u64) -> SampleWindow {
        SampleWindow { start, count }
    }

    /// Small examples of every layout. Each becomes `web/src/wire-fixtures/<name>.json`.
    fn examples() -> Vec<(&'static str, Encoded)> {
        vec![
            (
                "overview",
                overview(4, &[0, 1, 40000, 65535, 20000, 20001, 20002, 20003]),
            ),
            (
                "time-raw",
                time(TimeMode::Raw, w(10, 3), &[0.5, -0.5, 1.0, 0.0, -1.0, 0.25]),
            ),
            (
                "time-minmax",
                time(
                    TimeMode::MinMax,
                    w(0, 100_000),
                    &[-1.0, 1.0, -0.5, 0.5, -0.25, 0.25, 0.0, 0.125],
                ),
            ),
            (
                "time-sampled",
                time(TimeMode::Sampled, w(5, 9_000_000), &[-1.0, 1.0, -0.5, 0.5]),
            ),
            (
                "psd",
                psd(
                    PsdMode::Strided,
                    w(1000, 5_000_000),
                    2048,
                    &[-100.0, -90.0, -6.0, -95.0],
                    &[-80.0, -70.0, -3.0, -75.0],
                ),
            ),
        ]
    }

    fn fixture(e: &Encoded) -> serde_json::Value {
        let mut headers: serde_json::Map<_, _> = e
            .headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone().into()))
            .collect();
        headers.insert(
            "server-timing".into(),
            "read;dur=1.5, compute;dur=2.0".into(),
        );
        let hex: String = e.body.iter().map(|b| format!("{b:02x}")).collect();
        serde_json::json!({ "headers": headers, "body_hex": hex })
    }

    /// The fixtures the web tests decode are exactly what this module encodes. Run with
    /// `TRFIQ_UPDATE_FIXTURES=1` to rewrite them after an intended layout change.
    #[test]
    fn web_fixtures_match_the_encoders() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/src/wire-fixtures");
        let update = std::env::var_os("TRFIQ_UPDATE_FIXTURES").is_some();
        for (name, e) in examples() {
            let path = dir.join(format!("{name}.json"));
            let want = serde_json::to_string_pretty(&fixture(&e)).unwrap() + "\n";
            if update {
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::write(&path, &want).unwrap();
            }
            let got = std::fs::read_to_string(&path).unwrap_or_else(|_| {
                panic!(
                    "{} missing: run with TRFIQ_UPDATE_FIXTURES=1",
                    path.display()
                )
            });
            assert_eq!(
                got, want,
                "{name}: the wire format changed; rerun with TRFIQ_UPDATE_FIXTURES=1 and update web/src/wire.ts"
            );
        }
    }

    #[test]
    fn counts_follow_the_data() {
        assert_eq!(
            overview(4, &[0; 12]).headers[2],
            ("x-trfiq-rows", "3".into())
        );
        let t = time(TimeMode::MinMax, w(0, 10), &[0.0; 12]);
        assert!(t.headers.contains(&("x-trfiq-points", "3".into())));
        let t = time(TimeMode::Raw, w(0, 6), &[0.0; 12]);
        assert!(t.headers.contains(&("x-trfiq-points", "6".into())));
        assert_eq!(
            psd(PsdMode::Full, w(0, 8), 2, &[0.0; 4], &[0.0; 4])
                .body
                .len(),
            32
        );
    }
}
