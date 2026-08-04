use crate::state::AppState;
use crate::events::TranscriptionUpdate;
use crate::store;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn stage_item(app: AppHandle, state: State<'_, AppState>, item: store::DisplayItem) -> Result<(), String> {
    *state.presentation.staged_item.lock() = Some(item.clone());
    let _ = app.emit("item-staged", &item);
    let _ = app.emit("stage-update", Some(&item));
    Ok(())
}

#[tauri::command]
pub async fn go_live(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let staged = state.presentation.staged_item.lock().clone();
    if let Some(item) = staged {
        go_live_item(app, state, item).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn go_live_item(app: AppHandle, state: State<'_, AppState>, item: store::DisplayItem) -> Result<(), String> {
    *state.presentation.live_item.lock() = Some(item.clone());

    let mut is_media = false;
    if let store::DisplayItem::Media(ref m) = item {
        if matches!(m.media_type, store::MediaItemType::Video) { is_media = true; }
    }
    state.audio.operator.lock().media_playing.store(is_media, Ordering::Relaxed);
    state.audio.preacher.lock().media_playing.store(is_media, Ordering::Relaxed);

    let update = TranscriptionUpdate {
        text: item.to_label(),
        detected_item: Some(item.clone()),
        confidence: 1.0,
        source: "manual".to_string(),
        is_partial: false,
    };
    let _ = app.emit("operator-transcription-update", &update);
    let _ = app.emit("preacher-transcription-update", &update);
    Ok(())
}

#[tauri::command]
pub async fn clear_live(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    *state.presentation.live_item.lock() = None;
    state.audio.operator.lock().media_playing.store(false, Ordering::Relaxed);
    state.audio.preacher.lock().media_playing.store(false, Ordering::Relaxed);
    let update = TranscriptionUpdate {
        text: "".to_string(),
        detected_item: None,
        confidence: 1.0,
        source: "manual".to_string(),
        is_partial: false,
    };
    let _ = app.emit("operator-transcription-update", &update);
    let _ = app.emit("preacher-transcription-update", &update);
    let _ = app.emit("stage-update", Option::<store::DisplayItem>::None);
    Ok(())
}

#[tauri::command]
pub async fn update_timer(app: AppHandle, state: State<'_, AppState>, started_at: Option<u64>) -> Result<(), String> {
    let mut live = state.presentation.live_item.lock();
    if let Some(store::DisplayItem::Timer(ref mut t)) = *live {
        t.started_at = started_at;
        let item = live.clone().unwrap();
        drop(live);
        let update = TranscriptionUpdate {
            text: item.to_label(),
            detected_item: Some(item),
            confidence: 1.0,
            source: "manual".to_string(),
            is_partial: false,
        };
        let _ = app.emit("operator-transcription-update", &update);
        let _ = app.emit("preacher-transcription-update", &update);
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
    let _ = app.emit("settings-changed", settings);
    Ok(())
}
