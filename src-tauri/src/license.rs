use crate::state::AppState;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Number of days Wordlyte keeps working offline after the last successful
/// online license validation. A church's projection PC is frequently offline
/// during a service, so the app keeps running through the grace period; once
/// the grace window passes without an online check, use is cut off until the
/// operator connects the machine to the internet and refreshes the license.
pub const OFFLINE_GRACE_DAYS: u64 = 14;

/// Clock-rollback tolerance. The persisted `last_seen_at` anchor is monotonic:
/// if the wall clock ever appears this far *behind* it, the clock was almost
/// certainly moved backwards to stretch an expired license.
pub const CLOCK_TOLERANCE_SECS: u64 = 6 * 60 * 60;

/// File name (in the app data dir) holding the local license record.
const LICENSE_FILE: &str = "license.json";

/// License validation endpoint (Cloudflare Worker). Deploy the worker in
/// `workers/license/`, then replace the host below. `WORDLYTE_LICENSE_URL`
/// overrides it for testing.
fn default_server_url() -> String {
    std::env::var("WORDLYTE_LICENSE_URL")
        .unwrap_or_else(|_| "https://wordlyte-license.oyomworld.workers.dev".to_owned())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LicenseStatus {
    /// No license record exists on this computer yet.
    Unactivated,
    /// Validated (online or within the offline grace window).
    Active,
    /// Past the license expiry date, or the offline grace window lapsed.
    Expired,
    /// The license server revoked this key.
    Revoked,
    /// Bad key, or the record was activated on a different computer, or the
    /// key's device slot was consumed elsewhere.
    Invalid,
    /// The wall clock moved backwards beyond tolerance.
    ClockTampered,
}

/// License plan. Capability gating in the app reads the *effective* tier from
/// `LicenseStatusInfo` — a paid tier whose time runs out degrades to `Free`
/// instead of locking the app. Ordering is significant: `Free < Pro < Premium`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LicenseTier {
    #[default]
    Free,
    Pro,
    Premium,
}

pub fn tier_label(tier: LicenseTier) -> &'static str {
    match tier {
        LicenseTier::Free => "Free",
        LicenseTier::Pro => "Pro",
        LicenseTier::Premium => "Premium",
    }
}

fn parse_tier(v: &Option<String>) -> LicenseTier {
    match v.as_deref().map(|s| s.trim().to_lowercase()) {
        Some(s) if s == "pro" => LicenseTier::Pro,
        Some(s) if s == "premium" => LicenseTier::Premium,
        _ => LicenseTier::Free,
    }
}

/// Offline grace before revalidation is required. Paid plans get a longer
/// runway than Free (a church PC is often offline during services).
fn grace_days(tier: LicenseTier) -> u64 {
    match tier {
        LicenseTier::Free => OFFLINE_GRACE_DAYS,
        _ => 30,
    }
}

/// The persisted license record (`license.json` in the app data dir).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct License {
    pub version: u32,
    pub license_key: String,
    /// SHA-256 hex of the machine fingerprint this license is bound to.
    pub machine_id: String,
    pub church_name: String,
    pub email: String,
    pub issued_at: u64,
    pub expires_at: u64,
    /// License plan (`free` / `pro` / `premium`). Missing on pre-tier records;
    /// serde defaults those to `Free`.
    #[serde(default)]
    pub tier: LicenseTier,
    pub max_machines: u32,
    pub machines_used: u32,
    /// Last time the license server confirmed this key (authoritative clock).
    pub last_validated_at: u64,
    /// Monotonic anchor of the latest wall-clock time this app has seen
    /// (used to detect clock rollback).
    pub last_seen_at: u64,
    pub revoked: bool,
}

