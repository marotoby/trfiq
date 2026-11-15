use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use trfiq_storage::SourceConfig;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default = "default_listen")]
    pub listen: SocketAddr,
    /// Index, tile cache and other derived state. Never data.
    #[serde(default = "default_data_dir")]
    pub data_dir: PathBuf,
    #[serde(default = "default_scan_interval")]
    pub scan_interval_secs: u64,
    pub sources: Vec<SourceConfig>,
}

fn default_listen() -> SocketAddr {
    ([0, 0, 0, 0], 8080).into()
}
fn default_data_dir() -> PathBuf {
    "/var/lib/trfiq".into()
}
fn default_scan_interval() -> u64 {
    300
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("read config {}", path.display()))?;
        Self::parse(&raw, |k| std::env::var(k).ok())
    }

    fn parse(raw: &str, env: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let cfg: Config = serde_yaml::from_str(&substitute_env(raw, env)?)?;
        let mut seen = std::collections::HashSet::new();
        for s in &cfg.sources {
            if s.id.is_empty()
                || !s
                    .id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_".contains(c))
            {
                bail!("source id {:?} must be non-empty [A-Za-z0-9_-]", s.id);
            }
            if !seen.insert(&s.id) {
                bail!("duplicate source id {:?}", s.id);
            }
        }
        Ok(cfg)
    }
}

/// Replace `${VAR}` and `${VAR:-default}`. An unset variable without a default is an error,
/// so a missing secret fails loudly at startup instead of as an S3 auth error later.
fn substitute_env(raw: &str, env: impl Fn(&str) -> Option<String>) -> Result<String> {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let end = rest[start..]
            .find('}')
            .context("unterminated ${ in config")?
            + start;
        let expr = &rest[start + 2..end];
        let (name, default) = match expr.split_once(":-") {
            Some((n, d)) => (n, Some(d)),
            None => (expr, None),
        };
        match env(name).or(default.map(str::to_owned)) {
            Some(v) => out.push_str(&v),
            None => bail!("config references unset environment variable {name}"),
        }
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const YAML: &str = r#"
data_dir: /tmp/x
sources:
  - id: lab
    kind: s3
    endpoint: ${S3_ENDPOINT:-http://localhost:9000}
    bucket: recordings
    access_key_id: ${KEY}
  - id: disk
    kind: local
    path: /data
"#;

    #[test]
    fn parses_with_env() {
        let cfg = Config::parse(YAML, |k| (k == "KEY").then(|| "abc".into())).unwrap();
        assert_eq!(cfg.sources.len(), 2);
        assert_eq!(cfg.scan_interval_secs, 300);
        match &cfg.sources[0].kind {
            trfiq_storage::SourceKind::S3 {
                endpoint,
                access_key_id,
                ..
            } => {
                assert_eq!(endpoint.as_deref(), Some("http://localhost:9000"));
                assert_eq!(access_key_id.as_deref(), Some("abc"));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn missing_env_and_duplicates_fail() {
        assert!(Config::parse(YAML, |_| None).is_err());
        let dup = "sources: [{id: a, kind: local, path: /}, {id: a, kind: local, path: /}]";
        assert!(Config::parse(dup, |_| None).is_err());
    }
}
