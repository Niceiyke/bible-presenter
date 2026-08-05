use crate::state::AppState;
use crate::store;
use tauri::State;

#[tauri::command]
pub async fn list_studio_presentations(state: State<'_, AppState>) -> Result<Vec<store::PresentationSummary>, String> {
    state.media_schedule.list_studio_presentations().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_studio_presentation(state: State<'_, AppState>, presentation: store::CustomPresentation) -> Result<(), String> {
    state.media_schedule.save_studio_presentation(&presentation).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_studio_presentation(state: State<'_, AppState>, id: String) -> Result<store::CustomPresentation, String> {
    state.media_schedule.load_studio_presentation(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_studio_presentation(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.media_schedule.delete_studio_presentation(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_slide_templates(state: State<'_, AppState>) -> Result<Vec<store::SlideTemplate>, String> {
    state.media_schedule.list_templates().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_slide_template(state: State<'_, AppState>, template: store::SlideTemplate) -> Result<store::SlideTemplate, String> {
    state.media_schedule.save_template(template).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_slide_template(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.media_schedule.delete_template(&id).map_err(|e| e.to_string())
}