/// Snapshot sent to the frontend. Safe to display; never contains the full key.
#[derive(Debug, Clone, Serialize)]
pub struct LicenseStatusInfo {
    pub status: LicenseStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub church_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issued_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    pub machine_id_hash: String,
    /// Effective plan after degradation (a lapsed paid plan reports `Free`).
    pub tier: LicenseTier,
    pub max_machines: u32,
    pub machines_used: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_validated_at: Option<u64>,
    /// `last_validated_at + OFFLINE_GRACE_DAYS` — after this point the app
    /// refuses to run without an online revalidation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grace_until: Option<u64>,
    /// True when the most recent validation could not reach the license
    /// server, so the frontend can show an "offline" hint.
    pub offline: bool,
    pub message: String,
}

/// Server response from the Cloudflare Worker `POST /validate`.
#[derive(Debug, Clone, Deserialize)]
struct ServerValidation {
    status: String,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    expires_at: Option<u64>,
    #[serde(default)]
    issued_at: Option<u64>,
    #[serde(default)]
    church_name: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    max_machines: Option<u32>,
    #[serde(default)]
    machines_used: Option<u32>,
    #[serde(default)]
    tier: Option<String>,
    #[serde(default)]
    server_time: Option<u64>,
}

/// Shared, Arc-managed license state. Persisted to `license.json` under the
/// app data dir (same pattern as `outputs.json` / `remote_devices.json`).
pub struct LicenseManager {
    pub file: PathBuf,
    /// SHA-256 hash of this machine's fingerprint — the id sent to the server
    /// and the binding stored in the license record.
    pub machine_id: String,
    license: Mutex<Option<License>>,
    server_url: String,
    client: reqwest::Client,
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn compute_machine_id() -> String {
    match machine_uid::get() {
        Ok(id) => {
            let mut h = Sha256::new();
            h.update(id.as_bytes());
            format!("{:x}", h.finalize())
        }
        Err(_) => {
            // Fallback so the license commands still function even if the
            // platform fingerprint is unavailable (should never happen on
            // Windows). Hostname alone is weak, so prefer machine-uid.
            let host = std::env::var("COMPUTERNAME")
                .or_else(|_| std::env::var("HOSTNAME"))
                .unwrap_or_else(|_| "unknown-host".to_owned());
            let mut h = Sha256::new();
            h.update(format!("wordlyte-fallback:{}", host).as_bytes());
            format!("{:x}", h.finalize())
        }
    }
}

fn mask_key(key: &str) -> String {
    if key.len() <= 8 {
        return "••••••••".to_owned();
    }
    format!("{}…{}", &key[..4], &key[key.len() - 4..])
}

fn fmt_ts(ts: u64) -> String {
    chrono::DateTime::from_timestamp(ts as i64, 0)
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| ts.to_string())
}

/// Pure status evaluation — testable without touching the filesystem.
/// Returns `(status, effective_tier, message)`. Time-based blocks degrade a
/// paid plan to `Free` instead of locking the app; hard blocks (clock
/// tampering, revocation, wrong machine) always lock.
fn evaluate_status(lic: &License, machine_id: &str, now: u64) -> (LicenseStatus, LicenseTier, String) {
    if lic.last_seen_at > 0 && now + CLOCK_TOLERANCE_SECS < lic.last_seen_at {
        return (
            LicenseStatus::ClockTampered,
            lic.tier,
            "The system clock appears to have been moved backwards. Fix the date and time, then refresh the license.".to_owned(),
        );
    }
    if lic.revoked {
        return (
            LicenseStatus::Revoked,
            lic.tier,
            "This license has been revoked. Contact the Wordlyte team.".to_owned(),
        );
    }
    if lic.machine_id != machine_id {
        return (
            LicenseStatus::Invalid,
            lic.tier,
            format!(
                "This license was activated on a different computer. Each key allows {} device(s); contact the Wordlyte team to add more.",
                lic.max_machines
            ),
        );
    }
    if now >= lic.expires_at {
        if lic.tier != LicenseTier::Free {
            return (
                LicenseStatus::Active,
                LicenseTier::Free,
                format!(
                    "Your {} plan expired on {}. Wordlyte continues on the Free plan — renew your license in Settings → License to unlock {} features.",
                    tier_label(lic.tier),
                    fmt_ts(lic.expires_at),
                    tier_label(lic.tier)
                ),
            );
        }
        return (LicenseStatus::Expired, LicenseTier::Free, "This license has expired.".to_owned());
    }
    let grace_until = lic.last_validated_at.saturating_add(grace_days(lic.tier) * 86400);
    if now > grace_until {
        if lic.tier != LicenseTier::Free {
            return (
                LicenseStatus::Active,
                LicenseTier::Free,
                format!(
                    "The {} offline grace period ({} days) has passed. Reconnect Wordlyte to the internet and refresh the license to restore {} features.",
                    tier_label(lic.tier),
                    grace_days(lic.tier),
                    tier_label(lic.tier)
                ),
            );
        }
        return (
            LicenseStatus::Expired,
            LicenseTier::Free,
            format!(
                "License revalidation required — the offline grace period ({} days) since the last online check has passed. Connect Wordlyte to the internet and refresh the license.",
                grace_days(lic.tier)
            ),
        );
    }
    (
        LicenseStatus::Active,
        lic.tier,
        format!("Licensed to {}. Valid until {}.", lic.church_name, fmt_ts(lic.expires_at)),
    )
}

