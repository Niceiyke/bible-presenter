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

/// Authoritative presentation snapshot for window hydration. Windows call
/// `presentation_snapshot` after registering their event listeners and replay
/// their buffered events on top of it, so a reopening window converges to the
/// same state as the operator console.
#[derive(Clone, Serialize)]
pub struct PresentationSnapshot {
    pub live: Option<store::DisplayItem>,
    pub staged: Option<store::DisplayItem>,
    pub settings: store::PresentationSettings,
    pub lower_third: Option<serde_json::Value>,
    pub props: Vec<store::PropItem>,
    pub revision: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputBusItemUpdate {
    bus_id: String,
    item: Option<store::DisplayItem>,
    revision: u64,
}

fn snapshot_for(presentation: &crate::state::PresentationState) -> PresentationSnapshot {
    let _guard = presentation.lock.lock();
    PresentationSnapshot {
        live: presentation.live_item.lock().clone(),
        staged: presentation.staged_item.lock().clone(),
        settings: presentation.settings.lock().clone(),
        lower_third: presentation.lower_third.lock().clone(),
        props: presentation.props_layer.lock().clone(),
        revision: presentation.current_revision(),
    }
}

fn auxiliary_bus(
    state: &AppState,
    bus_id: &str,
) -> Result<crate::state::PresentationState, String> {
    if bus_id == crate::output_buses::PRIMARY_BUS_ID {
        return Err("Use the primary presentation commands for the primary output bus.".into());
    }
    state
        .output_buses
        .auxiliary_presentation(bus_id)
        .ok_or_else(|| format!("Output bus '{bus_id}' is not configured."))
}

/// The first multi-output slice intentionally supports only self-contained
/// program content. Cameras, scenes, timers, and lower-thirds still depend on
/// primary-only transport/overlay systems and must not silently appear on a
/// secondary projection.
fn ensure_auxiliary_item_supported(item: &store::DisplayItem) -> Result<(), String> {
    match item {
        store::DisplayItem::Verse(_)
        | store::DisplayItem::Media(_)
        | store::DisplayItem::CustomSlide(_) => Ok(()),
        store::DisplayItem::Song(song) if song.style.as_deref() != Some("LowerThird") => Ok(()),
        _ => Err(
            "Independent outputs currently support Bible, full-slide songs, local media, and Studio presentations. Lower thirds, cameras, scenes, and timers remain on the primary output.".into(),
        ),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageVerseResult {
    pub item: store::DisplayItem,
    pub splits: Vec<store::Verse>,
}

#[tauri::command]
pub async fn presentation_snapshot(
    state: State<'_, AppState>,
) -> Result<PresentationSnapshot, String> {
    Ok(snapshot_for(&state.presentation))
}

/// Hydrate an auxiliary output window from its own live/staged state. The
/// primary bus deliberately continues using `presentation_snapshot` so existing
/// output, stage, capture, remote, and recording paths stay compatible.
#[tauri::command]
pub async fn output_bus_snapshot(
    state: State<'_, AppState>,
    bus_id: String,
) -> Result<PresentationSnapshot, String> {
    Ok(snapshot_for(&auxiliary_bus(&state, &bus_id)?))
}

#[tauri::command]
pub async fn output_bus_stage_item(
    app: AppHandle,
    state: State<'_, AppState>,
    bus_id: String,
    item: store::DisplayItem,
) -> Result<(), String> {
    crate::license::ensure_active_tier(&state, crate::license::LicenseTier::Pro)?;
    crate::license::ensure_display_item_allowed(&state, &item)?;
    ensure_auxiliary_item_supported(&item)?;
    let presentation = auxiliary_bus(&state, &bus_id)?;
    let _guard = presentation.lock.lock();
    *presentation.staged_item.lock() = Some(item.clone());
    let revision = presentation.bump_revision();
    emit_checked(
        &app,
        "output-bus-item-staged",
        &OutputBusItemUpdate {
            bus_id,
            item: Some(item),
            revision,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn output_bus_commit_staged(
    app: AppHandle,
    state: State<'_, AppState>,
    bus_id: String,
) -> Result<Option<store::DisplayItem>, String> {
    crate::license::ensure_active_tier(&state, crate::license::LicenseTier::Pro)?;
    let presentation = auxiliary_bus(&state, &bus_id)?;
    let _guard = presentation.lock.lock();
    let item = presentation.staged_item.lock().clone();
    if let Some(item) = &item {
        crate::license::ensure_display_item_allowed(&state, item)?;
        ensure_auxiliary_item_supported(item)?;
    }
    *presentation.live_item.lock() = item.clone();
    *presentation.staged_item.lock() = None;
    let revision = presentation.bump_revision();
    emit_checked(
        &app,
        "output-bus-live-item-update",
        &OutputBusItemUpdate {
            bus_id: bus_id.clone(),
            item: item.clone(),
            revision,
        },
    );
    emit_checked(
        &app,
        "output-bus-item-staged",
        &OutputBusItemUpdate {
            bus_id,
            item: None,
            revision,
        },
    );
    Ok(item)
}

#[tauri::command]
pub async fn output_bus_send_live_item(
    app: AppHandle,
    state: State<'_, AppState>,
    bus_id: String,
    item: store::DisplayItem,
) -> Result<store::DisplayItem, String> {
    crate::license::ensure_active_tier(&state, crate::license::LicenseTier::Pro)?;
    crate::license::ensure_display_item_allowed(&state, &item)?;
    ensure_auxiliary_item_supported(&item)?;
    let presentation = auxiliary_bus(&state, &bus_id)?;
    let _guard = presentation.lock.lock();
    *presentation.live_item.lock() = Some(item.clone());
    *presentation.staged_item.lock() = None;
    let revision = presentation.bump_revision();
    emit_checked(
        &app,
        "output-bus-live-item-update",
        &OutputBusItemUpdate {
            bus_id: bus_id.clone(),
            item: Some(item.clone()),
            revision,
        },
    );
    emit_checked(
        &app,
        "output-bus-item-staged",
        &OutputBusItemUpdate {
            bus_id,
            item: None,
            revision,
        },
    );
    Ok(item)
}

#[tauri::command]
pub async fn output_bus_clear(
    app: AppHandle,
    state: State<'_, AppState>,
    bus_id: String,
) -> Result<(), String> {
    crate::license::ensure_active_tier(&state, crate::license::LicenseTier::Pro)?;
    let presentation = auxiliary_bus(&state, &bus_id)?;
    let _guard = presentation.lock.lock();
    *presentation.live_item.lock() = None;
    *presentation.staged_item.lock() = None;
    let revision = presentation.bump_revision();
    emit_checked(
        &app,
        "output-bus-live-item-update",
        &OutputBusItemUpdate {
            bus_id: bus_id.clone(),
            item: None,
            revision,
        },
    );
    emit_checked(
        &app,
        "output-bus-item-staged",
        &OutputBusItemUpdate {
            bus_id,
            item: None,
            revision,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn output_bus_clear_staged(
    app: AppHandle,
    state: State<'_, AppState>,
    bus_id: String,
) -> Result<(), String> {
    crate::license::ensure_active_tier(&state, crate::license::LicenseTier::Pro)?;
    let presentation = auxiliary_bus(&state, &bus_id)?;
    let _guard = presentation.lock.lock();
    *presentation.staged_item.lock() = None;
    let revision = presentation.bump_revision();
    emit_checked(
        &app,
        "output-bus-item-staged",
        &OutputBusItemUpdate {
            bus_id,
            item: None,
            revision,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn output_bus_clear_live(
    app: AppHandle,
    state: State<'_, AppState>,
    bus_id: String,
) -> Result<(), String> {
    crate::license::ensure_active_tier(&state, crate::license::LicenseTier::Pro)?;
    let presentation = auxiliary_bus(&state, &bus_id)?;
    let _guard = presentation.lock.lock();
    *presentation.live_item.lock() = None;
    let revision = presentation.bump_revision();
    emit_checked(
        &app,
        "output-bus-live-item-update",
        &OutputBusItemUpdate {
            bus_id,
            item: None,
            revision,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn stage_item(
    app: AppHandle,
    state: State<'_, AppState>,
    item: store::DisplayItem,
) -> Result<(), String> {
    crate::license::ensure_display_item_allowed(&state, &item)?;
    remote_stage(&app, &state, item, None, 0);
    Ok(())
}

/// Split and stage a verse in one backend round trip. AI auto-staging uses this
/// path so the first preview does not wait for a separate `split_verse` IPC.
/// Returning every split preserves the frontend's next/previous split cache.
#[tauri::command]
pub async fn stage_verse(
    app: AppHandle,
    state: State<'_, AppState>,
    verse: store::Verse,
    auto_split: bool,
    threshold: Option<usize>,
) -> Result<StageVerseResult, String> {
    crate::license::ensure_core_activated(&state)?;
    let splits = if auto_split {
        crate::commands::bible::split_verse(verse.clone(), threshold)
    } else {
        vec![verse.clone()]
    };
    let staged_verse = splits.first().cloned().unwrap_or(verse);
    let item = store::DisplayItem::Verse(staged_verse);
    remote_stage(&app, &state, item.clone(), None, 0);
    Ok(StageVerseResult { item, splits })
}

/// Atomically copy the staged slot into the live slot and broadcast the
/// update. Replaces the old `go_live` (which released the staged lock before
/// re-acquiring the live lock, opening a TOCTOU window). Returns the new
/// live item so callers can confirm the commit succeeded.
#[tauri::command]
pub async fn commit_staged(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<store::DisplayItem>, String> {
    if let Some(item) = state.presentation.staged_item.lock().clone() {
        crate::license::ensure_display_item_allowed(&state, &item)?;
    } else {
        crate::license::ensure_core_activated(&state)?;
    }
    Ok(remote_commit_staged(&app, &state, None))
}

/// Legacy `go_live` — kept for backwards compatibility but now delegates to
/// `commit_staged`. Returns Ok(()) regardless of whether anything was staged
/// (matching historical behaviour).
#[tauri::command]
pub async fn go_live(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(item) = state.presentation.staged_item.lock().clone() {
        crate::license::ensure_display_item_allowed(&state, &item)?;
    } else {
        crate::license::ensure_core_activated(&state)?;
    }
    remote_commit_staged(&app, &state, None);
    Ok(())
}

/// Atomic stage-and-commit in one transaction: stages `item` and immediately
/// takes it live under a single presentation lock, so no concurrent caller can
/// commit a different item in between. The frontend `sendLive` uses this
/// instead of two separate IPC invokes (audit: concurrent stage/send-live).
#[tauri::command]
pub async fn send_live_item(
    app: AppHandle,
    state: State<'_, AppState>,
    item: store::DisplayItem,
) -> Result<store::DisplayItem, String> {
    crate::license::ensure_display_item_allowed(&state, &item)?;
    op_send_live(&app, &state, item, None)
}

#[tauri::command]
pub async fn go_live_item(
    app: AppHandle,
    state: State<'_, AppState>,
    item: store::DisplayItem,
) -> Result<(), String> {
    crate::license::ensure_display_item_allowed(&state, &item)?;
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
pub async fn update_timer(
    app: AppHandle,
    state: State<'_, AppState>,
    started_at: Option<u64>,
) -> Result<(), String> {
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
pub async fn get_current_item(
    state: State<'_, AppState>,
) -> Result<Option<store::DisplayItem>, String> {
    Ok(state.presentation.live_item.lock().clone())
}

#[tauri::command]
pub async fn get_staged_item(
    state: State<'_, AppState>,
) -> Result<Option<store::DisplayItem>, String> {
    Ok(state.presentation.staged_item.lock().clone())
}

#[tauri::command]
pub async fn get_settings(
    state: State<'_, AppState>,
) -> Result<store::PresentationSettings, String> {
    Ok(state.presentation.settings.lock().clone())
}

#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: store::PresentationSettings,
) -> Result<(), String> {
    // Entitlement service controls the enabled-translation capacity. Enforce it
    // here so a modified frontend or direct IPC cannot bypass plan limits.
    let info = state.license.status();
    if info.status == crate::license::LicenseStatus::Active {
        let available = state.store.get_available_versions();
        let disabled = settings
            .disabled_bible_versions
            .iter()
            .map(|s| s.as_str())
            .collect::<std::collections::HashSet<_>>();
        let enabled = available
            .iter()
            .filter(|v| !disabled.contains(v.as_str()))
            .count();
        if enabled > info.limits.max_bible_versions as usize {
            return Err(
                format!(
                    "Your Wordlyte plan enables up to {} Bible version(s). Disable another version first or ask your organization owner to upgrade.",
                    info.limits.max_bible_versions
                ),
            );
        }
    }
    state
        .media_schedule
        .save_settings(&settings)
        .map_err(|e| e.to_string())?;
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
