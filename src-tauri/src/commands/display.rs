use crate::events::{emit_checked, LiveItemUpdate};
use crate::remote::commands::{
    op_clear_all as remote_clear_all, op_clear_live as remote_clear_live,
    op_clear_staged as remote_clear_staged, op_commit_staged as remote_commit_staged,
    op_go_live_item, op_send_live, op_stage as remote_stage,
};
use crate::remote::protocol::RemoteEventKind;
use crate::state::AppState;
use crate::store;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, State};

/// Schema version of the `PresentationSnapshot` document. Bumped when the
/// snapshot's on-wire shape changes; consumers must reject a snapshot whose
/// `schema_version` they do not understand instead of guessing at fields.
pub const PRESENTATION_SCHEMA_VERSION: u32 = 1;

/// Authoritative presentation snapshot for window hydration. Windows call
/// `presentation_snapshot` after registering their event listeners and replay
/// their buffered events on top of it, so a reopening window converges to the
/// same state as the operator console.
#[derive(Serialize)]
pub struct PresentationSnapshot {
    pub schema_version: u32,
    pub live: Option<store::DisplayItem>,
    pub staged: Option<store::DisplayItem>,
    pub settings: store::PresentationSettings,
    pub lower_third: Option<serde_json::Value>,
    pub props: Vec<store::PropItem>,
    pub revision: u64,
}

#[tauri::command]
pub async fn presentation_snapshot(state: State<'_, AppState>) -> Result<PresentationSnapshot, String> {
    // Read the whole presentation under the mutation lock so the snapshot is
    // consistent: no event can be half-way applied when we capture it.
    let _guard = state.presentation.lock.lock();
    Ok(PresentationSnapshot {
        schema_version: PRESENTATION_SCHEMA_VERSION,
        live: state.presentation.live_item.lock().clone(),
        staged: state.presentation.staged_item.lock().clone(),
        settings: state.presentation.settings.lock().clone(),
        lower_third: state.presentation.lower_third.lock().clone(),
        props: state.presentation.props_layer.lock().clone(),
        revision: state.presentation.current_revision(),
    })
}

#[tauri::command]
pub async fn stage_item(app: AppHandle, state: State<'_, AppState>, item: store::DisplayItem) -> Result<(), String> {
    crate::license::ensure_allowed(&state)?;
    remote_stage(&app, &state, item, None, 0);
    Ok(())
}

/// Atomically copy the staged slot into the live slot and broadcast the
/// update. Replaces the old `go_live` (which released the staged lock before
/// re-acquiring the live lock, opening a TOCTOU window). Returns the new
/// live item so callers can confirm the commit succeeded.
#[tauri::command]
pub async fn commit_staged(app: AppHandle, state: State<'_, AppState>) -> Result<Option<store::DisplayItem>, String> {
    crate::license::ensure_allowed(&state)?;
    Ok(remote_commit_staged(&app, &state, None))
}

/// Legacy `go_live` — kept for backwards compatibility but now delegates to
/// `commit_staged`. Returns Ok(()) regardless of whether anything was staged
/// (matching historical behaviour).
#[tauri::command]
pub async fn go_live(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    crate::license::ensure_allowed(&state)?;
    remote_commit_staged(&app, &state, None);
    Ok(())
}

/// Atomic stage-and-commit in one transaction: stages `item` and immediately
/// takes it live under a single presentation lock, so no concurrent caller can
/// commit a different item in between. The frontend `sendLive` uses this
/// instead of two separate IPC invokes (audit: concurrent stage/send-live).
#[tauri::command]
pub async fn send_live_item(app: AppHandle, state: State<'_, AppState>, item: store::DisplayItem) -> Result<store::DisplayItem, String> {
    crate::license::ensure_allowed(&state)?;
    op_send_live(&app, &state, item, None)
}

#[tauri::command]
pub async fn go_live_item(app: AppHandle, state: State<'_, AppState>, item: store::DisplayItem) -> Result<(), String> {
    crate::license::ensure_allowed(&state)?;
    op_go_live_item(&app, &state, item, None);
    Ok(())
}

/// Clear the live slot only. Staged slot is preserved so the operator can
/// re-send the same item. Emits both `live-item-update` and `item-staged`
/// (with the unchanged staged value) so windows stay consistent.
#[tauri::command]
pub async fn clear_live(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    remote_clear_live(&app, &state, None);
    Ok(())
}

/// Clear the staged slot only (backend-authoritative) so the output/stage
/// windows and a later window reopen no longer show a staged item that the
/// operator already cleared from the Cockpit.
#[tauri::command]
pub async fn clear_staged(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    remote_clear_staged(&app, &state, None);
    Ok(())
}

/// Clear everything the audience can see: live item, staged item, lower-third
/// overlay and props layer. This is the "CLEAR ALL" semantic — one atomic
/// reset across all presentation channels. Settings (theme/background/blank)
/// are intentionally preserved. Propagates persistence failure (cleared props
/// must survive a restart) back to the operator instead of silently clearing.
#[tauri::command]
pub async fn clear_all(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    remote_clear_all(&app, &state, None)
}

#[tauri::command]
pub async fn update_timer(app: AppHandle, state: State<'_, AppState>, started_at: Option<u64>) -> Result<(), String> {
    let _guard = state.presentation.lock.lock();
    state.presentation.bump_revision();
    let mut live = state.presentation.live_item.lock();
    if let Some(store::DisplayItem::Timer(ref mut t)) = *live {
        t.started_at = started_at;
        let item = live.clone();
        drop(live);
        let update = LiveItemUpdate {
            detected_item: item.clone(),
            revision: Some(state.presentation.current_revision()),
        };
        emit_checked(&app, "live-item-update", &update);
        state.remote.hub.publish(
            RemoteEventKind::LiveChanged,
            json!({ "live_item": item }),
            None,
        );
    }
    Ok(())
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
    state.media_schedule.save_settings(&settings).map_err(|e| e.to_string())?;
    let (prev_blanked, prev_logo) = {
        let guard = state.presentation.settings.lock();
        (guard.is_blanked, guard.show_background_logo)
    };
    state.presentation.bump_revision();
    *state.presentation.settings.lock() = settings.clone();
    emit_checked(&app, "settings-changed", &settings);
    if prev_blanked != settings.is_blanked {
        state.remote.hub.publish(
            RemoteEventKind::BlackoutChanged,
            json!({ "blackout": settings.is_blanked }),
            None,
        );
    }
    if prev_logo != settings.show_background_logo {
        state.remote.hub.publish(
            RemoteEventKind::LogoChanged,
            json!({ "logo": settings.show_background_logo }),
            None,
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    // The display mutations are covered by the transactional frontend tests
    // (npm run test) plus the remote `commands` unit tests.
}