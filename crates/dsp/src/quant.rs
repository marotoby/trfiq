//! Fixed global dB ↔ `u16` mapping shared with the frontend shader (ADR 0002).

pub const DB_MIN: f32 = -200.0;
pub const DB_STEP: f32 = 0.005;

#[inline(always)]
pub fn quantize(db: f32) -> u16 {
    ((db - DB_MIN) / DB_STEP)
        .round()
        .clamp(0.0, u16::MAX as f32) as u16
}

#[inline(always)]
pub fn dequantize(q: u16) -> f32 {
    DB_MIN + q as f32 * DB_STEP
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_clamp() {
        for db in [-150.0f32, -60.123, 0.0, 30.5] {
            assert!((dequantize(quantize(db)) - db).abs() <= DB_STEP / 2.0 + 1e-4);
        }
        assert_eq!(quantize(-500.0), 0);
        assert_eq!(quantize(500.0), u16::MAX);
        assert_eq!(quantize(f32::NEG_INFINITY), 0);
    }
}
