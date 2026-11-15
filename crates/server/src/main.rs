use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use trfiq_index::Index;
use trfiq_server::{api, config::Config, state::AppState};

#[derive(Parser)]
#[command(version, about = "IQ recording visualiser and indexer")]
struct Cli {
    #[arg(long, env = "TRFIQ_CONFIG", default_value = "/etc/trfiq/config.yaml")]
    config: PathBuf,
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Exit 0 if the server answers /healthz (for container health checks; the runtime image
    /// has no curl).
    Healthcheck {
        #[arg(default_value = "127.0.0.1:8080")]
        addr: String,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    if let Some(Cmd::Healthcheck { addr }) = cli.cmd {
        return healthcheck(&addr);
    }
    init_logging();
    tokio::runtime::Runtime::new()?.block_on(serve(cli.config))
}

async fn serve(config: PathBuf) -> Result<()> {
    let cfg = Config::load(&config)?;
    std::fs::create_dir_all(&cfg.data_dir)
        .with_context(|| format!("create data_dir {}", cfg.data_dir.display()))?;
    let index = Index::open(&cfg.data_dir.join("index.sqlite"))?;
    let state = AppState::new(&cfg, index)?;
    state.spawn_scanners(Duration::from_secs(cfg.scan_interval_secs.max(10)));

    let listener = tokio::net::TcpListener::bind(cfg.listen).await?;
    tracing::info!(addr = %cfg.listen, sources = cfg.sources.len(), "listening");
    axum::serve(listener, api::router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

fn init_logging() {
    use tracing_subscriber::{EnvFilter, fmt};
    let filter = EnvFilter::try_from_env("RUST_LOG")
        .unwrap_or_else(|_| EnvFilter::new("info,tower_http=warn"));
    if std::env::var("TRFIQ_LOG_FORMAT").as_deref() == Ok("pretty") {
        fmt().with_env_filter(filter).init();
    } else {
        fmt().json().with_env_filter(filter).init();
    }
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    let term = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    tracing::info!("shutting down");
}

fn healthcheck(addr: &str) -> Result<()> {
    let mut s = std::net::TcpStream::connect(addr)?;
    s.set_read_timeout(Some(Duration::from_secs(3)))?;
    s.write_all(b"GET /healthz HTTP/1.0\r\nHost: localhost\r\n\r\n")?;
    let mut resp = String::new();
    s.read_to_string(&mut resp)?;
    anyhow::ensure!(
        resp.starts_with("HTTP/1.1 200") || resp.starts_with("HTTP/1.0 200"),
        "unhealthy: {resp:.80}"
    );
    Ok(())
}
