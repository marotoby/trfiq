//! Incremental scan: list a source, re-read only metadata whose ETag changed, upsert,
//! and delete rows for objects that vanished.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use futures::{StreamExt, stream};
use serde::Serialize;
use trfiq_dsp::{Datatype, datatype::guess_from_extension};
use trfiq_storage::{Meta, Source};

use crate::db::{Index, Status, Upsert};
use crate::sigmf;

/// Raw IQ extensions listed as "needs metadata".
const RAW_EXTENSIONS: &[&str] = &[
    "bin", "cfile", "iq", "raw", "dat", "cu8", "cs8", "cs16", "sc16", "cf32", "fc32",
];

#[derive(Debug, Clone, Serialize)]
pub struct ScanStats {
    pub objects: usize,
    pub recordings: usize,
    pub updated: usize,
    pub removed: usize,
    pub duration_ms: u64,
}

#[derive(Default)]
struct Group {
    meta: Option<Meta>,
    data: Option<Meta>,
    raw_ext: Option<String>,
}

fn etag(m: &Meta) -> String {
    m.e_tag
        .clone()
        .unwrap_or_else(|| format!("{}-{}", m.last_modified.timestamp_millis(), m.size))
}

pub async fn scan(src: &Source, idx: Arc<Index>) -> Result<ScanStats> {
    let started = Instant::now();
    let objects = src.list().await?;

    let mut groups: BTreeMap<String, Group> = BTreeMap::new();
    for o in &objects {
        let key = o.location.as_ref();
        if let Some(stem) = key.strip_suffix(".sigmf-meta") {
            groups.entry(stem.to_owned()).or_default().meta = Some(o.clone());
        } else if let Some(stem) = key.strip_suffix(".sigmf-data") {
            groups.entry(stem.to_owned()).or_default().data = Some(o.clone());
        } else if let Some((_, ext)) = key.rsplit_once('.')
            && RAW_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
        {
            let g = groups.entry(key.to_owned()).or_default();
            g.data = Some(o.clone());
            g.raw_ext = Some(ext.to_owned());
        }
    }

    let existing = {
        let (idx, id) = (idx.clone(), src.id.clone());
        tokio::task::spawn_blocking(move || idx.etags(&id)).await??
    };

    let live: HashSet<String> = groups.keys().cloned().collect();
    let removed: Vec<String> = existing
        .keys()
        .filter(|s| !live.contains(*s))
        .cloned()
        .collect();
    let changed: Vec<(String, Group)> = groups
        .into_iter()
        .filter(|(stem, g)| {
            let now = (g.meta.as_ref().map(etag), g.data.as_ref().map(etag));
            existing.get(stem) != Some(&now)
        })
        .collect();

    // Owned items keep the future `Send` without higher-ranked lifetime trouble.
    let upserts: Vec<Upsert> = stream::iter(changed)
        .map(|(stem, g)| async move { build(src, &stem, &g).await })
        .buffer_unordered(16)
        .collect()
        .await;

    let stats = ScanStats {
        objects: objects.len(),
        recordings: live.len(),
        updated: upserts.len(),
        removed: removed.len(),
        duration_ms: 0,
    };
    let id = src.id.clone();
    tokio::task::spawn_blocking(move || idx.apply(&id, &upserts, &removed)).await??;
    Ok(ScanStats {
        duration_ms: started.elapsed().as_millis() as u64,
        ..stats
    })
}

