//! In-process ffmpeg pipeline (feature `ffmpeg-next`).
//!
//! This module is the `ffmpeg-next` (libav*) counterpart to the bundled
//! `ffmpeg.exe` CLI pipe in `engine/compositor/media.rs` + `engine/transport.rs`
//! + `store/media_schedule.rs`. When the `ffmpeg-next` cargo feature is enabled
//! the engine swaps every producer/consumer to these in-process paths — same
//! `MediaFrameHub`/`DecoderSpawner`/`TransportManager` contracts, zero pipe
//! `read_exact`/`write_all` hops, HW decode/encode (d3d11va/NVENC/QSV) where the
//! host supports it, and typed `AVERROR` instead of string-parsed ffprobe output.
//!
//! Fallback: with the feature **disabled** the engine keeps the subprocess pipe
//! (aggregate GPL, crash-isolated) and this module compiles to no-ops so
//! `cargo check` never needs ffmpeg dev libs / clang / vcpkg. Turn it on with:
//! `cargo check --features ffmpeg-next` (Windows: install LLVM + ffmpeg 7.1 dev
//! libs first — see `docs/RUST_VIDEO_ENGINE_PLAN.md` §5/§12).

pub mod capture;
pub mod decode;
pub mod encode;
pub mod probe;

/// One-time libav init. Safe to call multiple times (atomic guard).
pub fn init() -> Result<(), String> {
    use std::sync::OnceLock;
    static INIT: OnceLock<Result<(), String>> = OnceLock::new();
    let res = INIT.get_or_init(|| {
        ffmpeg_next::init().map_err(|e| format!("ffmpeg init failed: {e}"))?;
        // Suppress verbose libav chatter — operator diagnostics use our own
        // tracing. Keep it at AV_LOG_ERROR so real failures still surface.
        ffmpeg_next::util::log::set_level(ffmpeg_next::util::log::Level::Error);
        #[cfg(target_os = "windows")]
        {
            let _ = std::panic::catch_unwind(|| unsafe {
                if let Some(f) = try_avdevice_register_all() {
                    f();
                }
            });
        }
        Ok(())
    });
    match res {
        Ok(()) => Ok(()),
        Err(e) => Err(e.clone()),
    }
}

#[cfg(target_os = "windows")]
fn try_avdevice_register_all() -> Option<unsafe extern "C" fn()> {
    None
}

/// Whether the in-process pipeline is active in this build.
pub fn is_enabled() -> bool {
    true
}

/// Human-readable backend description for diagnostics / SystemTab.
pub fn backend_label() -> &'static str {
    "ffmpeg-next (in-process, HW accel)"
}
