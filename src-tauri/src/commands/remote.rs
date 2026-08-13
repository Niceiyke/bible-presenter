use crate::remote::protocol::{RemoteControllerState, RemoteRole};
use crate::remote::{public_urls, RemoteControl};
use crate::state::AppState;
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, State};

#[derive(Debug, Clone, Serialize)]
pub struct RemoteDeviceInfo {
    pub id: String,
    pub name: String,
    pub role: RemoteRole,
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
        pairing_expires_at: control.tokens.pairing_expires_at(),
        devices,
        controller_state: control.lease.state(),
        revision: control.hub.current_revision(),
    }
}

#[tauri::command]
pub async fn remote_enable(app: AppHandle, state: State<'_, AppState>) -> Result<RemoteStatusInfo, String> {
    let control = state.remote.clone();
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
        control,
    };
    let addr = crate::remote::server::start(ctx).await?;
    state.remote.persist_devices();
    crate::store::log_msg(&app, &format!("Remote Control enabled on {}", addr));

    Ok(status_info(&state.remote, Some(pairing)))
}

#[tauri::command]
pub async fn remote_disable(app: AppHandle, state: State<'_, AppState>) -> Result<RemoteStatusInfo, String> {
    if let Some(task) = state.remote.task.lock().take() {
        task.abort();
    }
    state.remote.enabled.store(false, Ordering::SeqCst);
    *state.remote.bound_addr.lock() = None;
    state.remote.sessions.list().into_iter().for_each(|d| state.remote.sessions.disconnect(&d.device_id));
    crate::store::log_msg(&app, "Remote Control disabled");
    Ok(status_info(&state.remote, None))
}

#[tauri::command]
pub async fn remote_status(state: State<'_, AppState>) -> Result<RemoteStatusInfo, String> {
    let control = state.remote.clone();
    if control.is_enabled() {
        control.ensure_pairing();
        Ok(status_info(&control, Some(control.token_for_display())))
    } else {
        Ok(status_info(&control, None))
    }
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
    let revoked = control.tokens.revoke_device(&device_id);
    if revoked {
        control.persist_devices();
    }
    crate::store::log_msg(&app, &format!("Remote device revoked: {}", device_id));
    Ok(status_info(&control, control.is_enabled().then(|| control.token_for_display())))
}

#[tauri::command]
pub async fn remote_revoke_all(app: AppHandle, state: State<'_, AppState>) -> Result<RemoteStatusInfo, String> {
    let control = state.remote.clone();
    let count = control.tokens.revoke_all();
    control.persist_devices();
    control.sessions.list().into_iter().for_each(|d| control.sessions.disconnect(&d.device_id));
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
        crate::store::log_msg(&app, "Desktop reclaims remote controller lease");
    }
    Ok(status_info(&control, control.is_enabled().then(|| control.token_for_display())))
}
