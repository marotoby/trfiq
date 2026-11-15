use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use tower_http::compression::CompressionLayer;
use tower_http::trace::TraceLayer;
use trfiq_dsp::{Datatype, Spectrogram, Window, quant, timeseries};
use trfiq_index::{ListQuery, Recording, RecordingDetail, Status};

use crate::samples::{Coverage, ReadPlan, SampleReader, SampleWindow};
use crate::state::AppState;
use crate::web;

/// Upper bound on overview rows per request (rows × fft × 2 bytes must stay sane).
const MAX_ROWS: usize = 4096;
const MAX_CELLS: usize = 16 << 20;
/// Time windows up to this many samples are sent sample by sample.
const RAW_MAX: u64 = 65536;

type St = State<Arc<AppState>>;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/sources", get(sources))
        .route("/api/sources/{id}/rescan", post(rescan))
        .route("/api/recordings", get(list))
        .route("/api/recordings/{id}", get(detail))
        .route("/api/recordings/{id}/overview", get(overview))
        .route("/api/recordings/{id}/time", get(time))
        .route("/api/recordings/{id}/psd", get(psd))
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

/// The sample reader for a viewable recording, or why it can't be read.
async fn open_reader(st: &AppState, id: i64) -> ApiResult<SampleReader> {
    let rec = get_recording(st, id).await?.recording;
    let unprocessable = |m: String| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, m);
    if rec.status == Status::Broken {
        return Err(unprocessable(
            rec.error.unwrap_or_else(|| "recording is broken".into()),
        ));
    }
    let (Some(key), Some(dt)) = (rec.data_key, rec.datatype) else {
        return Err(unprocessable(
            "recording has no data or datatype yet".into(),
        ));
    };
    let dt = Datatype::parse(&dt).map_err(|e| unprocessable(e.to_string()))?;
    let num_samples = rec
        .num_samples
        .filter(|&n| n > 0)
        .ok_or_else(|| unprocessable("empty recording".into()))?;
    let src = st.source(&rec.source).cloned().ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            format!("source {} not configured", rec.source),
        )
    })?;
    Ok(SampleReader::new(src, key, dt, num_samples))
}

fn spectrogram(dt: Datatype, fft: Option<usize>, window: Option<Window>) -> ApiResult<Spectrogram> {
    Spectrogram::new(dt, fft.unwrap_or(1024), window.unwrap_or_default())
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))
}

fn binary(headers: &[(&'static str, String)], body: Vec<u8>) -> Response {
    let mut h = HeaderMap::new();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=60"),
    );
    for (k, v) in headers {
        h.insert(*k, HeaderValue::from_str(v).expect("ascii header"));
    }
    (h, body).into_response()
}

fn f32_body(data: &[f32]) -> Vec<u8> {
    data.iter().flat_map(|v| v.to_le_bytes()).collect()
}

#[derive(Debug, Deserialize)]
struct OverviewParams {
    fft: Option<usize>,
    rows: Option<usize>,
    window: Option<Window>,
}

/// Overview of a whole recording (ADR 0003): one FFT per row, rows spread over the file.
/// Body: `rows × fft` little-endian `u16`, quantised dB, fftshifted, row-major.
async fn overview(
    State(st): St,
    Path(id): Path<i64>,
    Query(p): Query<OverviewParams>,
) -> ApiResult<Response> {
    let reader = open_reader(&st, id).await?;
    let spec = spectrogram(reader.datatype(), p.fft, p.window)?;
    let fft = spec.fft_size();
    let rows = p.rows.unwrap_or(1024).clamp(1, MAX_ROWS);
    if rows * fft > MAX_CELLS {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "rows × fft too large",
        ));
    }
    let plan = ReadPlan::overview(reader.num_samples(), rows as u64, fft as u64);
    let last_offset = plan.slots().last().map_or(0, |r| r.start);
    let t = reader
        .run(&plan, move |chunks, cancel| spec.rows(chunks, cancel))
        .await?;
    let rows = plan.slots().len();
    tracing::debug!(id, fft, rows, t.read_ms, t.compute_ms, "overview");

    let body = t.value.iter().flat_map(|v| v.to_le_bytes()).collect();
    Ok(binary(
        &[
            ("x-trfiq-fft", fft.to_string()),
            ("x-trfiq-rows", rows.to_string()),
            ("x-trfiq-mode", "strided".into()),
            ("x-trfiq-db-min", quant::DB_MIN.to_string()),
            ("x-trfiq-db-step", quant::DB_STEP.to_string()),
            // Rows are evenly spaced from sample 0 to this offset (inclusive).
            ("x-trfiq-last-offset", last_offset.to_string()),
            ("server-timing", t.server_timing()),
        ],
        body,
    ))
}

