// build.rs
fn main() {
    // Build the remote-ui React SPA so rust-embed can embed it.
    // Only rebuilds when source files change (tracked via rerun-if-changed).
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let remote_ui_dir = manifest_dir.join("../remote-ui");
    let dist_dir = remote_ui_dir.join("dist");

    // Tell Cargo to re-run this script if any remote-ui source changes.
    println!("cargo:rerun-if-changed={}", remote_ui_dir.join("src").display());
    println!("cargo:rerun-if-changed={}", remote_ui_dir.join("index.html").display());
    println!("cargo:rerun-if-changed={}", remote_ui_dir.join("vite.config.ts").display());
    println!("cargo:rerun-if-changed={}", remote_ui_dir.join("package.json").display());

    // Run `npm run build` inside remote-ui/ if dist/ doesn't exist yet.
    // In CI or on fresh clones it will always build; locally Cargo only reruns
    // when the rerun-if-changed paths above are touched.
    if !dist_dir.exists() || std::env::var("FORCE_REMOTE_UI_BUILD").is_ok() {
        let status = std::process::Command::new("npm")
            .args(["run", "build"])
            .current_dir(&remote_ui_dir)
            .status()
            .expect("Failed to run `npm run build` in remote-ui/. Is Node.js installed?");

        if !status.success() {
            panic!("remote-ui build failed");
        }
    }

    tauri_build::build()
}
