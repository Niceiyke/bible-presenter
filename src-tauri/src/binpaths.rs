//! Media backend resolver (ffmpeg-next in-process).
//!
//! The `ffmpeg.exe` pipe fallback has been removed — `ffmpeg-next` is now
//! required (`default = ["ffmpeg-next"]`). `ffmpeg_available()` simply proves
//! `ffmpeg::init()` succeeded.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static BUNDLED_BIN_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

fn ffmpeg_exe() -> &'static str {
    if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" }
}

fn ffprobe_exe() -> &'static str {
    if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" }
}

/// Register the bundled `bin/` directory at startup (kept for compat, not used
/// for ffmpeg — libav is linked in). Still adopted if present so old resource
/// checks don't spam.
pub fn init(resource_dir: &Path) {
    let dir = resource_dir.join("bin");
    let present = dir.join(ffmpeg_exe()).exists();
    let _ = BUNDLED_BIN_DIR.set(if present { Some(dir) } else { None });
}

fn bundled_dir() -> Option<PathBuf> {
    BUNDLED_BIN_DIR.get().and_then(|d| d.clone())
}

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
/// Kept for diagnostics only — the engine no longer spawns it.
pub fn ffmpeg_path() -> PathBuf {
    resolve_in_dir(bundled_dir().as_deref(), ffmpeg_exe())
}

pub fn ffprobe_path() -> PathBuf {
    resolve_in_dir(bundled_dir().as_deref(), ffprobe_exe())
}

/// Whether the in-process ffmpeg backend is usable (always true when linked).
pub fn ffmpeg_available() -> bool {
    crate::engine::ffmpeg::init().is_ok()
}

/// Which backend is active — for diagnostics / SystemTab.
pub fn backend_label() -> &'static str {
    crate::engine::ffmpeg::backend_label()
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
