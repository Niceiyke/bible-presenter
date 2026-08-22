use std::path::PathBuf;
use std::{env, fs};

fn main() {
    tauri_build::build();
    stage_windows_runtime_dlls();
}

/// The engine links libav dynamically (ffmpeg-sys-next), so wordlyte.exe /
/// wordlyte-engine.exe import av*.dll / sw*.dll at load time. The Windows
/// loader resolves static imports BEFORE any application code runs and
/// searches only the exe's own folder (+ system dirs / PATH), so the DLLs must
/// sit beside the built binaries for `cargo run` / `tauri dev`. The
/// installed-app layout is handled separately by scripts/copy-engine-binary.mjs
/// + the `binaries/dll/*.dll` -> `.` resource mapping in tauri.conf.json.
///
/// Source precedence mirrors what ffmpeg-sys-next links against: a vcpkg
/// x64-windows install, else `$FFMPEG_DIR/bin` (shared ffmpeg build), else the
/// pre-staged `binaries/dll` directory.
fn stage_windows_runtime_dlls() {
    if !cfg!(windows) {
        return;
    }
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    // OUT_DIR = <target>/<profile>/build/<pkg>-<hash>/out; three levels up is
    // <target>/<profile>, where cargo places the executables.
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let Some(exe_dir) = out_dir.ancestors().nth(3) else {
        return;
    };
    println!(
        "cargo:rerun-if-changed={}",
        manifest_dir.join("binaries/dll").display()
    );

    let vcpkg_root = env::var("VCPKG_ROOT").unwrap_or_else(|_| "C:\\vcpkg".to_string());
    let candidates = [
        Some(
            PathBuf::from(&vcpkg_root)
                .join("installed")
                .join("x64-windows")
                .join("bin"),
        ),
        env::var("FFMPEG_DIR").ok().map(|dir| PathBuf::from(dir).join("bin")),
        Some(manifest_dir.join("binaries").join("dll")),
    ];
    let source_dir = match candidates.into_iter().flatten().find(|dir| dir.is_dir()) {
        Some(dir) => dir,
        None => return,
    };

    if let Ok(entries) = fs::read_dir(source_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let lower = name.to_string_lossy().to_lowercase();
            let is_runtime_dll =
                (lower.starts_with("av") || lower.starts_with("sw")) && lower.ends_with(".dll");
            if is_runtime_dll && entry.path().is_file() {
                let _ = fs::copy(entry.path(), exe_dir.join(&name));
            }
        }
    }
}
