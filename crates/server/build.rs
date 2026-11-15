// rust-embed needs the frontend output folder to exist at compile time. When building the
// backend alone (tests, `cargo run` against the Vite dev server) it may not, so create it.
fn main() {
    let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/dist");
    std::fs::create_dir_all(&dist).expect("create web/dist");
    println!("cargo:rerun-if-changed=../../web/dist");
}
