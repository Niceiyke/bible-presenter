//! Bundled media binaries (ffmpeg / ffprobe) resolver.
//!
//! ffmpeg is resolved **bundled-first**: when `{resource_dir}/bin/ffmpeg.exe`
//! is present (shipped via `bundle.resources`), that exact binary is used;
//! otherwise the bare name falls back to a PATH lookup. Bundling removes the
//! "install ffmpeg" hard gate for RTMP streaming and keeps video/audio probing
//! working on machines that have never installed ffmpeg. ffprobe resolves the
//! same way.
//!
//! `init()` is called once at startup from `main.rs` (where the resolved
//! resource dir is known); everything else just reads the process-wide cache.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

static BUNDLED_BIN_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
static RESOURCE_BIN_DIR: OnceLock<PathBuf> = OnceLock::new();

fn ffmpeg_exe() -> &'static str {
    if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" }
}

fn ffprobe_exe() -> &'static str {
    if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" }
}

/// Register the bundled `bin/` directory at startup. Only adopted when it
/// actually contains ffmpeg, so a missing binary silently keeps PATH behavior.
///
/// In `tauri dev` the installed layout (`{resource_dir}/bin`) doesn't exist:
/// `resource_dir` is not the exe directory and has no `bin/` folder, so the
/// bare `"ffmpeg.exe"` PATH fallback would fail on machines without a system
/// ffmpeg and every audio picker (including Live Scripture Assistant) would
/// show an empty list. Probe the exe directory and the repo `binaries/` folder
/// as well so dev builds resolve the same binary as production.
pub fn init(resource_dir: &Path) {
    let mut candidates: Vec<PathBuf> = vec![resource_dir.join("bin")];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("bin"));
            candidates.push(dir.to_path_buf());
            // `cargo test` / `cargo run` put the exe under `target/debug/` or
            // `target/debug/deps/`; the repo binaries live next to `src-tauri/`.
            for ancestor in dir.ancestors() {
                let name = ancestor.file_name().and_then(|n| n.to_str());
                if name == Some("debug") || name == Some("release") {
                    if let Some(profile_parent) = ancestor.parent() {
                        if let Some(src_tauri) = profile_parent.parent() {
                            candidates.push(src_tauri.join("binaries"));
                        }
                    }
                }
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("src-tauri").join("binaries"));
        candidates.push(cwd.join("src-tauri").join("target").join("debug").join("bin"));
        candidates.push(cwd.join("binaries"));
        candidates.push(cwd.join("bin"));
    }
    let exe_name = ffmpeg_exe();
    let found = candidates
        .into_iter()
        .find(|dir| dir.join(exe_name).is_file());
    if let Some(dir) = found {
        let _ = RESOURCE_BIN_DIR.set(dir.clone());
        let _ = BUNDLED_BIN_DIR.set(Some(dir));
    } else {
        let dir = resource_dir.join("bin");
        let _ = RESOURCE_BIN_DIR.set(dir);
        let _ = BUNDLED_BIN_DIR.set(None);
    }
}

/// Resolve an optional bundled runtime without falling back to PATH. Vendor
/// integrations use this so an arbitrary same-named DLL is never loaded.
pub fn bundled_runtime(name: &str) -> Option<PathBuf> {
    RESOURCE_BIN_DIR
        .get()
        .map(|dir| dir.join(name))
        .filter(|path| path.is_file())
}

fn bundled_dir() -> Option<PathBuf> {
    BUNDLED_BIN_DIR.get().and_then(|d| d.clone())
}

/// Pure resolution used by the process-wide helpers (and unit tests): return
/// the bundled binary when present, otherwise the bare name for PATH lookup.
fn resolve_in_dir(dir: Option<&Path>, name: &str) -> PathBuf {
    if let Some(d) = dir {
        let p = d.join(name);
        if p.exists() {
            return p;
        }
    }
    PathBuf::from(name)
}

/// Full path to ffmpeg if bundled; otherwise the bare name (PATH lookup).
pub fn ffmpeg_path() -> PathBuf {
    resolve_in_dir(bundled_dir().as_deref(), ffmpeg_exe())
}

/// Full path to ffprobe if bundled; otherwise the bare name (PATH lookup).
pub fn ffprobe_path() -> PathBuf {
    resolve_in_dir(bundled_dir().as_deref(), ffprobe_exe())
}

/// Whether ffmpeg is usable right now (bundled or on PATH).
pub fn ffmpeg_available() -> bool {
    Command::new(ffmpeg_path())
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch_dir(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("wordlyte_binpaths_test_{tag}"));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn uninitialized_resolves_to_bare_name() {
        assert_eq!(resolve_in_dir(None, "ffmpeg.exe"), PathBuf::from("ffmpeg.exe"));
    }

    #[test]
    fn bundled_dir_wins_when_binary_present() {
        let dir = scratch_dir("bundled");
        let file = dir.join("ffmpeg.exe");
        fs::write(&file, b"fake").unwrap();
        assert_eq!(resolve_in_dir(Some(&dir), "ffmpeg.exe"), file);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_binary_falls_back_to_path() {
        let dir = scratch_dir("missing");
        let resolved = resolve_in_dir(Some(&dir), "ffprobe.exe");
        assert_eq!(resolved, PathBuf::from("ffprobe.exe"));
        let _ = fs::remove_dir_all(&dir);
    }
}
