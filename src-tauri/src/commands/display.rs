use crate::engine::{self, Engine};
use crate::state::AppState;
use crate::store;
use tauri::{AppHandle, State};

/// Adapter over the broadcast engine: every mutation runs through
/// `crate::engine` so desktop commands and the remote surface share the same
/// single-lock, single-revision, single-event contract. The legacy command
/// names and return shapes are preserved so the frontend contract is
/// unchanged.

#[tauri::command]
pub async fn presentation_snapshot(state: State<'_, AppState>) -> Result<engine::PresentationSnapshot, String> {
    // Read the whole presentation under the mutation lock so the snapshot is
    // consistent: no event can be half-way applied when we capture it.
    let _guard = state.presentation.lock.lock();
    Ok(engine::snapshot(&*state))
}

#[tauri::command]
pub async fn stage_item(app: AppHandle, state: State<'_, AppState>, item: store::DisplayItem) -> Result<(), String> {
    crate::license::ensure_allowed(&state)?;
    let sink = engine::app_emit_sink(&app);
    let engine = Engine { state: &*state, emit: &sink };
    engine.op_stage(item, None, 0).map(|_| ())
}

/// Atomically copy the staged slot into the live slot and broadcast the
/// update. Returns the new live item so callers can confirm the commit
/// succeeded (`None` when nothing was staged).
#[tauri::command]
pub async fn commit_staged(app: AppHandle, state: State<'_, AppState>) -> Result<Option<store::DisplayItem>, String> {
    crate::license::ensure_allowed(&state)?;
    let sink = engine::app_emit_sink(&app);
    let engine = Engine { state: &*state, emit: &sink };
    Ok(engine.op_commit_staged(None)?.committed)
}

/// Legacy `go_live` — kept for backwards compatibility but now delegates to
/// the engine's commit. Returns Ok(()) regardless of whether anything was
/// staged (matching historical behaviour).
#[tauri::command]
pub async fn go_live(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    crate::license::ensure_allowed(&state)?;
    let sink = engine::app_emit_sink(&app);
    let engine = Engine { state: &*state, emit: &sink };
    engine.op_commit_staged(None).map(|_| ())
}

/// Atomic stage-and-commit in one transaction: stages `item` and immediately
/// takes it live under a single presentation lock, so no concurrent caller can
/// commit a different item in between. The frontend `sendLive` uses this
/// instead of two separate IPC invokes (audit: concurrent stage/send-live).
#[tauri::command]
pub async fn send_live_item(app: AppHandle, state: State<'_, AppState>, item: store::DisplayItem) -> Result<store::DisplayItem, String> {
    crate::license::ensure_allowed(&state)?;
    let sink = engine::app_emit_sink(&app);
    let engine = Engine { state: &*state, emit: &sink };
    engine
        .op_send_live(item, None)
        .map(|r| r.committed.expect("send_live always commits"))
}

#[tauri::command]
pub async fn go_live_item(app: AppHandle, state: State<'_, AppState>, item: store::DisplayItem) -> Result<(), String> {
    crate::license::ensure_allowed(&state)?;
    let sink = engine::app_emit_sink(&app);
    let engine = Engine { state: &*state, emit: &sink };
    engine.op_go_live_item(item, None).map(|_| ())
}

/// Clear the live slot only. Staged slot is preserved so the operator can
/// re-send the same item. Emits both `live-item-update` and `item-staged`
/// (with the unchanged staged value) so windows stay consistent.
#[tauri::command]
pub async fn clear_live(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let sink = engine::app_emit_sink(&app);
    let engine = Engine { state: &*state, emit: &sink };
    engine.op_clear_live(None).map(|_| ())
}

/// Clear the staged slot only (backend-authoritative) so the output/stage
/// windows and a later window reopen no longer show a staged item that the
/// operator already cleared from the Cockpit.
#[tauri::command]
pub async fn clear_staged(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let sink = engine::app_emit_sink(&app);
    let engine = Engine { state: &*state, emit: &sink };
    engine.op_clear_staged(None).map(|_| ())
}

/// Clear everything the audience can see: live item, staged item, lower-third
/// overlay and props layer. This is the "CLEAR ALL" semantic — one atomic
/// reset across all presentation channels. Settings (theme/background/blank)
/// are intentionally preserved. Propagates persistence failure (cleared props
/// must survive a restart) back to the operator instead of silently clearing.
#[tauri::command]
pub async fn clear_all(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let sink = engine::app_emit_sink(&app);
    let engine = Engine { state: &*state, emit: &sink };
    engine.op_clear_all(None).map(|_| ())
}

#[tauri::command]
pub async fn update_timer(app: AppHandle, state: State<'_, AppState>, started_at: Option<u64>) -> Result<(), String> {
    let sink = engine::app_emit_sink(&app);
    let engine = Engine { state: &*state, emit: &sink };
    engine.op_update_timer(started_at).map(|_| ())
}

#[tauri::command]
pub async fn get_current_item(state: State<'_, AppState>) -> Result<Option<store::DisplayItem>, String> {
    Ok(state.presentation.live_item.lock().clone())
}

#[tauri::command]
pub async fn get_staged_item(state: State<'_, AppState>) -> Result<Option<store::DisplayItem>, String> {
    Ok(state.presentation.staged_item.lock().clone())
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<store::PresentationSettings, String> {
    Ok(state.presentation.settings.lock().clone())
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, state: State<'_, AppState>, settings: store::PresentationSettings) -> Result<(), String> {
    let sink = engine::app_emit_sink(&app);
    let engine = Engine { state: &*state, emit: &sink };
    engine.op_save_settings(settings).map(|_| ())
}

#[cfg(test)]
mod tests {
    // The display mutations are covered by the engine unit tests (cargo test)
    // plus the transactional frontend tests (npm run test).
}
