use std::f64::consts::PI;
use std::str::FromStr;

use crate::DspError;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, Default, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "kebab-case")]
pub enum Window {
    #[default]
    Hann,
    BlackmanHarris,
    Rect,
}

impl FromStr for Window {
    type Err = DspError;
    fn from_str(s: &str) -> Result<Self, DspError> {
        match s {
            "hann" => Ok(Self::Hann),
            "blackman-harris" => Ok(Self::BlackmanHarris),
            "rect" => Ok(Self::Rect),
            _ => Err(DspError::UnknownWindow(s.to_string())),
        }
    }
}

impl Window {
    /// Periodic (DFT-even) window coefficients, matching `scipy.signal.get_window`.
    pub fn coefficients(self, n: usize) -> Vec<f32> {
        let x = |i: usize| 2.0 * PI * i as f64 / n as f64;
        (0..n)
            .map(|i| match self {
                Window::Rect => 1.0,
                Window::Hann => 0.5 - 0.5 * x(i).cos(),
                Window::BlackmanHarris => {
                    0.35875 - 0.48829 * x(i).cos() + 0.14128 * (2.0 * x(i)).cos()
                        - 0.01168 * (3.0 * x(i)).cos()
                }
            } as f32)
            .collect()
    }
}