impl LicenseManager {
    pub fn new(app_data_dir: &Path) -> Self {
        let file = app_data_dir.join(LICENSE_FILE);
        let machine_id = compute_machine_id();
        let license = Self::load(&file);
        Self {
            file,
            machine_id,
            license: Mutex::new(license),
            server_url: default_server_url(),
            client: reqwest::Client::new(),
        }
    }

    fn load(path: &Path) -> Option<License> {
        let raw = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&raw).ok()
    }

    fn persist(&self, lic: &License) -> Result<(), String> {
        let json = serde_json::to_string_pretty(lic).map_err(|e| e.to_string())?;
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&self.file, json).map_err(|e| e.to_string())
    }

    fn set_license(&self, lic: License) -> Result<(), String> {
        self.persist(&lic)?;
        *self.license.lock() = Some(lic);
        Ok(())
    }

    fn evaluate(&self, lic: Option<License>, offline: bool) -> LicenseStatusInfo {
        let Some(lic) = lic else {
            return LicenseStatusInfo {
                status: LicenseStatus::Unactivated,
                license_key: None,
                church_name: None,
                email: None,
                issued_at: None,
                expires_at: None,
                machine_id_hash: self.machine_id.clone(),
                tier: LicenseTier::Free,
                max_machines: 0,
                machines_used: 0,
                last_validated_at: None,
                grace_until: None,
                offline,
                message: "No license is activated on this computer. Activate Wordlyte with your beta key to continue.".to_owned(),
            };
        };

        let now = now_secs();
        let (status, tier, message) = evaluate_status(&lic, &self.machine_id, now);

        LicenseStatusInfo {
            status,
            license_key: Some(mask_key(&lic.license_key)),
            church_name: Some(lic.church_name.clone()),
            email: Some(lic.email.clone()),
            issued_at: Some(lic.issued_at),
            expires_at: Some(lic.expires_at),
            machine_id_hash: self.machine_id.clone(),
            tier,
            max_machines: lic.max_machines,
            machines_used: lic.machines_used,
            last_validated_at: Some(lic.last_validated_at),
            grace_until: Some(lic.last_validated_at.saturating_add(grace_days(lic.tier) * 86400)),
            offline,
            message,
        }
    }

    /// Local-only status. Advances and persists the monotonic `last_seen_at`
    /// anchor so clock rollback is caught across launches.
    pub fn status(&self) -> LicenseStatusInfo {
        let now = now_secs();
        {
            let mut guard = self.license.lock();
            if let Some(lic) = guard.as_mut() {
                if now > lic.last_seen_at {
                    lic.last_seen_at = now;
                    let _ = self.persist(lic);
                }
            }
        }
        self.evaluate(self.license.lock().clone(), false)
    }

    /// Validate a license key against the server and, on success, persist it
    /// bound to this machine. Fails with a descriptive error when the server
    /// cannot be reached or rejects the key.
    pub async fn activate(&self, key: &str) -> Result<LicenseStatusInfo, String> {
        let key = key.trim().to_uppercase();
        if key.is_empty() {
            return Err("Enter your Wordlyte license key.".to_owned());
        }
        let sv = match self.validate_with_server(&key).await {
            Ok(sv) => sv,
            Err(_) => {
                return Err(
                    "Could not reach the license server. Check your internet connection and try again."
                        .to_owned(),
                )
            }
        };
        if sv.status != "active" {
            return Err(sv
                .message
                .unwrap_or_else(|| "This license key is not valid.".to_owned()));
        }
        let now = now_secs();
        // A server response far from the wall clock means the clock was
        // tampered with; refuse to activate against a wrong clock.
        if let Some(st) = sv.server_time {
            if now.abs_diff(st) > CLOCK_TOLERANCE_SECS {
                return Err(
                    "The system clock looks wrong. Set the correct date and time, then try again."
                        .to_owned(),
                );
            }
        }
        let server_now = sv.server_time.unwrap_or(now);
        let lic = License {
            version: 1,
            license_key: key,
            machine_id: self.machine_id.clone(),
            church_name: sv.church_name.unwrap_or_default(),
            email: sv.email.unwrap_or_default(),
            issued_at: sv.issued_at.unwrap_or(server_now),
            expires_at: sv.expires_at.unwrap_or(server_now),
            tier: parse_tier(&sv.tier),
            max_machines: sv.max_machines.unwrap_or(1),
            machines_used: sv.machines_used.unwrap_or(1),
            last_validated_at: server_now,
            last_seen_at: server_now,
            revoked: false,
        };
        self.set_license(lic)?;
        Ok(self.status())
    }

    /// Re-validate the stored license online. Applies authoritative server
    /// fields (expiry, revocation, machine slots) and updates the offline
    /// anchor. Falls back to the local status with `offline: true` when the
    /// server is unreachable, so a church PC without internet keeps working
    /// through the grace window.
    pub async fn refresh(&self) -> Result<LicenseStatusInfo, String> {
        let Some(lic) = self.license.lock().clone() else {
            return Ok(self.status());
        };

        // Local machine binding is authoritative regardless of connectivity.
        if lic.machine_id != self.machine_id {
            return Ok(self.evaluate(Some(lic), false));
        }

        let now = now_secs();
        match self.validate_with_server(&lic.license_key).await {
            Ok(sv) => match sv.status.as_str() {
                "active" => {
                    let mut updated = lic.clone();
                    if let Some(st) = sv.server_time {
                        if now.abs_diff(st) > CLOCK_TOLERANCE_SECS {
                            let mut info = self.evaluate(Some(updated.clone()), false);
                            info.status = LicenseStatus::ClockTampered;
                            info.message =
                                "The system clock differs from the license server. Fix the date and time, then refresh.".to_owned();
                            return Ok(info);
                        }
                        updated.last_validated_at = st;
                    }
                    updated.revoked = false;
                    if let Some(e) = sv.expires_at {
                        updated.expires_at = e;
                    }
                    if let Some(c) = sv.church_name {
                        updated.church_name = c;
                    }
                    if let Some(e) = sv.email {
                        updated.email = e;
                    }
                    updated.tier = parse_tier(&sv.tier);
                    if let Some(m) = sv.max_machines {
                        updated.max_machines = m;
                    }
                    if let Some(m) = sv.machines_used {
                        updated.machines_used = m;
                    }
                    self.set_license(updated)?;
                    Ok(self.status())
                }
                "expired" => {
                    let mut updated = lic.clone();
                    updated.revoked = false;
                    if let Some(e) = sv.expires_at {
                        updated.expires_at = e;
                    }
                    if let Some(st) = sv.server_time {
                        updated.last_validated_at = st;
                    }
                    let final_lic = updated.clone();
                    self.set_license(updated)?;
                    Ok(self.evaluate(Some(final_lic), false))
                }
                "revoked" => {
                    let mut updated = lic.clone();
                    updated.revoked = true;
                    let final_lic = updated.clone();
                    self.set_license(updated)?;
                    Ok(self.evaluate(Some(final_lic), false))
                }
                _ => {
                    let mut info = self.evaluate(Some(lic), false);
                    info.status = LicenseStatus::Invalid;
                    info.message = sv
                        .message
                        .unwrap_or_else(|| {
                            "This license is no longer valid on the license server. Contact the Wordlyte team."
                                .to_owned()
                        });
                    Ok(info)
                }
            },
            Err(_) => {
                // Offline — report local status with the offline flag so the
                // operator sees the grace countdown.
                Ok(self.evaluate(Some(lic), true))
            }
        }
    }

    /// Remove the local license record (used by "Use a different key" and by
    /// troubleshooting flows). Does not contact the server; the machine slot
    /// stays registered until an administrator revokes it.
    pub fn deactivate(&self) -> LicenseStatusInfo {
        *self.license.lock() = None;
        let _ = std::fs::remove_file(&self.file);
        self.evaluate(None, false)
    }

    async fn validate_with_server(&self, key: &str) -> Result<ServerValidation, String> {
        let url = format!("{}/validate", self.server_url.trim_end_matches('/'));
        let body = serde_json::json!({
            "license_key": key,
            "machine_id": self.machine_id,
            "app_name": "wordlyte",
            "app_version": env!("CARGO_PKG_VERSION"),
        });
        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        resp.json().await.map_err(|e| e.to_string())
    }
}

