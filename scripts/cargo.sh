#!/usr/bin/env bash
# Run cargo inside the pinned Rust container, so no host toolchain is needed.
#   scripts/cargo.sh test
#   scripts/cargo.sh run -p trfiq-server -- --config deploy/config.dev.yaml
# Uses the host network so `cargo run` can reach the dev S3 server on localhost.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
image="${TRFIQ_RUST_IMAGE:-localhost/trfiq-rust-dev:1.100}"
# Build the dev image on first use (pinned Rust + clippy + rustfmt).
podman image exists "$image" || podman build -q -t "$image" -f "$root/scripts/rust-dev.Containerfile" "$root/scripts" >&2
cache="${XDG_CACHE_HOME:-$HOME/.cache}/trfiq/cargo"
mkdir -p "$cache"
tty=(); [ -t 0 ] && tty=(-it)
exec podman run --rm "${tty[@]}" --userns=keep-id --network=host \
  -v "$root:/src:Z" -v "$cache:/cargo:Z" -e CARGO_HOME=/cargo -e RUST_LOG -e TRFIQ_UPDATE_FIXTURES \
  -w /src "$image" cargo "$@"
