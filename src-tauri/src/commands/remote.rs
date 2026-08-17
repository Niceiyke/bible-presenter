use crate::events::emit_checked;
use crate::remote::protocol::{RemoteControllerState, RemotePermissions, RemoteRole};
use crate::remote::{public_urls, PhoneCameraInfo, RemoteControl};
use crate::state::AppState;
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, State};

/// Operator-facing list of connected phone cameras (Camera tab). Each entry's
/// `device_id` is the prefixed id ("phone-camera-...") used as the DisplayItem
/// device id.
#[tauri::command]
pub async fn list_phone_cameras(state: State<'_, AppState>) -> Result<Vec<PhoneCameraInfo>, String> {
    Ok(state.remote.clone().list_phone_cameras().await)
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteDeviceInfo {
    pub id: String,
    pub name: String,
    pub role: RemoteRole,
    pub permissions: RemotePermissions,
    pub paired_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<u64>,
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteStatusInfo {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    pub urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pairing_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pairing_expires_at: Option<u64>,
    pub devices: Vec<RemoteDeviceInfo>,
    pub controller_state: RemoteControllerState,
    pub revision: u64,
    /// Idle auto-revoke threshold in hours (`None` = disabled).
    pub auto_revoke_hours: Option<u32>,
}

fn status_info(control: &RemoteControl, pairing_code: Option<String>) -> RemoteStatusInfo {
    let addr: Option<SocketAddr> = control.bound_addr();
    let connected_ids: Vec<String> = control
        .sessions
        .list()
        .into_iter()
        .map(|d| d.device_id)
        .collect();

    let devices = control
        .tokens
        .list_devices()
        .into_iter()
        .map(|d| RemoteDeviceInfo {
            id: d.id.clone(),
            name: d.name.clone(),
            role: d.role.clone(),
            permissions: d.permissions,
            paired_at: d.paired_at,
            last_seen_at: d.last_seen_at,
            connected: connected_ids.contains(&d.id),
        })
        .collect();

    RemoteStatusInfo {
        enabled: control.is_enabled(),
        port: addr.map(|a| a.port()),
        urls: addr
            .map(|a| public_urls(&control.files_dir, &a))
            .unwrap_or_default(),
        pairing_code,
        pairing_expires_at: control.pairing_expires_at(),
        devices,
        controller_state: control.lease.state(),
        revision: control.hub.current_revision(),
        auto_revoke_hours: control.auto_revoke_hours(),
    }
}

/// Notifies the operator shell that a device connected/disconnected/was
/// revoked so it can show a toast and refresh its device count.
fn emit_device_event(app: &AppHandle, event: &str, device_name: String) {
    emit_checked(
        app,
        "remote-device-event",
        &serde_json::json!({ "event": event, "device_name": device_name }),
    );
}

#[tauri::command]
pub async fn remote_enable(app: AppHandle, state: State<'_, AppState>) -> Result<RemoteStatusInfo, String> {
    crate::license::ensure_allowed(&state)?;
    crate::license::ensure_active_tier(&state, crate::license::LicenseTier::Pro)?;
    let control = state.remote.clone();

    // Serialize the whole enable path so two rapid clicks can't double-bind
    // the listener. A second caller sees `enabled == true` and short-circuits.
    let _guard = control.start_lock.lock().await;

    if control.is_enabled() {
        control.ensure_pairing();
        control.persist_devices();
        return Ok(status_info(&control, Some(control.token_for_display())));
    }

    let files_dir = control.files_dir.clone();
    if !files_dir.join("remote.html").exists() {
        return Err(
            "Remote Control web bundle not found. Build it first: run `npm run build` (creates dist/remote.html)."
                .into(),
        );
    }

    let pairing = control.ensure_pairing();
    let ctx = crate::remote::server::RemoteCtx {
        app: app.clone(),
        state: state.inner().clone(),
        control: control.clone(),
    };
    match crate::remote::server::start(ctx).await {
        Ok(addr) => {
            state.remote.persist_devices();
            crate::store::log_msg(&app, &format!("Remote Control enabled on {}", addr));
            Ok(status_info(&state.remote, Some(pairing)))
        }
        Err(e) => {
            // `start` only flips `enabled` on success, but make sure the
            // stale bound address (if any) is cleared and the lease released.
            *state.remote.bound_addr.lock() = None;
            crate::store::log_msg(&app, &format!("Remote Control failed to start: {}", e));
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn remote_disable(app: AppHandle, state: State<'_, AppState>) -> Result<RemoteStatusInfo, String> {
    if let Some(task) = state.remote.task.lock().take() {
        task.abort();
    }
    state.remote.enabled.store(false, Ordering::SeqCst);
    *state.remote.bound_addr.lock() = None;
    state.remote.sessions.clear();
    // Releasing the lease on disable means re-enabling starts with a clean
    // slate instead of resurrecting a stale controller lease.
    if let Some(holder) = state.remote.lease.holder_id() {
        state.remote.lease.release(&holder);
    }
    crate::store::log_msg(&app, "Remote Control disabled");
    Ok(status_info(&state.remote, None))
}

#[tauri::command]
pub async fn remote_status(state: State<'_, AppState>) -> Result<RemoteStatusInfo, String> {
    let control = state.remote.clone();
    if control.is_enabled() {
        // Sweep idle devices on every status poll so auto-revocation is
        // reflected promptly even if the periodic task is not running.
        control.sweep_idle_devices();
        control.ensure_pairing();
        Ok(status_info(&control, Some(control.token_for_display())))
    } else {
        Ok(status_info(&control, None))
    }
}

/// Sets (or clears, with `None`) the idle auto-revoke threshold in hours.
/// Paired devices that are neither connected nor seen for longer than the
/// threshold are revoked automatically.
#[tauri::command]
pub async fn remote_set_auto_revoke(app: AppHandle, state: State<'_, AppState>, hours: Option<u32>) -> Result<RemoteStatusInfo, String> {
    let control = state.remote.clone();
    control.set_auto_revoke_hours(hours);
    crate::store::log_msg(
        &app,
        &match hours {
            Some(h) => format!("Remote auto-revoke set to {} hours", h),
            None => "Remote auto-revoke disabled".to_string(),
        },
    );
    Ok(status_info(&control, control.is_enabled().then(|| control.token_for_display())))
}

/// Renames a paired device so the operator can identify it in the UI.
#[tauri::command]
pub async fn remote_rename_device(app: AppHandle, state: State<'_, AppState>, device_id: String, name: String) -> Result<RemoteStatusInfo, String> {
    let control = state.remote.clone();
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Device name cannot be empty".into());
    }
    if name.len() > 48 {
        return Err("Device name is too long (max 48 characters)".into());
    }
    if !control.tokens.rename_device(&device_id, name.clone()) {
        return Err(format!("No paired device with id {}", device_id));
    }
    control.persist_devices();
    crate::store::log_msg(&app, &format!("Remote device renamed to \"{}\"", name));
    Ok(status_info(&control, control.is_enabled().then(|| control.token_for_display())))
}

/// Regenerates the pairing code, invalidating any prior outstanding code.
#[tauri::command]
pub async fn remote_regenerate_pairing(app: AppHandle, state: State<'_, AppState>) -> Result<RemoteStatusInfo, String> {
    let control = state.remote.clone();
    let token = control.regenerate_pairing();
    crate::store::log_msg(&app, "Remote pairing code regenerated");
    Ok(status_info(&control, Some(token)))
}

#[tauri::command]
pub async fn remote_revoke_device(app: AppHandle, state: State<'_, AppState>, device_id: String) -> Result<RemoteStatusInfo, String> {
    let control = state.remote.clone();
    if control.lease.holder_id().as_deref() == Some(device_id.as_str()) {
        control.lease.revoke_for(&device_id);
        control.hub_publish_controller_changed();
    }
    control.sessions.disconnect(&device_id);
    let name = control.tokens.device(&device_id).map(|d| d.name).unwrap_or_else(|| device_id.clone());
    let revoked = control.tokens.revoke_device(&device_id);
    if revoked {
        control.persist_devices();
        emit_device_event(&app, "revoked", name);
    }
    crate::store::log_msg(&app, &format!("Remote device revoked: {}", device_id));
    Ok(status_info(&control, control.is_enabled().then(|| control.token_for_display())))
}

#[tauri::command]
pub async fn remote_revoke_all(app: AppHandle, state: State<'_, AppState>) -> Result<RemoteStatusInfo, String> {
    let control = state.remote.clone();
    let count = control.tokens.revoke_all();
    control.persist_devices();
    control.sessions.clear();
    if control.lease.holder_id().is_some() {
        let holder = control.lease.holder_id().unwrap_or_default();
        control.lease.release(&holder);
        control.hub_publish_controller_changed();
    }
    crate::store::log_msg(&app, &format!("All remote devices revoked ({} total)", count));
    Ok(status_info(&control, control.is_enabled().then(|| control.token_for_display())))
}

/// Desktop operator takes the controller lease back from any remote device.
#[tauri::command]
pub async fn remote_claim_control(app: AppHandle, state: State<'_, AppState>) -> Result<RemoteStatusInfo, String> {
    let control = state.remote.clone();
    if control.lease.holder_id().is_some() {
        let holder = control.lease.holder_id().unwrap_or_default();
        control.lease.release(&holder);
        control.hub_publish_controller_changed();
        control.hub.publish(
            crate::remote::protocol::RemoteEventKind::OperatorNotice,
            serde_json::json!({ "message": "The desktop operator took back control" }),
            None,
        );
        crate::store::log_msg(&app, "Desktop reclaims remote controller lease");
    }
    Ok(status_info(&control, control.is_enabled().then(|| control.token_for_display())))
}

/// Changes the role of a paired device (e.g. demote a volunteer to Viewer).
/// Takes effect immediately for the connected device: the dispatch gate reads
/// the live role from the token store on every command.
#[tauri::command]
pub async fn remote_set_role(app: AppHandle, state: State<'_, AppState>, device_id: String, role: RemoteRole) -> Result<RemoteStatusInfo, String> {
    let control = state.remote.clone();
    if !control.tokens.set_role(&device_id, role.clone()) {
        return Err(format!("No paired device with id {}", device_id));
    }
    control.persist_devices();

    // If the device was demoted to Viewer while holding control, revoke the
    // lease immediately so it cannot keep mutating until it expires.
    if role == RemoteRole::Viewer && control.lease.holder_id().as_deref() == Some(device_id.as_str()) {
        control.lease.revoke_for(&device_id);
        control.hub_publish_controller_changed();
    }

    crate::store::log_msg(&app, &format!("Remote device role updated: {} -> {:?}", device_id, role));
    Ok(status_info(&control, control.is_enabled().then(|| control.token_for_display())))
}

/// Overrides the content permissions of a paired device without changing its
/// role. Takes effect immediately for the connected device (the dispatch gate
/// reads live permissions from the token store on every command).
#[tauri::command]
pub async fn remote_set_permissions(app: AppHandle, state: State<'_, AppState>, device_id: String, permissions: RemotePermissions) -> Result<RemoteStatusInfo, String> {
    let control = state.remote.clone();
    if !control.tokens.set_permissions(&device_id, permissions) {
        return Err(format!("No paired device with id {}", device_id));
    }
    control.persist_devices();
    crate::store::log_msg(&app, &format!("Remote device permissions updated: {}", device_id));
    Ok(status_info(&control, control.is_enabled().then(|| control.token_for_display())))
}

/// The operator window relays its WebRTC answer back to the phone that owns the
/// given phone camera. `device_id` is the prefixed id ("phone-camera-...") and
/// `target` is the peer this answer belongs to ("operator" or "output") so the
/// phone can apply it to the right connection.
#[tauri::command]
pub async fn phone_camera_answer(app: AppHandle, state: State<'_, AppState>, device_id: String, sdp: String, target: String) -> Result<(), String> {
    let control = state.remote.clone();
    match control.phone_camera_route(&device_id).await {
        Some((raw_id, owner)) => {
            crate::store::log_msg(&app, &format!("Remote camera: routing {} answer (target {}) to phone {}", device_id, target, raw_id));
            // Route the answer to the phone over the hub; the per-connection loop
            // delivers it only to the addressed device. The payload carries the id
            // the phone itself used so it can match its own device.
            control.hub.publish_to(
                crate::remote::protocol::RemoteEventKind::CameraAnswer,
                serde_json::json!({ "device_id": raw_id, "sdp": sdp, "target": target }),
                None,
                Some(owner),
            );
            Ok(())
        }
        None => {
            crate::store::log_msg(&app, &format!("Remote camera: NO REGISTERED CAMERA for {} — answer NOT sent", device_id));
            Err(format!("No active phone camera {}", device_id))
        }
    }
}

/// The operator window relays one of its local ICE candidates to the phone
/// that owns the given phone camera.
#[tauri::command]
pub async fn phone_camera_ice(
    app: AppHandle,
    state: State<'_, AppState>,
    device_id: String,
    candidate: String,
    sdp_mid: String,
    sdp_m_line_index: u32,
    target: String,
) -> Result<(), String> {
    let control = state.remote.clone();
    match control.phone_camera_route(&device_id).await {
        Some((raw_id, owner)) => {
            control.hub.publish_to(
                crate::remote::protocol::RemoteEventKind::CameraIce,
                serde_json::json!({
                    "device_id": raw_id,
                    "candidate": candidate,
                    "sdp_mid": sdp_mid,
                    "sdp_m_line_index": sdp_m_line_index,
                    "target": target,
                }),
                None,
                Some(owner),
            );
            Ok(())
        }
        None => {
            crate::store::log_msg(&app, &format!("Remote camera: NO REGISTERED CAMERA for {} — operator ICE NOT sent", device_id));
            Err(format!("No active phone camera {}", device_id))
        }
    }
}
