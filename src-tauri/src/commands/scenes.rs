use crate::state::AppState;
use crate::store::{DisplayItem, Scene, SceneCompositionData, SceneLayout};
use crate::events::{emit_checked, ScenePayload};
use crate::remote::commands::op_go_live_item;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn list_scenes(state: State<'_, AppState>) -> Result<Vec<Scene>, String> {
    state.media_schedule.list_scenes().map_err(|e| e.to_string())
}

/// Free plan stores up to 3 scenes; paid plans are unlimited.
fn check_scene_cap(state: &State<'_, AppState>) -> Result<(), String> {
    let info = state.license.status();
    if info.status == crate::license::LicenseStatus::Active
        && info.tier == crate::license::LicenseTier::Free
    {
        let count = state.media_schedule.list_scenes().map_err(|e| e.to_string())?.len();
        if count >= 3 {
            return Err(
                "The Free plan stores up to 3 scenes. Upgrade in Settings → License for unlimited scenes."
                    .to_owned(),
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn save_scene(state: State<'_, AppState>, scene: Scene) -> Result<Scene, String> {
    check_scene_cap(&state)?;
    state.media_schedule.save_scene(scene).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_scene(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.media_schedule.delete_scene(&id).map_err(|e| e.to_string())
}

/// Recall a scene: apply its settings, props, (optional) lower-third, and
/// composition to the live presentation state and broadcast everything in one
/// shot. When the scene carries a `layout`, a `SceneComposition` display item
/// is staged/committed so the output window composites its zones. The caller
/// receives the applied payload so the frontend can mirror it immediately
/// without waiting for events to round-trip.
#[tauri::command]
pub async fn apply_scene(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<ScenePayload, String> {
    // Applying a scene drives the on-air broadcast path — a scene cannot be
    // recalled onto the projection while the license is not active.
    crate::license::ensure_allowed(&state)?;
    let scene = state.media_schedule.list_scenes().map_err(|e| e.to_string())?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("Scene '{}' not found", id))?;

    // Apply settings/props/lower-third under the presentation mutation lock so
    // the snapshot is never half-updated, and persist BEFORE mutating so a
    // write failure surfaces instead of silently applying state that would be
    // lost on restart. The revision bump makes stale remote clients
    // resynchronize.
    {
        let _guard = state.presentation.lock.lock();
        state.media_schedule.save_settings(&scene.settings).map_err(|e| e.to_string())?;
        *state.presentation.settings.lock() = scene.settings.clone();
        state.media_schedule.save_props(&scene.props).map_err(|e| e.to_string())?;
        *state.presentation.props_layer.lock() = scene.props.clone();
        if let (Some(data), Some(template)) = (&scene.lower_third_data, &scene.lower_third_template) {
            let payload = serde_json::json!({ "data": data, "template": template });
            *state.presentation.lower_third.lock() = Some(payload.clone());
        } else {
            *state.presentation.lower_third.lock() = None;
        }
        state.presentation.bump_revision();
    }
    emit_checked(&app, "settings-changed", &scene.settings);
    emit_checked(&app, "props-update", &scene.props);
    if let (Some(data), Some(template)) = (&scene.lower_third_data, &scene.lower_third_template) {
        let payload = serde_json::json!({ "data": data, "template": template });
        emit_checked(&app, "lower-third-update", &Some(payload));
    } else {
        emit_checked(&app, "lower-third-update", &Option::<serde_json::Value>::None);
    }

    // Composition: stage + commit the multi-zone layout as a display item.
    if let Some(layout) = &scene.layout {
        let item = DisplayItem::SceneComposition(SceneCompositionData {
            scene_id: scene.id.clone(),
            name: scene.name.clone(),
            zones: layout.zones.clone(),
        });
        let _ = crate::remote::commands::op_send_live(&app, &state, item, None);
    } else if let Some(cam) = &scene.camera {
        // Legacy single-camera scene: restore the camera feed that was live
        // at capture time.
        op_go_live_item(&app, &state, cam.clone(), None);
    }

    Ok(ScenePayload {
        id: scene.id,
        name: scene.name,
        settings: scene.settings,
        props: scene.props,
        lower_third_data: scene.lower_third_data,
        lower_third_template: scene.lower_third_template,
        camera: scene.camera,
        layout: scene.layout,
    })
}

/// Capture the current live state as a new scene. Convenience for the
/// "Save current state as scene" button. `camera` is the live camera feed
/// (if any) that should be restored when the scene is applied. When the live
/// item is itself a `SceneComposition`, its zones are captured as the scene's
/// layout so re-applying reproduces the exact split-screen composition.
#[tauri::command]
pub async fn capture_scene(state: State<'_, AppState>, name: String, camera: Option<DisplayItem>) -> Result<Scene, String> {
    check_scene_cap(&state)?;
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