/// Gate for the broadcast path. Only an `Active` license may stage, go live,
/// or reveal the projection/stage windows. Everything else returns a
/// descriptive error so the frontend can route the operator to Settings.
pub fn ensure_allowed(state: &AppState) -> Result<(), String> {
    match state.license.status().status {
        LicenseStatus::Active => Ok(()),
        s => Err(format!(
            "Wordlyte license is not active ({:?}). Activate or refresh it in Settings → License.",
            s
        )),
    }
}

/// Gate for tier-gated features (remote control, multiple outputs, …). Requires
/// an active license on at least `min` plan; a lapsed paid license degrades to
/// `Free` here too, so its Pro features unlock only after renewal.
pub fn ensure_active_tier(state: &AppState, min: LicenseTier) -> Result<(), String> {
    let info = state.license.status();
    if info.status != LicenseStatus::Active {
        return Err(
            "Wordlyte license is not active. Activate or refresh it in Settings → License."
                .to_owned(),
        );
    }
    if info.tier < min {
        return Err(format!(
            "This feature requires the {} plan. Upgrade in Settings → License.",
            tier_label(min)
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lic(mutate: impl FnOnce(&mut License)) -> License {
        let mut l = License {
            version: 1,
            license_key: "WORDLYTE-TEST-TEST-TEST-TEST".to_owned(),
            machine_id: "m1".to_owned(),
            church_name: "First Test Church".to_owned(),
            email: "test@church.org".to_owned(),
            issued_at: 100,
            expires_at: 1_000_000,
            tier: LicenseTier::Free,
            max_machines: 3,
            machines_used: 1,
            last_validated_at: 500,
            last_seen_at: 500,
            revoked: false,
        };
        mutate(&mut l);
        l
    }

    #[test]
    fn active_within_grace() {
        let l = lic(|_| {});
        let (status, tier, _msg) = evaluate_status(&l, "m1", 1_000);
        assert_eq!(status, LicenseStatus::Active);
        assert_eq!(tier, LicenseTier::Free);
    }

    #[test]
    fn expired_by_date() {
        let l = lic(|l| l.expires_at = 999);
        let (status, _tier, _msg) = evaluate_status(&l, "m1", 1_000);
        assert_eq!(status, LicenseStatus::Expired);
    }

    #[test]
    fn grace_lapsed_blocks_use() {
        // last validated at 500; grace = 14 days. At 500 + 15d it must block.
        let l = lic(|l| {
            l.last_validated_at = 500;
            l.expires_at = 500 + OFFLINE_GRACE_DAYS * 86400 + 10;
        });
        let (status, _tier, _msg) = evaluate_status(&l, "m1", 500 + OFFLINE_GRACE_DAYS * 86400 + 1);
        assert_eq!(status, LicenseStatus::Expired);
    }

    #[test]
    fn grace_lapse_boundary_allows() {
        let l = lic(|l| {
            l.last_validated_at = 500;
            l.expires_at = 500 + OFFLINE_GRACE_DAYS * 86400 + 10;
        });
        let (status, _tier, _msg) = evaluate_status(&l, "m1", 500 + OFFLINE_GRACE_DAYS * 86400);
        assert_eq!(status, LicenseStatus::Active);
    }

    #[test]
    fn revoked_blocks() {
        let l = lic(|l| l.revoked = true);
        let (status, _tier, _msg) = evaluate_status(&l, "m1", 1_000);
        assert_eq!(status, LicenseStatus::Revoked);
    }

    #[test]
    fn machine_mismatch_blocks() {
        let l = lic(|_| {});
        let (status, _tier, _msg) = evaluate_status(&l, "other-machine", 1_000);
        assert_eq!(status, LicenseStatus::Invalid);
    }

    #[test]
    fn clock_rollback_detected() {
        // last_seen_at 10_000_000; a rolled-back clock at 500 looks absurd.
        let l = lic(|l| l.last_seen_at = 10_000_000);
        let (status, _tier, _msg) = evaluate_status(&l, "m1", 500);
        assert_eq!(status, LicenseStatus::ClockTampered);
    }

    #[test]
    fn paid_plan_expiry_degrades_to_free() {
        let l = lic(|l| {
            l.tier = LicenseTier::Pro;
            l.expires_at = 999;
        });
        let (status, tier, msg) = evaluate_status(&l, "m1", 1_000);
        assert_eq!(status, LicenseStatus::Active);
        assert_eq!(tier, LicenseTier::Free);
        assert!(msg.contains("Free plan"));
    }

    #[test]
    fn paid_plan_grace_lapse_degrades_to_free() {
        let g = grace_days(LicenseTier::Premium);
        let l = lic(|l| {
            l.tier = LicenseTier::Premium;
            l.last_validated_at = 500;
            l.expires_at = 500 + g * 86400 + 10;
        });
        let (status, tier, _msg) = evaluate_status(&l, "m1", 500 + g * 86400 + 1);
        assert_eq!(status, LicenseStatus::Active);
        assert_eq!(tier, LicenseTier::Free);
    }

    #[test]
    fn free_plan_still_locks_when_expired() {
        let l = lic(|l| {
            l.tier = LicenseTier::Free;
            l.expires_at = 999;
        });
        let (status, tier, _msg) = evaluate_status(&l, "m1", 1_000);
        assert_eq!(status, LicenseStatus::Expired);
        assert_eq!(tier, LicenseTier::Free);
    }

    #[test]
    fn tier_ordering_is_free_lt_pro_lt_premium() {
        assert!(LicenseTier::Free < LicenseTier::Pro);
        assert!(LicenseTier::Pro < LicenseTier::Premium);
        assert_eq!(parse_tier(&None), LicenseTier::Free);
        assert_eq!(parse_tier(&Some("pro".to_owned())), LicenseTier::Pro);
        assert_eq!(parse_tier(&Some("PREMIUM".to_owned())), LicenseTier::Premium);
        assert_eq!(parse_tier(&Some("ultimate".to_owned())), LicenseTier::Free);
    }

    #[test]
    fn paid_plans_get_longer_offline_grace() {
        assert_eq!(grace_days(LicenseTier::Free), 14);
        assert_eq!(grace_days(LicenseTier::Pro), 30);
        assert_eq!(grace_days(LicenseTier::Premium), 30);
    }

    #[test]
    fn mask_hides_key_middle() {
        let m = mask_key("WORDLYTE-ABCD-EFGH-1234-5678");
        assert!(m.contains("WORD"));
        assert!(m.contains("5678"));
        assert!(!m.contains("EFGH-1234"));
    }
}