async fn build(src: &Source, stem: &str, g: &Group) -> Upsert {
    let mut u = Upsert {
        stem: stem.to_owned(),
        name: stem.rsplit('/').next().unwrap_or(stem).to_owned(),
        data_key: g.data.as_ref().map(|m| m.location.to_string()),
        meta_key: g.meta.as_ref().map(|m| m.location.to_string()),
        data_etag: g.data.as_ref().map(etag),
        meta_etag: g.meta.as_ref().map(etag),
        size: g.data.as_ref().map(|m| m.size),
        last_modified: g
            .data
            .as_ref()
            .or(g.meta.as_ref())
            .map(|m| m.last_modified.to_rfc3339()),
        ..Default::default()
    };

    if let Some(ext) = &g.raw_ext {
        u.status = Some(Status::NeedsMeta);
        u.fields.datatype = guess_from_extension(ext).map(str::to_owned);
        return u;
    }

    if let Some(meta) = &g.meta {
        let key = meta.location.to_string();
        match src.get(&key).await.and_then(|b| sigmf::parse(&b)) {
            Ok((fields, json)) => {
                u.meta_json = Some(json.to_string());
                if let Some(dt) = &fields.datatype
                    && let Err(e) = Datatype::parse(dt)
                {
                    u.error = Some(e.to_string());
                }
                u.fields = fields;
            }
            Err(e) => {
                tracing::warn!(source = %src.id, key, error = %e, "bad sigmf-meta");
                u.error = Some(format!("{e:#}"));
            }
        }
    }

    u.error = u.error.or_else(|| match (&g.meta, &g.data) {
        (None, _) => Some("missing .sigmf-meta".into()),
        (_, None) => Some("missing .sigmf-data".into()),
        _ => None,
    });
    u.status = Some(if u.error.is_some() {
        Status::Broken
    } else {
        Status::Ok
    });
    u
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ListQuery;
    use trfiq_storage::SourceConfig;

    const META: &str = r#"{"global": {"core:datatype": "cf32_le", "core:sample_rate": 1e6},
        "captures": [{"core:frequency": 1e8}], "annotations": [{"core:label": "FM"}]}"#;

    fn setup() -> (tempfile::TempDir, Source) {
        let dir = tempfile::tempdir().unwrap();
        let w = |p: &str, b: &[u8]| {
            let p = dir.path().join(p);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b).unwrap();
        };
        w("good.sigmf-meta", META.as_bytes());
        w("good.sigmf-data", &[0u8; 800]);
        w("nested/orphan.sigmf-data", &[0u8; 8]);
        w("bad.sigmf-meta", b"{oops");
        w("bad.sigmf-data", &[0u8; 8]);
        w("rtl.cu8", &[0u8; 100]);
        w("readme.txt", b"ignored");
        let cfg = SourceConfig {
            id: "t".into(),
            name: None,
            prefix: String::new(),
            max_concurrency: 4,
            kind: trfiq_storage::SourceKind::Local {
                path: dir.path().to_owned(),
            },
        };
        let src = Source::new(&cfg).unwrap();
        (dir, src)
    }

    #[tokio::test]
    async fn scan_classifies_and_is_incremental() {
        let (dir, src) = setup();
        let idx = Arc::new(Index::open_in_memory().unwrap());

        let s = scan(&src, idx.clone()).await.unwrap();
        assert_eq!((s.recordings, s.updated, s.removed), (4, 4, 0));

        let all = idx.list(&ListQuery::default()).unwrap();
        let by = |n: &str| all.iter().find(|r| r.name == n).unwrap().clone();
        let good = by("good");
        assert_eq!(good.status, Status::Ok);
        assert_eq!(good.num_samples, Some(100));
        assert_eq!(good.labels, vec!["FM"]);
        assert_eq!(by("orphan").status, Status::Broken);
        assert_eq!(by("bad").status, Status::Broken);
        let rtl = by("rtl.cu8");
        assert_eq!(
            (rtl.status, rtl.datatype.as_deref()),
            (Status::NeedsMeta, Some("cu8"))
        );

        // Nothing changed: nothing re-read.
        let s = scan(&src, idx.clone()).await.unwrap();
        assert_eq!((s.updated, s.removed), (0, 0));

        std::fs::remove_file(dir.path().join("rtl.cu8")).unwrap();
        let s = scan(&src, idx.clone()).await.unwrap();
        assert_eq!((s.recordings, s.updated, s.removed), (3, 0, 1));
    }
}