// ---- detail plots ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct WindowParams {
    /// First sample (default 0) and sample count (default: to the end of the recording).
    start: Option<u64>,
    count: Option<u64>,
    /// Time plot: buckets in the min/max envelope.
    points: Option<usize>,
    /// PSD: FFT size and window.
    fft: Option<usize>,
    window: Option<Window>,
}

impl WindowParams {
    fn window(&self, num_samples: u64) -> ApiResult<SampleWindow> {
        SampleWindow::new(self.start, self.count, num_samples)
            .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))
    }
}

/// Time-domain I/Q for `[start, start + count)`, normalised to ±1.
///
/// - `x-trfiq-mode: raw`: `count × [i, q]` little-endian `f32`.
/// - `minmax` / `sampled`: `buckets × [i_min, i_max, q_min, q_max]`. `minmax` reads every
///   sample; `sampled` (windows over 2M samples) reads an evenly spaced slice of each bucket.
async fn time(
    State(st): St,
    Path(id): Path<i64>,
    Query(p): Query<WindowParams>,
) -> ApiResult<Response> {
    let reader = open_reader(&st, id).await?;
    let w = p.window(reader.num_samples())?;
    let dt = reader.datatype();
    let (mode, points, t) = if w.count <= RAW_MAX {
        let plan = ReadPlan::segments(w, w.count);
        let t = reader
            .run(&plan, move |chunks, _| Ok(timeseries::iq(dt, &chunks[0])))
            .await?;
        ("raw", w.count, t)
    } else {
        let buckets = p.points.unwrap_or(2048).clamp(64, 8192) as u64;
        let plan = ReadPlan::detail(w, Coverage::Buckets(buckets));
        let mode = if plan.is_sampled() {
            "sampled"
        } else {
            "minmax"
        };
        let t = reader
            .run(&plan, move |chunks, cancel| {
                timeseries::envelope(dt, chunks, cancel)
            })
            .await?;
        (mode, plan.slots().len() as u64, t)
    };
    tracing::debug!(id, w.start, w.count, mode, t.read_ms, t.compute_ms, "time");
    Ok(binary(
        &[
            ("x-trfiq-mode", mode.into()),
            ("x-trfiq-start", w.start.to_string()),
            ("x-trfiq-count", w.count.to_string()),
            ("x-trfiq-points", points.to_string()),
            ("server-timing", t.server_timing()),
        ],
        f32_body(&t.value),
    ))
}

/// Power spectrum of `[start, start + count)`: mean and max-hold over FFT-sized segments.
/// Body: `fft` mean dBFS then `fft` max dBFS, little-endian `f32`, fftshifted.
/// Up to 2M samples every segment is used (`x-trfiq-mode: full`); beyond that segments are
/// evenly spaced (`strided`).
async fn psd(
    State(st): St,
    Path(id): Path<i64>,
    Query(p): Query<WindowParams>,
) -> ApiResult<Response> {
    let reader = open_reader(&st, id).await?;
    let w = p.window(reader.num_samples())?;
    let spec = spectrogram(reader.datatype(), p.fft, p.window)?;
    let fft = spec.fft_size();
    let plan = ReadPlan::detail(w, Coverage::Segments(fft as u64));
    let mode = if plan.is_sampled() { "strided" } else { "full" };
    let segments = plan.slots().len();
    let t = reader
        .run(&plan, move |chunks, cancel| spec.psd(chunks, cancel))
        .await?;
    tracing::debug!(
        id,
        w.start,
        w.count,
        fft,
        segments,
        mode,
        t.read_ms,
        t.compute_ms,
        "psd"
    );

    let (mean, max) = &t.value;
    let mut body = f32_body(mean);
    body.extend(f32_body(max));
    Ok(binary(
        &[
            ("x-trfiq-mode", mode.into()),
            ("x-trfiq-fft", fft.to_string()),
            ("x-trfiq-segments", segments.to_string()),
            ("x-trfiq-start", w.start.to_string()),
            ("x-trfiq-count", w.count.to_string()),
            ("server-timing", t.server_timing()),
        ],
        body,
    ))
}
