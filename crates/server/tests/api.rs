//! End-to-end through the HTTP router against a local-folder source.

use std::f32::consts::TAU;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;
use trfiq_dsp::quant;
use trfiq_index::Index;
use trfiq_server::{api, config::Config, state::AppState};

async fn get(app: &axum::Router, uri: &str) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let resp = app
        .clone()
        .oneshot(Request::get(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let (parts, body) = resp.into_parts();
    (
        parts.status,
        parts.headers,
        body.collect().await.unwrap().to_bytes().to_vec(),
    )
}

#[tokio::test]
async fn list_detail_and_overview() {
    let dir = tempfile::tempdir().unwrap();
    // A ci16 tone at +1/8 of the sample rate, 128k samples.
    let n = 131072;
    let data: Vec<u8> = (0..n)
        .flat_map(|i| {
            let ph = TAU * 0.125 * i as f32;
            [(ph.cos() * 16000.0) as i16, (ph.sin() * 16000.0) as i16]
        })
        .flat_map(i16::to_le_bytes)
        .collect();
    std::fs::write(dir.path().join("tone.sigmf-data"), data).unwrap();
    std::fs::write(
        dir.path().join("tone.sigmf-meta"),
        r#"{"global": {"core:datatype": "ci16_le", "core:sample_rate": 1e6},
            "captures": [{"core:frequency": 1e8}], "annotations": []}"#,
    )
    .unwrap();

    let cfg: Config = serde_yaml::from_str(&format!(
        "sources: [{{id: t, kind: local, path: {:?}}}]",
        dir.path()
    ))
    .unwrap();
    let state = AppState::new(&cfg, Index::open_in_memory().unwrap()).unwrap();
    trfiq_index::scan(&state.sources[0], state.index.clone())
        .await
        .unwrap();
    let app = api::router(state);

    let (code, _, body) = get(&app, "/api/recordings").await;
    assert_eq!(code, StatusCode::OK);
    let list: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(list[0]["name"], "tone");
    assert_eq!(list[0]["num_samples"], n);
    let id = list[0]["id"].as_i64().unwrap();

    let (code, h, body) = get(
        &app,
        &format!("/api/recordings/{id}/overview?fft=256&rows=32"),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(h["x-trfiq-rows"], "32");
    assert_eq!(body.len(), 32 * 256 * 2);
    let row0: Vec<u16> = body[..512]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| u16::from_le_bytes(*b))
        .collect();
    let peak = (0..256).max_by_key(|&k| row0[k]).unwrap();
    assert_eq!(peak, 128 + 32, "tone at +fs/8 → bin n/2 + n/8");
    // Amplitude 16000/32768 ≈ -6.2 dBFS.
    assert!((quant::dequantize(row0[peak]) + 6.23).abs() < 0.1);

    let f32s = |b: &[u8]| -> Vec<f32> {
        b.as_chunks::<4>()
            .0
            .iter()
            .map(|c| f32::from_le_bytes(*c))
            .collect()
    };
    let amp = 16000.0 / 32768.0;

    // Time: short windows come back sample by sample…
    let (code, h, body) = get(&app, &format!("/api/recordings/{id}/time?start=0&count=8")).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(h["x-trfiq-mode"], "raw");
    let iq = f32s(&body);
    assert_eq!(iq.len(), 16);
    assert!((iq[0] - amp).abs() < 1e-3 && iq[1].abs() < 1e-3, "{iq:?}");
    // …long ones as a min/max envelope that still reaches the tone's peaks.
    let (code, h, body) = get(&app, &format!("/api/recordings/{id}/time?points=64")).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(h["x-trfiq-mode"], "minmax");
    assert_eq!(h["x-trfiq-count"], n.to_string());
    let env = f32s(&body);
    assert_eq!(env.len(), 64 * 4);
    for b in env.chunks(4) {
        assert!(
            (b[0] + amp).abs() < 1e-2 && (b[1] - amp).abs() < 1e-2,
            "{b:?}"
        );
    }

    // PSD: peak in the tone's bin at its level, mean and max-hold agree for a steady tone.
    let (code, h, body) = get(&app, &format!("/api/recordings/{id}/psd?fft=256")).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(h["x-trfiq-mode"], "full");
    assert_eq!(h["x-trfiq-segments"], (n / 256).to_string());
    let v = f32s(&body);
    let (mean, max) = v.split_at(256);
    let peak = (0..256)
        .max_by(|&a, &b| mean[a].total_cmp(&mean[b]))
        .unwrap();
    assert_eq!(peak, 128 + 32);
    assert!((mean[peak] + 6.23).abs() < 0.1 && (max[peak] + 6.23).abs() < 0.1);
    // A window shorter than one FFT is zero-padded, not rejected.
    let (code, h, body) = get(
        &app,
        &format!("/api/recordings/{id}/psd?fft=256&start=1000&count=10"),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(h["x-trfiq-segments"], "1");
    assert_eq!(body.len(), 2 * 256 * 4);

    // Windows starting past the end, or empty, are rejected.
    for q in [format!("start={n}"), "count=0".into()] {
        let (code, _, _) = get(&app, &format!("/api/recordings/{id}/time?{q}")).await;
        assert_eq!(code, StatusCode::BAD_REQUEST, "{q}");
    }

    let (code, _, _) = get(&app, &format!("/api/recordings/{id}/overview?fft=1000")).await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    let (code, _, _) = get(&app, "/api/recordings/999").await;
    assert_eq!(code, StatusCode::NOT_FOUND);
    let (code, _, _) = get(&app, "/healthz").await;
    assert_eq!(code, StatusCode::OK);
}
