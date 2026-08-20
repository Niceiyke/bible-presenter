use crate::engine::client::EngineReply;
use crate::engine::ipc::EngineCommand;
use crate::state::AppState;

/// Invoke one engine command off the async runtime. Surfaces a friendly error
/// when the sidecar is not running or the round-trip task fails; the engine's
/// structured error rides through unchanged.
pub async fn invoke(
    state: &tauri::State<'_, AppState>,
    command: EngineCommand,
) -> Result<EngineReply, String> {
    let client = state
        .engine
        .lock()
        .clone()
        .ok_or_else(|| "engine_unavailable: the engine sidecar is not running".to_string())?;
    if !client.is_running() {
        return Err("engine_unavailable: the engine sidecar is not running".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || client.invoke(command))
        .await
        .map_err(|e| format!("engine invoke task failed: {e}"))?
}

/// Turn an engine reply into a console error when the engine rejected it.
pub fn response_err(reply: &EngineReply) -> Option<String> {
    if reply.response.ok {
        None
    } else {
        Some(
            reply
                .response
                .error
                .as_ref()
                .map(|e| e.message.clone())
                .unwrap_or_else(|| "Engine command failed".to_string()),
        )
    }
}

/// Resolve the capture geometry for transport sessions from the `stream-main`
/// output config (the frontend's capture picker persists its selection there).
/// Falls back to `defaults` (1920×1080) when the config is missing or zero.
pub fn transport_geometry(state: &AppState, defaults: (u32, u32)) -> (u32, u32) {
    state
        .outputs
        .get("stream-main")
        .map(|c| (c.geometry.width, c.geometry.height))
        .filter(|(w, h)| *w > 0 && *h > 0)
        .unwrap_or(defaults)
}