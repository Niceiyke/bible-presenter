use crate::license::{ensure_active_tier, LicenseTier};
use crate::state::AppState;
use serde::Serialize;
use tauri::{command, State};

/// NDI output (Phase 8 scaffold).
///
/// The frontend will publish the program-feed compositor as an NDI|HX source:
/// it encodes the stream with WebCodecs (H.264, Annex-B — the same single-encode
/// path the RTMP hub uses) and hands the encoded packets here; the backend wraps
/// them in the official NDI SDK's H.264 send mode so OBS (obs-ndi), vMix,
/// ProPresenter, and NDI-enabled hardware on the LAN can take the program as a
/// network source.
///
/// The real send pipeline is gated behind the `ndi` cargo feature because it
/// requires the NDI 6 SDK (vendor EULA — download + install to
/// `C:\Program Files\NDI\NDI 6 SDK`, see `docs/OUTPUT_MANAGER_DESIGN.md`) plus
/// the `grafton-ndi` bindings crate (bindgen needs LLVM). Until the operator's
/// machine has the SDK, the commands here stay honest: `ndi_status` reports
/// "not supported" (the Streaming workspace uses that to disable NDI cards) and
/// the send commands error cleanly instead of crashing. Once the SDK is
/// installed the `#[cfg(feature = "ndi")]` branches become the real pipeline and
/// sessions are keyed by `session_id` exactly like the RTMP sessions in
/// `commands/rtmp.rs`.
#[derive(Serialize)]
pub struct NdiStatus {
    pub supported: bool,
    pub reason: String,
}

fn not_compiled_reason() -> String {
    "NDI output is not compiled into this build (requires the NDI 6 SDK and the `ndi` cargo feature).".to_string()
}

/// Report whether this build can publish NDI sources. The Streaming workspace
/// consults this to gate NDI destinations (they stay visible but cannot go live).
#[command]
pub fn ndi_status() -> NdiStatus {
    #[cfg(feature = "ndi")]
    {
        // Real SDK probe once grafton-ndi is wired in (install, version, license
        // age). Until then, treat an enabled feature without a probe as unsupported.
        NdiStatus {
            supported: false,
            reason: "NDI probe not implemented yet.".to_string(),
        }
    }
    #[cfg(not(feature = "ndi"))]
    {
        NdiStatus {
            supported: false,
            reason: not_compiled_reason(),
        }
    }
}

/// Open an NDI|HX send session. `name` is the NDI source name announced on the
/// LAN (the destination label); once live, consumers discover "Wordlyte – <name>".
#[command]
pub fn ndi_start(state: State<'_, AppState>, session_id: String, _name: String) -> Result<(), String> {
    // NDI publishing is a Pro feature — enforce on the backend too.
    ensure_active_tier(&state, LicenseTier::Pro)?;
    let _ = session_id;
    Err(not_compiled_reason())
}

/// Feed one H.264 Annex-B access unit to the session's NDI|HX stream.
#[command]
pub fn ndi_send(session_id: String, _data_base64: String) -> Result<(), String> {
    let _ = session_id;
    Err(not_compiled_reason())
}

/// Tear the session down. Idempotent: tearing down an unknown session is a no-op,
/// matching `rtmp_stop` so a frontend that stopped twice does not error.
#[command]
pub fn ndi_stop(session_id: String) -> Result<(), String> {
    let _ = session_id;
    Ok(())
}