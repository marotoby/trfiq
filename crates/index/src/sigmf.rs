//! The subset of SigMF metadata the index stores.

use anyhow::{Context, Result};
use serde_json::Value;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Fields {
    pub datatype: Option<String>,
    pub sample_rate: Option<f64>,
    pub center_freq: Option<f64>,
    pub datetime: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    pub hw: Option<String>,
    /// Unique annotation labels, sorted.
    pub labels: Vec<String>,
    pub annotation_count: usize,
}

pub fn parse(bytes: &[u8]) -> Result<(Fields, Value)> {
    let v: Value = serde_json::from_slice(bytes).context("invalid JSON")?;
    let global = v.get("global").context("missing `global`")?;
    let s = |o: &Value, k: &str| o.get(k).and_then(Value::as_str).map(str::to_owned);
    let f = |o: &Value, k: &str| o.get(k).and_then(Value::as_f64);
    let capture0 = v
        .get("captures")
        .and_then(|c| c.get(0))
        .unwrap_or(&Value::Null);
    let annotations = v.get("annotations").and_then(Value::as_array);
    let mut labels: Vec<String> = annotations
        .into_iter()
        .flatten()
        .filter_map(|a| s(a, "core:label"))
        .filter(|l| !l.is_empty())
        .collect();
    labels.sort();
    labels.dedup();
    let fields = Fields {
        datatype: Some(s(global, "core:datatype").context("missing `core:datatype`")?),
        sample_rate: f(global, "core:sample_rate"),
        center_freq: f(capture0, "core:frequency"),
        datetime: s(capture0, "core:datetime"),
        description: s(global, "core:description"),
        author: s(global, "core:author"),
        hw: s(global, "core:hw"),
        labels,
        annotation_count: annotations.map_or(0, Vec::len),
    };
    Ok((fields, v))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_core_fields() {
        let meta = br#"{
          "global": {"core:datatype": "ci16_le", "core:sample_rate": 2e6, "core:hw": "b210"},
          "captures": [{"core:sample_start": 0, "core:frequency": 915e6,
                        "core:datetime": "2026-01-02T03:04:05Z"}],
          "annotations": [{"core:label": "LoRa"}, {"core:label": "FSK"}, {"core:label": "LoRa"}, {}]
        }"#;
        let (f, _) = parse(meta).unwrap();
        assert_eq!(f.datatype.as_deref(), Some("ci16_le"));
        assert_eq!(f.sample_rate, Some(2e6));
        assert_eq!(f.center_freq, Some(915e6));
        assert_eq!(f.labels, vec!["FSK", "LoRa"]);
        assert_eq!(f.annotation_count, 4);
    }

    #[test]
    fn rejects_missing_datatype() {
        assert!(parse(br#"{"global": {}}"#).is_err());
        assert!(parse(b"not json").is_err());
    }
}
