use crate::state::AppState;
use crate::events::{emit_checked, LiveItemUpdate};
use crate::store;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn stage_item(app: AppHandle, state: State<'_, AppState>, item: store::DisplayItem) -> Result<(), String> {
    *state.presentation.staged_item.lock() = Some(item.clone());
    emit_checked(&app, "item-staged", &item);
    Ok(())
}

/// Atomically copy the staged slot into the live slot and broadcast the
/// update. Replaces the old `go_live` (which released the staged lock before
/// re-acquiring the live lock, opening a TOCTOU window). Returns the new
/// live item so callers can confirm the commit succeeded.
#[tauri::command]
pub async fn commit_staged(app: AppHandle, state: State<'_, AppState>) -> Result<Option<store::DisplayItem>, String> {
    // Acquire both locks in a single short critical section. Order: live then
    // staged — stable across all commands to avoid deadlock.
    let mut live = state.presentation.live_item.lock();
    let staged = state.presentation.staged_item.lock().clone();
    *live = staged.clone();
    drop(live);

    let update = LiveItemUpdate { detected_item: staged.clone() };
    emit_checked(&app, "live-item-update", &update);
    Ok(staged)
}

/// Legacy `go_live` — kept for backwards compatibility but now delegates to
/// `commit_staged`. Returns Ok(()) regardless of whether anything was staged
/// (matching historical behaviour).
#[tauri::command]
pub async fn go_live(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    commit_staged(app, state).await?;
    Ok(())
}

#[tauri::command]
pub async fn go_live_item(app: AppHandle, state: State<'_, AppState>, item: store::DisplayItem) -> Result<(), String> {
    *state.presentation.live_item.lock() = Some(item.clone());
    let update = LiveItemUpdate { detected_item: Some(item) };
    emit_checked(&app, "live-item-update", &update);
    Ok(())
}

/// Clear the live slot only. Staged slot is preserved so the operator can
/// re-send the same item. Emits both `live-item-update` and `item-staged`
/// (with the unchanged staged value) so windows stay consistent.
#[tauri::command]
pub async fn clear_live(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    *state.presentation.live_item.lock() = None;
    let update = LiveItemUpdate { detected_item: None };
    emit_checked(&app, "live-item-update", &update);
    // Re-broadcast staged so listeners can reconcile (the previous impl
    // emitted a dead `stage-update` event instead of `item-staged`).
    let staged = state.presentation.staged_item.lock().clone();
    emit_checked(&app, "item-staged", &staged);
    Ok(())
}

/// Clear everything the audience can see: live item, staged item, lower-third
/// overlay and props layer. This is the "CLEAR ALL" semantic — one atomic
/// reset across all presentation channels. Settings (theme/background/blank)
/// are intentionally preserved.
#[tauri::command]
pub async fn clear_all(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    *state.presentation.live_item.lock() = None;
    *state.presentation.staged_item.lock() = None;
    *state.presentation.lower_third.lock() = None;
    state.presentation.props_layer.lock().clear();

    emit_checked(&app, "live-item-update", &LiveItemUpdate { detected_item: None });
    emit_checked(&app, "item-staged", &Option::<store::DisplayItem>::None);
    emit_checked(&app, "lower-third-update", &Option::<serde_json::Value>::None);
    emit_checked(&app, "props-update", &Vec::<store::PropItem>::new());
    Ok(())
}

#[tauri::command]
pub async fn update_timer(app: AppHandle, state: State<'_, AppState>, started_at: Option<u64>) -> Result<(), String> {
    let mut live = state.presentation.live_item.lock();
    if let Some(store::DisplayItem::Timer(ref mut t)) = *live {
        t.started_at = started_at;
        let item = live.clone();
        drop(live);
        let update = LiveItemUpdate { detected_item: Some(item) };
        emit_checked(&app, "live-item-update", &update);
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
    *state.presentation.settings.lock() = settings.clone();
    emit_checked(&app, "settings-changed", &settings);
    Ok(())
}
