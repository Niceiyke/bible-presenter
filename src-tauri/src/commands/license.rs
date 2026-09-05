use crate::events::emit_checked;
use crate::license::LicenseStatusInfo;
use crate::state::AppState;
use tauri::{AppHandle, State};

/// Broadcast the authoritative license snapshot to every window so the
/// operator shell and any license UI stay in sync after activation/refresh.
/// `pub(crate)` because the background revalidation loop
/// (`license::spawn_periodic_refresh`) publishes status changes too.
pub(crate) fn publish_license(app: &AppHandle, info: &LicenseStatusInfo) {
    emit_checked(app, "license-updated", info);
}

/// Current license status. Local evaluation only — no network.
#[tauri::command]
pub async fn license_status(app: AppHandle, state: State<'_, AppState>) -> Result<LicenseStatusInfo, String> {
    let info = state.license.status();
    publish_license(&app, &info);
    Ok(info)
}

/// Activate Wordlyte with a license key. Contacts the license server; the key
/// becomes bound to this machine on success.
#[tauri::command]
pub async fn license_activate(app: AppHandle, state: State<'_, AppState>, key: String) -> Result<LicenseStatusInfo, String> {
    let info = state.license.activate(&key).await?;
    crate::store::log_msg(&app, "License activated");
    publish_license(&app, &info);
    Ok(info)
}

/// Re-validate the stored license against the server. Applies authoritative
/// expiry/revocation and refreshes the offline grace anchor.
#[tauri::command]
pub async fn license_refresh(app: AppHandle, state: State<'_, AppState>) -> Result<LicenseStatusInfo, String> {
    let info = state.license.refresh().await?;
    publish_license(&app, &info);
    Ok(info)
}

/// Remove the local license record so a different key can be activated.
#[tauri::command]
pub async fn license_deactivate(app: AppHandle, state: State<'_, AppState>) -> Result<LicenseStatusInfo, String> {
    let info = state.license.deactivate();
    crate::store::log_msg(&app, "License deactivated on this computer");
    publish_license(&app, &info);
    Ok(info)
}