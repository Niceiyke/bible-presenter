use crate::remote::commands::{op_clear_all as remote_clear_all, op_clear_live as remote_clear_live, op_commit_staged as remote_commit_staged, op_go_live_item, op_stage as remote_stage};
use crate::remote::protocol::RemoteEventKind;
use crate::state::AppState;
use crate::events::{emit_checked, LiveItemUpdate};
use crate::store;
use serde_json::json;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn stage_item(app: AppHandle, state: State<'_, AppState>, item: store::DisplayItem) -> Result<(), String> {
    remote_stage(&app, &state, item, None, 0);
    Ok(())
}

/// Atomically copy the staged slot into the live slot and broadcast the
/// update. Replaces the old `go_live` (which released the staged lock before
/// re-acquiring the live lock, opening a TOCTOU window). Returns the new
/// live item so callers can confirm the commit succeeded.
#[tauri::command]
pub async fn commit_staged(app: AppHandle, state: State<'_, AppState>) -> Result<Option<store::DisplayItem>, String> {
    Ok(remote_commit_staged(&app, &state, None))
}

/// Legacy `go_live` — kept for backwards compatibility but now delegates to
/// `commit_staged`. Returns Ok(()) regardless of whether anything was staged
/// (matching historical behaviour).
#[tauri::command]
pub async fn go_live(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    remote_commit_staged(&app, &state, None);
    Ok(())
}

#[tauri::command]
pub async fn go_live_item(app: AppHandle, state: State<'_, AppState>, item: store::DisplayItem) -> Result<(), String> {
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

/// Clear everything the audience can see: live item, staged item, lower-third
/// overlay and props layer. This is the "CLEAR ALL" semantic — one atomic
/// reset across all presentation channels. Settings (theme/background/blank)
/// are intentionally preserved.
#[tauri::command]
pub async fn clear_all(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    remote_clear_all(&app, &state, None);
    Ok(())
}

#[tauri::command]
pub async fn update_timer(app: AppHandle, state: State<'_, AppState>, started_at: Option<u64>) -> Result<(), String> {
    let mut live = state.presentation.live_item.lock();
    if let Some(store::DisplayItem::Timer(ref mut t)) = *live {
        t.started_at = started_at;
        let item = live.clone();
        drop(live);
        emit_checked(&app, "live-item-update", &LiveItemUpdate { detected_item: item.clone() });
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
    let prev_blanked = {
        let guard = state.presentation.settings.lock();
        let prev = guard.is_blanked;
        drop(guard);
        prev
    };
    *state.presentation.settings.lock() = settings.clone();
    emit_checked(&app, "settings-changed", &settings);
    if prev_blanked != settings.is_blanked {
        state.remote.hub.publish(
            RemoteEventKind::BlackoutChanged,
            json!({ "blackout": settings.is_blanked }),
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