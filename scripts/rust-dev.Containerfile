# Rust toolchain image for scripts/cargo.sh: the pinned release image plus clippy and rustfmt.
FROM docker.io/library/rust:1.100-bookworm
RUN rustup component add clippy rustfmt
