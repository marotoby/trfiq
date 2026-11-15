//! SigMF `core:datatype` parsing and decoding to normalised `Complex<f32>`.
//!
//! Integers are scaled to roughly [-1, 1): signed by `2^(bits-1)`, unsigned are offset to
//! mid-scale first (the rtl_sdr convention for `cu8`). Real types decode with imag = 0.

use num_complex::Complex32;

use crate::DspError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Elem {
    F64,
    F32,
    I32,
    I16,
    I8,
    U32,
    U16,
    U8,
}

impl Elem {
    pub const fn size(self) -> usize {
        match self {
            Elem::F64 => 8,
            Elem::F32 | Elem::I32 | Elem::U32 => 4,
            Elem::I16 | Elem::U16 => 2,
            Elem::I8 | Elem::U8 => 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Datatype {
    pub complex: bool,
    pub elem: Elem,
    pub big_endian: bool,
}

impl Datatype {
    /// Parse a SigMF datatype such as `cf32_le`, `ri16_be` or `cu8`.
    pub fn parse(s: &str) -> Result<Self, DspError> {
        let bad = || DspError::UnsupportedDatatype(s.to_string());
        let (body, big_endian) = match s.rsplit_once('_') {
            Some((b, "le")) => (b, false),
            Some((b, "be")) => (b, true),
            Some(_) => return Err(bad()),
            None => (s, false),
        };
        let complex = match body.as_bytes().first() {
            Some(b'c') => true,
            Some(b'r') => false,
            _ => return Err(bad()),
        };
        let elem = match &body[1..] {
            "f64" => Elem::F64,
            "f32" => Elem::F32,
            "i32" => Elem::I32,
            "i16" => Elem::I16,
            "i8" => Elem::I8,
            "u32" => Elem::U32,
            "u16" => Elem::U16,
            "u8" => Elem::U8,
            _ => return Err(bad()),
        };
        // Multi-byte types must state endianness; single-byte types must not.
        let has_suffix = body.len() != s.len();
        if (elem.size() > 1) != has_suffix {
            return Err(bad());
        }
        Ok(Self {
            complex,
            elem,
            big_endian,
        })
    }

    /// Bytes per sample (both components for complex types).
    pub const fn sample_size(self) -> usize {
        self.elem.size() * if self.complex { 2 } else { 1 }
    }

    /// Decode whole samples from `bytes` into `out` (cleared first). Trailing partial
    /// samples are ignored.
    pub fn decode_into(self, bytes: &[u8], out: &mut Vec<Complex32>) {
        out.clear();
        let n = bytes.len() / self.sample_size();
        out.reserve(n);
        let es = self.elem.size();
        if self.complex {
            for s in bytes.chunks_exact(es * 2).take(n) {
                out.push(Complex32::new(self.scalar(&s[..es]), self.scalar(&s[es..])));
            }
        } else {
            for s in bytes.chunks_exact(es).take(n) {
                out.push(Complex32::new(self.scalar(s), 0.0));
            }
        }
    }

    #[inline(always)]
    fn scalar(self, b: &[u8]) -> f32 {
        macro_rules! rd {
            ($t:ty, $n:literal) => {{
                let a: [u8; $n] = b.try_into().unwrap();
                if self.big_endian {
                    <$t>::from_be_bytes(a)
                } else {
                    <$t>::from_le_bytes(a)
                }
            }};
        }
        match self.elem {
            Elem::F64 => rd!(f64, 8) as f32,
            Elem::F32 => rd!(f32, 4),
            Elem::I32 => rd!(i32, 4) as f32 / 2_147_483_648.0,
            Elem::I16 => rd!(i16, 2) as f32 / 32_768.0,
            Elem::I8 => b[0] as i8 as f32 / 128.0,
            Elem::U32 => (rd!(u32, 4) as f64 - 2_147_483_647.5) as f32 / 2_147_483_648.0,
            Elem::U16 => (rd!(u16, 2) as f32 - 32_767.5) / 32_768.0,
            Elem::U8 => (b[0] as f32 - 127.5) / 128.0,
        }
    }
}

/// Guess a datatype from a raw file's extension, where a common convention exists.
pub fn guess_from_extension(ext: &str) -> Option<&'static str> {
    Some(match ext.to_ascii_lowercase().as_str() {
        "cu8" => "cu8",
        "cs8" => "ci8",
        "cs16" | "sc16" => "ci16_le",
        "cf32" | "cfile" | "fc32" => "cf32_le",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_types() {
        let d = Datatype::parse("cf32_le").unwrap();
        assert!(d.complex && d.elem == Elem::F32 && !d.big_endian);
        assert_eq!(d.sample_size(), 8);
        let d = Datatype::parse("ri16_be").unwrap();
        assert!(!d.complex && d.big_endian && d.sample_size() == 2);
        assert_eq!(Datatype::parse("cu8").unwrap().sample_size(), 2);
    }

    #[test]
    fn rejects_invalid_types() {
        for s in ["", "cf32", "cu8_le", "xf32_le", "cf16_le", "cf32_me"] {
            assert!(Datatype::parse(s).is_err(), "{s} should be rejected");
        }
    }

    #[test]
    fn decodes_with_endianness_and_scaling() {
        let mut out = Vec::new();
        let le: Vec<u8> = [16384i16, -32768]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        Datatype::parse("ci16_le")
            .unwrap()
            .decode_into(&le, &mut out);
        assert_eq!(out, vec![Complex32::new(0.5, -1.0)]);

        let be: Vec<u8> = [0.25f32, -0.75]
            .iter()
            .flat_map(|v| v.to_be_bytes())
            .collect();
        Datatype::parse("cf32_be")
            .unwrap()
            .decode_into(&be, &mut out);
        assert_eq!(out, vec![Complex32::new(0.25, -0.75)]);

        Datatype::parse("cu8")
            .unwrap()
            .decode_into(&[255, 0, 7], &mut out);
        assert_eq!(out.len(), 1, "partial trailing sample ignored");
        assert!((out[0].re - 0.99609).abs() < 1e-4 && (out[0].im + 0.99609).abs() < 1e-4);
    }
}
