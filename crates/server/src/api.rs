use std::ops::Range;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use tower_http::compression::CompressionLayer;
use tower_http::trace::TraceLayer;
use trfiq_dsp::{Datatype, Spectrogram, Window, quant, strided_offsets};
use trfiq_index::{ListQuery, Recording, RecordingDetail, Status};

use crate::state::AppState;
use crate::web;

/// Upper bound on overview rows per request (rows × fft × 2 bytes must stay sane).
const MAX_ROWS: usize = 4096;
const MAX_CELLS: usize = 16 << 20;

type St = State<Arc<AppState>>;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/sources", get(sources))
        .route("/api/sources/{id}/rescan", post(rescan))
        .route("/api/recordings", get(list))
        .route("/api/recordings/{id}", get(detail))
        .route("/api/recordings/{id}/overview", get(overview))
        .route("/healthz", get(|| async { "ok" }))
        .route("/readyz", get(readyz))
        .fallback(web::serve)
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

// ---- errors -------------------------------------------------------------------------------

#[derive(Debug)]
pub struct ApiError(StatusCode, String);

impl ApiError {
    fn new(code: StatusCode, msg: impl ToString) -> Self {
        Self(code, msg.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!(error = format!("{e:#}"), "request failed");
        Self(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}"))
    }
}

type ApiResult<T> = Result<T, ApiError>;

/// Run a blocking index call off the async runtime.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> ApiResult<T> {
    Ok(tokio::task::spawn_blocking(f)
        .await
        .map_err(anyhow::Error::from)??)
}

// ---- sources ------------------------------------------------------------------------------

async fn sources(State(st): St) -> ApiResult<impl IntoResponse> {
    let counts = blocking({
        let idx = st.index.clone();
        move || idx.counts()
    })
    .await?;
    let out: Vec<_> = st
        .sources
        .iter()
        .map(|s| {
            json!({
                "id": s.id,
                "name": s.name,
                "kind": s.kind,
                "scan": st.status(&s.id),
                "counts": counts.get(&s.id).cloned().unwrap_or_default(),
            })
        })
        .collect();
    Ok(Json(out))
}

async fn rescan(State(st): St, Path(id): Path<String>) -> ApiResult<StatusCode> {
    if st.request_rescan(&id) {
        Ok(StatusCode::ACCEPTED)
    } else {
        Err(ApiError::new(
            StatusCode::NOT_FOUND,
            format!("no source {id}"),
        ))
    }
}

async fn readyz(State(st): St) -> Response {
    let per: serde_json::Map<_, _> = st
        .sources
        .iter()
        .map(|s| (s.id.clone(), json!(st.status(&s.id))))
        .collect();
    let ready = st.sources.iter().all(|s| st.status(&s.id).ready);
    let code = if ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (code, Json(json!({ "ready": ready, "sources": per }))).into_response()
}

// ---- recordings ---------------------------------------------------------------------------

async fn list(State(st): St, Query(q): Query<ListQuery>) -> ApiResult<Json<Vec<Recording>>> {
    let idx = st.index.clone();
    Ok(Json(blocking(move || idx.list(&q)).await?))
}

async fn get_recording(st: &AppState, id: i64) -> ApiResult<RecordingDetail> {
    let idx = st.index.clone();
    blocking(move || idx.get(id))
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, format!("no recording {id}")))
}

async fn detail(State(st): St, Path(id): Path<i64>) -> ApiResult<Json<RecordingDetail>> {
    Ok(Json(get_recording(&st, id).await?))
}

#[derive(Debug, Deserialize)]
struct OverviewParams {
    fft: Option<usize>,
    rows: Option<usize>,
    window: Option<Window>,
}

/// Sets the cancel flag when the request future is dropped (client went away).
struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// Strided overview of a whole recording (ADR 0003): `rows` evenly spaced FFTs.
/// Body: `rows × fft` little-endian `u16`, quantised dB, fftshifted, row-major.
async fn overview(
    State(st): St,
    Path(id): Path<i64>,
    Query(p): Query<OverviewParams>,
) -> ApiResult<Response> {
    let rec = get_recording(&st, id).await?.recording;
    let unprocessable = |m: String| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, m);
    if rec.status == Status::Broken {
        return Err(unprocessable(
            rec.error.unwrap_or_else(|| "recording is broken".into()),
        ));
    }
    let (Some(key), Some(dt)) = (&rec.data_key, &rec.datatype) else {
        return Err(unprocessable(
            "recording has no data or datatype yet".into(),
        ));
    };
    let dt = Datatype::parse(dt).map_err(|e| unprocessable(e.to_string()))?;
    let fft = p.fft.unwrap_or(1024);
    let rows = p.rows.unwrap_or(1024).clamp(1, MAX_ROWS);
    let spec = Spectrogram::new(dt, fft, p.window.unwrap_or_default())
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))?;
    if rows * fft > MAX_CELLS {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "rows × fft too large",
        ));
    }
    let num_samples = rec
        .num_samples
        .filter(|&n| n > 0)
        .ok_or_else(|| unprocessable("empty recording".into()))?;
    let src = st.source(&rec.source).ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            format!("source {} not configured", rec.source),
        )
    })?;

    let ss = dt.sample_size() as u64;
    let end = num_samples * ss;
    let offsets = strided_offsets(num_samples, fft, rows);
    let ranges: Vec<Range<u64>> = offsets
        .iter()
        .map(|o| o * ss..(o * ss + spec.row_bytes() as u64).min(end))
        .collect();

    let cancel = Arc::new(AtomicBool::new(false));
    let _guard = CancelOnDrop(cancel.clone());

    let t_read = Instant::now();
    let chunks = src.get_ranges(key, &ranges).await?;
    let read_ms = t_read.elapsed().as_secs_f64() * 1e3;

    let t_fft = Instant::now();
    let (tx, rx) = tokio::sync::oneshot::channel();
    rayon::spawn(move || {
        let _ = tx.send(spec.rows(&chunks, &cancel));
    });
    let data = rx
        .await
        .map_err(anyhow::Error::from)?
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let fft_ms = t_fft.elapsed().as_secs_f64() * 1e3;

    let mut body = Vec::with_capacity(data.len() * 2);
    for v in &data {
        body.extend_from_slice(&v.to_le_bytes());
    }

    let mut h = HeaderMap::new();
    let mut set = |k: &'static str, v: String| {
        h.insert(k, HeaderValue::from_str(&v).expect("ascii header"));
    };
    set("content-type", "application/octet-stream".into());
    set("x-trfiq-fft", fft.to_string());
    set("x-trfiq-rows", offsets.len().to_string());
    set("x-trfiq-mode", "strided".into());
    set("x-trfiq-db-min", quant::DB_MIN.to_string());
    set("x-trfiq-db-step", quant::DB_STEP.to_string());
    // Rows are evenly spaced from sample 0 to this offset (inclusive).
    set(
        "x-trfiq-last-offset",
        offsets.last().copied().unwrap_or(0).to_string(),
    );
    set(
        "server-timing",
        format!("read;dur={read_ms:.1}, fft;dur={fft_ms:.1}"),
    );
    set(header::CACHE_CONTROL.as_str(), "private, max-age=60".into());
    tracing::debug!(id, fft, rows = offsets.len(), read_ms, fft_ms, "overview");
    Ok((h, body).into_response())
}
