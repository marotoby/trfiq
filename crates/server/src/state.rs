use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use serde::Serialize;
use tokio::sync::Notify;
use trfiq_index::{Index, ScanStats};
use trfiq_storage::Source;

use crate::config::Config;

pub struct AppState {
    /// In config order.
    pub sources: Vec<Arc<Source>>,
    pub index: Arc<Index>,
    status: Mutex<HashMap<String, ScanStatus>>,
    rescan: HashMap<String, Arc<Notify>>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ScanStatus {
    pub scanning: bool,
    /// Unix seconds.
    pub last_scan_unix: Option<u64>,
    pub last_error: Option<String>,
    pub last_stats: Option<ScanStats>,
    /// True once any scan of this source has succeeded.
    pub ready: bool,
}

impl AppState {
    pub fn new(cfg: &Config, index: Index) -> Result<Arc<Self>> {
        let sources: Vec<Arc<Source>> = cfg
            .sources
            .iter()
            .map(|c| Source::new(c).map(Arc::new))
            .collect::<Result<_>>()?;
        let rescan = sources
            .iter()
            .map(|s| (s.id.clone(), Arc::new(Notify::new())))
            .collect();
        Ok(Arc::new(Self {
            sources,
            index: Arc::new(index),
            status: Mutex::default(),
            rescan,
        }))
    }

    pub fn source(&self, id: &str) -> Option<&Arc<Source>> {
        self.sources.iter().find(|s| s.id == id)
    }

    pub fn status(&self, id: &str) -> ScanStatus {
        self.status
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn request_rescan(&self, id: &str) -> bool {
        self.rescan.get(id).map(|n| n.notify_one()).is_some()
    }

    /// One background loop per source: scan, then wait for the interval or a rescan request.
    pub fn spawn_scanners(self: &Arc<Self>, interval: Duration) {
        for src in &self.sources {
            let (state, src) = (self.clone(), src.clone());
            let notify = self.rescan[&src.id].clone();
            tokio::spawn(async move {
                loop {
                    state.update(&src.id, |s| s.scanning = true);
                    let result = trfiq_index::scan(&src, state.index.clone()).await;
                    state.update(&src.id, |s| {
                        s.scanning = false;
                        s.last_scan_unix = Some(unix_now());
                        match result {
                            Ok(stats) => {
                                tracing::info!(source = %src.id, ?stats, "scan done");
                                s.ready = true;
                                s.last_error = None;
                                s.last_stats = Some(stats);
                            }
                            Err(e) => {
                                tracing::error!(source = %src.id, error = format!("{e:#}"), "scan failed");
                                s.last_error = Some(format!("{e:#}"));
                            }
                        }
                    });
                    tokio::select! {
                        _ = tokio::time::sleep(interval) => {}
                        _ = notify.notified() => {}
                    }
                }
            });
        }
    }

    fn update(&self, id: &str, f: impl FnOnce(&mut ScanStatus)) {
        f(self
            .status
            .lock()
            .unwrap()
            .entry(id.to_owned())
            .or_default());
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}
