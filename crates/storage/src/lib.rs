//! Named data sources (S3/MinIO buckets and local folders) behind one `ObjectStore` API.
//!
//! Sources are read-only by construction: this module exposes list / head / get / range
//! reads and nothing else (ADR 0005). Every request takes a permit from a per-source
//! semaphore so a burst of tile requests can't flood the S3 server.

use std::ops::Range;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use bytes::Bytes;
use futures::{StreamExt, TryStreamExt, stream};
use object_store::aws::AmazonS3Builder;
use object_store::local::LocalFileSystem;
use object_store::path::Path;
use object_store::{ObjectMeta, ObjectStore};
use serde::Deserialize;
use tokio::sync::Semaphore;

pub use object_store::ObjectMeta as Meta;

// No `deny_unknown_fields`: serde does not support it together with `flatten`.
#[derive(Debug, Clone, Deserialize)]
pub struct SourceConfig {
    /// Stable identifier used in URLs and the index. Changing it orphans index rows.
    pub id: String,
    /// Display name; defaults to `id`.
    pub name: Option<String>,
    /// Only objects under this prefix are indexed.
    #[serde(default)]
    pub prefix: String,
    /// Maximum concurrent requests to this source.
    #[serde(default = "default_concurrency")]
    pub max_concurrency: usize,
    #[serde(flatten)]
    pub kind: SourceKind,
}

fn default_concurrency() -> usize {
    32
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SourceKind {
    S3 {
        bucket: String,
        /// e.g. `http://minio:9000`. Omit for AWS.
        endpoint: Option<String>,
        region: Option<String>,
        access_key_id: Option<String>,
        secret_access_key: Option<String>,
        /// Use virtual-hosted-style URLs (`bucket.host`). MinIO wants path style (false).
        #[serde(default)]
        virtual_hosted: bool,
    },
    Local {
        path: PathBuf,
    },
}

pub struct Source {
    pub id: String,
    pub name: String,
    pub kind: &'static str,
    store: Arc<dyn ObjectStore>,
    prefix: Option<Path>,
    permits: Semaphore,
}

impl Source {
    pub fn new(cfg: &SourceConfig) -> Result<Self> {
        let (kind, store): (_, Arc<dyn ObjectStore>) = match &cfg.kind {
            SourceKind::S3 {
                bucket,
                endpoint,
                region,
                access_key_id,
                secret_access_key,
                virtual_hosted,
            } => {
                // Start from AWS_* env vars, then apply explicit config on top.
                let mut b = AmazonS3Builder::from_env()
                    .with_bucket_name(bucket)
                    .with_region(region.as_deref().unwrap_or("us-east-1"))
                    .with_virtual_hosted_style_request(*virtual_hosted);
                if let Some(e) = endpoint {
                    b = b.with_endpoint(e).with_allow_http(e.starts_with("http://"));
                }
                if let Some(k) = access_key_id {
                    b = b.with_access_key_id(k);
                }
                if let Some(s) = secret_access_key {
                    b = b.with_secret_access_key(s);
                }
                (
                    "s3",
                    Arc::new(b.build().with_context(|| format!("source {}", cfg.id))?),
                )
            }
            SourceKind::Local { path } => (
                "local",
                Arc::new(
                    LocalFileSystem::new_with_prefix(path)
                        .with_context(|| format!("source {}: {}", cfg.id, path.display()))?,
                ),
            ),
        };
        let prefix = cfg.prefix.trim_matches('/');
        Ok(Self {
            id: cfg.id.clone(),
            name: cfg.name.clone().unwrap_or_else(|| cfg.id.clone()),
            kind,
            store,
            prefix: (!prefix.is_empty()).then(|| Path::from(prefix)),
            permits: Semaphore::new(cfg.max_concurrency.max(1)),
        })
    }

    /// List every object under the source prefix.
    pub async fn list(&self) -> Result<Vec<ObjectMeta>> {
        let _p = self.permits.acquire().await?;
        Ok(self.store.list(self.prefix.as_ref()).try_collect().await?)
    }

    pub async fn head(&self, key: &str) -> Result<ObjectMeta> {
        let _p = self.permits.acquire().await?;
        Ok(self.store.head(&parse(key)?).await?)
    }

    pub async fn get(&self, key: &str) -> Result<Bytes> {
        let _p = self.permits.acquire().await?;
        Ok(self.store.get(&parse(key)?).await?.bytes().await?)
    }

    /// Read many byte ranges, preserving order. Ranges are sent in batches (each batch is
    /// coalesced by `object_store`) with several batches in flight at once.
    pub async fn get_ranges(&self, key: &str, ranges: &[Range<u64>]) -> Result<Vec<Bytes>> {
        const BATCH: usize = 64;
        let path = parse(key)?;
        // Owned batches keep the future `Send` without higher-ranked lifetime trouble.
        let batches: Vec<Vec<Bytes>> = stream::iter(ranges.chunks(BATCH).map(<[_]>::to_vec))
            .map(|batch| {
                let path = &path;
                async move {
                    let _p = self.permits.acquire().await?;
                    Ok::<_, anyhow::Error>(self.store.get_ranges(path, &batch).await?)
                }
            })
            .buffered(8)
            .try_collect()
            .await?;
        Ok(batches.into_iter().flatten().collect())
    }
}

fn parse(key: &str) -> Result<Path> {
    Path::parse(key).with_context(|| format!("invalid object key {key:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_source_lists_and_reads_ranges() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("sub")).unwrap();
        std::fs::write(
            dir.path().join("sub/a.bin"),
            (0u8..=255).collect::<Vec<_>>(),
        )
        .unwrap();
        std::fs::write(dir.path().join("other.bin"), b"x").unwrap();

        let cfg: SourceConfig = serde_json::from_value(serde_json::json!({
            "id": "t", "kind": "local", "path": dir.path(), "prefix": "/sub/"
        }))
        .unwrap();
        let src = Source::new(&cfg).unwrap();

        let list = src.list().await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].location.as_ref(), "sub/a.bin");
        assert!(list[0].e_tag.is_some());

        let parts = src
            .get_ranges("sub/a.bin", &[10..12, 250..256, 0..1])
            .await
            .unwrap();
        assert_eq!(
            parts,
            vec![
                Bytes::from(vec![10, 11]),
                (250u8..=255).collect(),
                vec![0].into()
            ]
        );
    }
}
