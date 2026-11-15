use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};
use trfiq_dsp::Datatype;

use crate::sigmf::Fields;

const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = r#"
CREATE TABLE recordings (
    id               INTEGER PRIMARY KEY,
    source           TEXT NOT NULL,
    stem             TEXT NOT NULL,
    name             TEXT NOT NULL,
    data_key         TEXT,
    meta_key         TEXT,
    data_etag        TEXT,
    meta_etag        TEXT,
    size             INTEGER,
    last_modified    TEXT,
    status           TEXT NOT NULL,
    error            TEXT,
    datatype         TEXT,
    sample_rate      REAL,
    center_freq      REAL,
    datetime         TEXT,
    description      TEXT,
    author           TEXT,
    hw               TEXT,
    labels           TEXT NOT NULL DEFAULT '',
    annotation_count INTEGER NOT NULL DEFAULT 0,
    meta_json        TEXT,
    indexed_at       TEXT NOT NULL,
    UNIQUE (source, stem)
);
CREATE INDEX recordings_center_freq ON recordings (center_freq);
CREATE INDEX recordings_datetime ON recordings (datetime);

-- Metadata entered in the UI for raw files. Never written to the bucket (ADR 0005).
CREATE TABLE user_meta (
    source      TEXT NOT NULL,
    data_key    TEXT NOT NULL,
    datatype    TEXT,
    sample_rate REAL,
    center_freq REAL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (source, data_key)
);

CREATE VIRTUAL TABLE recordings_fts USING fts5 (
    stem, description, author, hw, labels,
    content = 'recordings', content_rowid = 'id'
);
CREATE TRIGGER recordings_ai AFTER INSERT ON recordings BEGIN
    INSERT INTO recordings_fts (rowid, stem, description, author, hw, labels)
    VALUES (new.id, new.stem, new.description, new.author, new.hw, new.labels);
END;
CREATE TRIGGER recordings_ad AFTER DELETE ON recordings BEGIN
    INSERT INTO recordings_fts (recordings_fts, rowid, stem, description, author, hw, labels)
    VALUES ('delete', old.id, old.stem, old.description, old.author, old.hw, old.labels);
END;
CREATE TRIGGER recordings_au AFTER UPDATE ON recordings BEGIN
    INSERT INTO recordings_fts (recordings_fts, rowid, stem, description, author, hw, labels)
    VALUES ('delete', old.id, old.stem, old.description, old.author, old.hw, old.labels);
    INSERT INTO recordings_fts (rowid, stem, description, author, hw, labels)
    VALUES (new.id, new.stem, new.description, new.author, new.hw, new.labels);
END;

-- Effective view: user metadata overrides what was found in the bucket.
CREATE VIEW recordings_v AS
SELECT r.id, r.source, r.stem, r.name, r.data_key, r.meta_key, r.size, r.last_modified,
       CASE WHEN r.status = 'needs_meta' AND u.datatype IS NOT NULL AND u.sample_rate IS NOT NULL
            THEN 'ok' ELSE r.status END AS status,
       r.error,
       COALESCE(u.datatype, r.datatype) AS datatype,
       COALESCE(u.sample_rate, r.sample_rate) AS sample_rate,
       COALESCE(u.center_freq, r.center_freq) AS center_freq,
       r.datetime, r.description, r.author, r.hw, r.labels, r.annotation_count,
       u.source IS NOT NULL AS user_meta
FROM recordings r
LEFT JOIN user_meta u ON u.source = r.source AND u.data_key = r.data_key;
"#;

