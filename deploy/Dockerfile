# Build from the repo root:  docker build -f deploy/Dockerfile -t trfiq .

# ---- frontend ----
FROM docker.io/oven/bun:1.4.4 AS web
WORKDIR /web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
ARG TRFIQ_BASE_PATH=/
RUN bun run build --base=${TRFIQ_BASE_PATH}

# ---- backend (frontend embedded via rust-embed) ----
FROM docker.io/library/rust:1.100-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY --from=web /web/dist web/dist
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p trfiq-server \
    && cp target/release/trfiq /trfiq \
    && mkdir -p /state

# ---- runtime: glibc + libgcc only, no shell, non-root ----
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /trfiq /trfiq
# Pre-create the state dir owned by the nonroot user so a fresh volume inherits it.
COPY --from=build --chown=65532:65532 /state /var/lib/trfiq
COPY deploy/config.example.yaml /etc/trfiq/config.yaml
VOLUME /var/lib/trfiq
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s CMD ["/trfiq", "healthcheck"]
ENTRYPOINT ["/trfiq"]
