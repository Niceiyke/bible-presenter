use crate::engine::{self, Engine};
use crate::events::ScenePayload;
use crate::state::AppState;
use crate::store::{DisplayItem, Scene, SceneLayout};
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn list_scenes(state: State<'_, AppState>) -> Result<Vec<Scene>, String> {
    state.media_schedule.list_scenes().map_err(|e| e.to_string())
}

/// Free plan stores up to 3 scenes; paid plans are unlimited. The cap applies
/// only when CREATING a scene — updating an existing one is always allowed.
fn scene_save_allowed(
    status: crate::license::LicenseStatus,
    tier: crate::license::LicenseTier,
    existing_count: usize,
    is_update: bool,
) -> Result<(), String> {
    if is_update {
        return Ok(());
    }
    if status == crate::license::LicenseStatus::Active && tier == crate::license::LicenseTier::Free
        && existing_count >= 3
    {
        return Err(
            "The Free plan stores up to 3 scenes. Upgrade in Settings → License for unlimited scenes."
                .to_owned(),
        );
    }
    Ok(())
}

fn check_scene_cap(state: &State<'_, AppState>, is_update: bool) -> Result<(), String> {
    let info = state.license.status();
    let count = state.media_schedule.list_scenes().map_err(|e| e.to_string())?.len();
    scene_save_allowed(info.status, info.tier, count, is_update)
}

#[tauri::command]
pub async fn save_scene(state: State<'_, AppState>, scene: Scene) -> Result<Scene, String> {
    check_scene_cap(&state, !scene.id.is_empty())?;
    state.media_schedule.save_scene(scene).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_scene(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.media_schedule.delete_scene(&id).map_err(|e| e.to_string())
}

/// Recall a scene: apply its settings, props, (optional) lower-third, and
/// composition to the live presentation state and broadcast everything in one
/// shot. Delegates to the engine's `op_apply_scene`, which runs the whole
/// application as ONE logical mutation (single lock, single revision bump),
/// compensates persistence failures, stages/commits the composition (or
/// restores the legacy camera), and returns the applied payload so the
/// frontend can mirror it immediately without waiting for events to
/// round-trip.
#[tauri::command]
pub async fn apply_scene(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<ScenePayload, String> {
    // Applying a scene drives the on-air broadcast path — a scene cannot be
    // recalled onto the projection while the license is not active.
    crate::license::ensure_allowed(&state)?;
    let sink = engine::app_emit_sink(&app);
    let engine = Engine { state: &*state, emit: &sink };
    engine
        .op_apply_scene(id)
        .map(|r| r.scene.expect("apply_scene always returns the applied scene"))
}

/// Capture the current live state as a new scene. Convenience for the
/// "Save current state as scene" button. `camera` is the live camera feed
/// (if any) that should be restored when the scene is applied. When the live
/// item is itself a `SceneComposition`, its zones are captured as the scene's
/// layout so re-applying reproduces the exact split-screen composition.
#[tauri::command]
pub async fn capture_scene(state: State<'_, AppState>, name: String, camera: Option<DisplayItem>) -> Result<Scene, String> {
    check_scene_cap(&state, false)?;
    let settings = state.presentation.settings.lock().clone();
    let props = state.presentation.props_layer.lock().clone();
    let lt = state.presentation.lower_third.lock().clone();
    let (lower_third_data, lower_third_template) = if let Some(lt_val) = lt {
        let data = lt_val.get("data").cloned()
            .and_then(|v| serde_json::from_value::<crate::store::LowerThirdData>(v).ok());
        let template = lt_val.get("template").cloned();
        (data, template)
    } else {
        (None, None)
    };

    // If the live item is a composition, capture its zones as the layout.
    let mut layout = None;
    if let Some(DisplayItem::SceneComposition(comp)) = state.presentation.live_item.lock().clone() {
        layout = Some(SceneLayout { zones: comp.zones });
    }

    let scene = Scene {
        id: String::new(),
        name,
        settings,
        props,
        lower_third_data,
        lower_third_template,
        camera,
        layout,
        created_at: 0,
    };
    state.media_schedule.save_scene(scene).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACTIVE: crate::license::LicenseStatus = crate::license::LicenseStatus::Active;

    #[test]
    fn create_at_cap_is_rejected_on_free() {
        assert!(scene_save_allowed(ACTIVE, crate::license::LicenseTier::Free, 3, false).is_err());
        assert!(scene_save_allowed(ACTIVE, crate::license::LicenseTier::Free, 2, false).is_ok());
    }

    #[test]
    fn update_at_cap_is_allowed_on_free() {
        // Editing an existing scene must never be blocked at the 3-scene cap.
        assert!(scene_save_allowed(ACTIVE, crate::license::LicenseTier::Free, 3, true).is_ok());
        assert!(scene_save_allowed(ACTIVE, crate::license::LicenseTier::Free, 10, true).is_ok());
    }

    #[test]
    fn paid_tiers_ignore_the_cap() {
        assert!(scene_save_allowed(ACTIVE, crate::license::LicenseTier::Pro, 3, false).is_ok());
        assert!(scene_save_allowed(ACTIVE, crate::license::LicenseTier::Premium, 3, false).is_ok());
    }
}