const COLUMNS: &str = "id, source, stem, name, data_key, meta_key, size, last_modified, status, \
     error, datatype, sample_rate, center_freq, datetime, description, author, hw, labels, \
     annotation_count, user_meta";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Viewable.
    Ok,
    /// Raw file that needs datatype + sample rate from the user.
    NeedsMeta,
    /// Missing half of a SigMF pair, or unparseable metadata.
    Broken,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Status::Ok => "ok",
            Status::NeedsMeta => "needs_meta",
            Status::Broken => "broken",
        }
    }
    fn parse(s: &str) -> Self {
        match s {
            "ok" => Status::Ok,
            "needs_meta" => Status::NeedsMeta,
            _ => Status::Broken,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Recording {
    pub id: i64,
    pub source: String,
    pub stem: String,
    pub name: String,
    pub data_key: Option<String>,
    pub meta_key: Option<String>,
    pub size: Option<u64>,
    pub last_modified: Option<String>,
    pub status: Status,
    pub error: Option<String>,
    pub datatype: Option<String>,
    pub sample_rate: Option<f64>,
    pub center_freq: Option<f64>,
    pub datetime: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    pub hw: Option<String>,
    pub labels: Vec<String>,
    pub annotation_count: u64,
    pub user_meta: bool,
    /// Derived from size and datatype.
    pub num_samples: Option<u64>,
    /// Whether its samples can be read and drawn. The one place this is decided: the server's
    /// sample endpoints and the UI (viewer, previews, gallery) all go by it.
    pub viewable: bool,
    /// Why it can't be drawn, when `viewable` is false.
    pub not_viewable_reason: Option<String>,
}

/// Can a recording's samples be read and drawn? `Err` says why not, in words for the UI.
pub fn viewability(
    status: Status,
    error: Option<&str>,
    data_key: Option<&str>,
    datatype: Option<&str>,
    num_samples: Option<u64>,
) -> Result<(), String> {
    if status == Status::Broken {
        return Err(error.unwrap_or("recording is broken").to_owned());
    }
    if data_key.is_none() {
        return Err("no data file".into());
    }
    let Some(dt) = datatype else {
        return Err("needs a datatype before it can be shown".into());
    };
    Datatype::parse(dt).map_err(|e| e.to_string())?;
    match num_samples {
        Some(n) if n > 0 => Ok(()),
        _ => Err("empty recording".into()),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingDetail {
    #[serde(flatten)]
    pub recording: Recording,
    /// The full `.sigmf-meta` document, if any.
    pub meta: Option<serde_json::Value>,
}

#[derive(Debug, Default, Clone, Deserialize)]
pub struct ListQuery {
    /// Full-text search over path, description, author, hw and annotation labels.
    pub q: Option<String>,
    pub source: Option<String>,
    pub status: Option<Status>,
    pub datatype: Option<String>,
    /// Frequency range in Hz; matches recordings whose band overlaps it.
    pub fmin: Option<f64>,
    pub fmax: Option<f64>,
    /// ISO-8601 bounds on the first capture's datetime.
    pub from: Option<String>,
    pub to: Option<String>,
    pub limit: Option<u32>,
}

/// What the scanner writes for one recording.
#[derive(Debug, Clone, Default)]
pub struct Upsert {
    pub stem: String,
    pub name: String,
    pub data_key: Option<String>,
    pub meta_key: Option<String>,
    pub data_etag: Option<String>,
    pub meta_etag: Option<String>,
    pub size: Option<u64>,
    pub last_modified: Option<String>,
    pub status: Option<Status>,
    pub error: Option<String>,
    pub fields: Fields,
    pub meta_json: Option<String>,
}

/// ETags of what was indexed for one stem, for change detection.
pub type Etags = (Option<String>, Option<String>);

pub struct Index {
    conn: Mutex<Connection>,
}

impl Index {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).with_context(|| format!("open {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let v: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        match v {
            0 => {
                conn.execute_batch(&format!(
                    "BEGIN; {SCHEMA} PRAGMA user_version = {SCHEMA_VERSION}; COMMIT;"
                ))?;
            }
            SCHEMA_VERSION => {}
            v => bail!("index schema version {v} is newer than this build ({SCHEMA_VERSION})"),
        }
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        // A panic while holding the lock leaves SQLite itself consistent; keep serving.
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn etags(&self, source: &str) -> Result<HashMap<String, Etags>> {
        let conn = self.conn();
        let mut st = conn
            .prepare_cached("SELECT stem, meta_etag, data_etag FROM recordings WHERE source = ?")?;
        let rows = st.query_map([source], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Apply one scan's changes for a source atomically.
    pub fn apply(&self, source: &str, upserts: &[Upsert], removed: &[String]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        {
            let now = now_rfc3339();
            let mut up = tx.prepare_cached(
                "INSERT INTO recordings (source, stem, name, data_key, meta_key, data_etag, meta_etag,
                    size, last_modified, status, error, datatype, sample_rate, center_freq, datetime,
                    description, author, hw, labels, annotation_count, meta_json, indexed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                    ?17, ?18, ?19, ?20, ?21, ?22)
                 ON CONFLICT (source, stem) DO UPDATE SET
                    name = excluded.name, data_key = excluded.data_key, meta_key = excluded.meta_key,
                    data_etag = excluded.data_etag, meta_etag = excluded.meta_etag,
                    size = excluded.size, last_modified = excluded.last_modified,
                    status = excluded.status, error = excluded.error, datatype = excluded.datatype,
                    sample_rate = excluded.sample_rate, center_freq = excluded.center_freq,
                    datetime = excluded.datetime, description = excluded.description,
                    author = excluded.author, hw = excluded.hw, labels = excluded.labels,
                    annotation_count = excluded.annotation_count, meta_json = excluded.meta_json,
                    indexed_at = excluded.indexed_at",
            )?;
            for u in upserts {
                let f = &u.fields;
                up.execute(params![
                    source,
                    u.stem,
                    u.name,
                    u.data_key,
                    u.meta_key,
                    u.data_etag,
                    u.meta_etag,
                    u.size.map(|s| s as i64),
                    u.last_modified,
                    u.status.unwrap_or(Status::Broken).as_str(),
                    u.error,
                    f.datatype,
                    f.sample_rate,
                    f.center_freq,
                    f.datetime,
                    f.description,
                    f.author,
                    f.hw,
                    f.labels.join("\n"),
                    f.annotation_count as i64,
                    u.meta_json,
                    now,
                ])?;
            }
            let mut del =
                tx.prepare_cached("DELETE FROM recordings WHERE source = ? AND stem = ?")?;
            for stem in removed {
                del.execute(params![source, stem])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list(&self, q: &ListQuery) -> Result<Vec<Recording>> {
        let mut sql = format!("SELECT {COLUMNS} FROM recordings_v WHERE 1 = 1");
        let mut args: Vec<Value> = Vec::new();
        let mut arg = |sql: &mut String, clause: &str, v: Value| {
            sql.push_str(clause);
            args.push(v);
        };
        if let Some(fts) = q.q.as_deref().and_then(fts_query) {
            arg(
                &mut sql,
                " AND id IN (SELECT rowid FROM recordings_fts WHERE recordings_fts MATCH ?)",
                fts.into(),
            );
        }
        if let Some(s) = &q.source {
            arg(&mut sql, " AND source = ?", s.clone().into());
        }
        if let Some(s) = q.status {
            arg(&mut sql, " AND status = ?", s.as_str().to_string().into());
        }
        if let Some(d) = &q.datatype {
            arg(&mut sql, " AND datatype = ?", d.clone().into());
        }
        if let Some(f) = q.fmin {
            arg(
                &mut sql,
                " AND center_freq + COALESCE(sample_rate, 0) / 2 >= ?",
                f.into(),
            );
        }
        if let Some(f) = q.fmax {
            arg(
                &mut sql,
                " AND center_freq - COALESCE(sample_rate, 0) / 2 <= ?",
                f.into(),
            );
        }
        if let Some(d) = &q.from {
            arg(&mut sql, " AND datetime >= ?", d.clone().into());
        }
        if let Some(d) = &q.to {
            arg(&mut sql, " AND datetime <= ?", d.clone().into());
        }
        sql.push_str(" ORDER BY source, stem LIMIT ?");
        args.push(i64::from(q.limit.unwrap_or(100_000)).into());

        let conn = self.conn();
        let mut st = conn.prepare_cached(&sql)?;
        let rows = st.query_map(params_from_iter(args), row_to_recording)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn get(&self, id: i64) -> Result<Option<RecordingDetail>> {
        let conn = self.conn();
        let rec = conn
            .prepare_cached(&format!("SELECT {COLUMNS} FROM recordings_v WHERE id = ?"))?
            .query_row([id], row_to_recording)
            .optional()?;
        let Some(recording) = rec else {
            return Ok(None);
        };
        let meta: Option<String> = conn
            .prepare_cached("SELECT meta_json FROM recordings WHERE id = ?")?
            .query_row([id], |r| r.get(0))?;
        let meta = meta.map(|m| serde_json::from_str(&m)).transpose()?;
        Ok(Some(RecordingDetail { recording, meta }))
    }

    /// Recording counts per source and status.
    pub fn counts(&self) -> Result<HashMap<String, HashMap<String, u64>>> {
        let conn = self.conn();
        let mut st =
            conn.prepare_cached("SELECT source, status, COUNT(*) FROM recordings_v GROUP BY 1, 2")?;
        let mut out: HashMap<String, HashMap<String, u64>> = HashMap::new();
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get(1)?, r.get(2)?)))?;
        for row in rows {
            let (src, status, n) = row?;
            out.entry(src).or_default().insert(status, n);
        }
        Ok(out)
    }
}

fn row_to_recording(r: &Row) -> rusqlite::Result<Recording> {
    let size: Option<i64> = r.get("size")?;
    let datatype: Option<String> = r.get("datatype")?;
    let labels: String = r.get("labels")?;
    let size = size.map(|s| s as u64);
    let num_samples = match (size, datatype.as_deref().map(Datatype::parse)) {
        (Some(s), Some(Ok(d))) => Some(s / d.sample_size() as u64),
        _ => None,
    };
    let status = Status::parse(&r.get::<_, String>("status")?);
    let error: Option<String> = r.get("error")?;
    let data_key: Option<String> = r.get("data_key")?;
    let not_viewable_reason = viewability(
        status,
        error.as_deref(),
        data_key.as_deref(),
        datatype.as_deref(),
        num_samples,
    )
    .err();
    Ok(Recording {
        id: r.get("id")?,
        source: r.get("source")?,
        stem: r.get("stem")?,
        name: r.get("name")?,
        data_key,
        meta_key: r.get("meta_key")?,
        size,
        last_modified: r.get("last_modified")?,
        status,
        error,
        datatype,
        sample_rate: r.get("sample_rate")?,
        center_freq: r.get("center_freq")?,
        datetime: r.get("datetime")?,
        description: r.get("description")?,
        author: r.get("author")?,
        hw: r.get("hw")?,
        labels: labels
            .split('\n')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect(),
        annotation_count: r.get::<_, i64>("annotation_count")? as u64,
        user_meta: r.get("user_meta")?,
        num_samples,
        viewable: not_viewable_reason.is_none(),
        not_viewable_reason,
    })
}

/// Turn free text into an FTS5 query: every word must match as a prefix.
fn fts_query(q: &str) -> Option<String> {
    let terms: Vec<String> = q
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{w}\"*"))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

pub(crate) fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(stem: &str, cf: f64, sr: f64, labels: &[&str]) -> Upsert {
        Upsert {
            stem: stem.into(),
            name: stem.rsplit('/').next().unwrap().into(),
            data_key: Some(format!("{stem}.sigmf-data")),
            meta_key: Some(format!("{stem}.sigmf-meta")),
            data_etag: Some("d".into()),
            meta_etag: Some("m".into()),
            size: Some(8000),
            status: Some(Status::Ok),
            fields: Fields {
                datatype: Some("cf32_le".into()),
                sample_rate: Some(sr),
                center_freq: Some(cf),
                labels: labels.iter().map(|s| s.to_string()).collect(),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    #[test]
    fn viewability_has_one_answer_and_a_reason() {
        let ok = |s, e, k, d, n| viewability(s, e, k, d, n);
        let key = Some("x.sigmf-data");
        assert_eq!(ok(Status::Ok, None, key, Some("ci16_le"), Some(10)), Ok(()));
        // Raw files with a guessed datatype are viewable too.
        assert_eq!(ok(Status::NeedsMeta, None, key, Some("cu8"), Some(10)), Ok(()));
        assert_eq!(
            ok(Status::Broken, Some("no .sigmf-meta"), key, Some("cu8"), Some(10)),
            Err("no .sigmf-meta".into())
        );
        assert!(ok(Status::Ok, None, None, Some("cu8"), Some(10)).is_err());
        assert!(ok(Status::NeedsMeta, None, key, None, None).is_err());
        assert!(ok(Status::Ok, None, key, Some("ci13_le"), Some(10)).is_err());
        assert!(ok(Status::Ok, None, key, Some("cu8"), Some(0)).is_err());
    }

    #[test]
    fn upsert_search_filter_delete() {
        let idx = Index::open_in_memory().unwrap();
        idx.apply(
            "s",
            &[
                rec("lte/band7_capture", 2.6e9, 20e6, &["LTE"]),
                rec("ism/lora", 915e6, 1e6, &["LoRa"]),
            ],
            &[],
        )
        .unwrap();

        let all = idx.list(&ListQuery::default()).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].num_samples, Some(1000));
        assert!(all[0].viewable && all[0].not_viewable_reason.is_none());

        let q = |q: ListQuery| {
            idx.list(&q)
                .unwrap()
                .into_iter()
                .map(|r| r.name)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            q(ListQuery {
                q: Some("band".into()),
                ..Default::default()
            }),
            ["band7_capture"]
        );
        assert_eq!(
            q(ListQuery {
                q: Some("lor".into()),
                ..Default::default()
            }),
            ["lora"]
        );
        assert_eq!(
            q(ListQuery {
                fmin: Some(914.6e6),
                fmax: Some(914.7e6),
                ..Default::default()
            }),
            ["lora"],
            "band overlap counts"
        );

        // Update changes FTS content too.
        idx.apply("s", &[rec("ism/lora", 915e6, 1e6, &["FSK"])], &[])
            .unwrap();
        assert!(
            q(ListQuery {
                q: Some("lora".into()),
                ..Default::default()
            })
            .contains(&"lora".into())
        );
        assert!(
            q(ListQuery {
                q: Some("LoRa FSK".into()),
                ..Default::default()
            })
            .len()
                == 1
        );

        idx.apply("s", &[], &["ism/lora".into()]).unwrap();
        assert_eq!(idx.list(&ListQuery::default()).unwrap().len(), 1);
        assert_eq!(idx.etags("s").unwrap().len(), 1);
    }

    #[test]
    fn reopening_keeps_data() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("i.sqlite");
        Index::open(&p)
            .unwrap()
            .apply("s", &[rec("a", 1e6, 1e6, &[])], &[])
            .unwrap();
        assert_eq!(
            Index::open(&p)
                .unwrap()
                .list(&ListQuery::default())
                .unwrap()
                .len(),
            1
        );
    }
}
