use crate::state::AppState;
use base64::Engine as _;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Paid plans may use a signed cached entitlement while the church is offline.
/// Core activation never expires after the initial online account/device pairing.
pub const PAID_OFFLINE_GRACE_DAYS: u64 = 30;
pub const CLOCK_TOLERANCE_SECS: u64 = 6 * 60 * 60;
const LICENSE_FILE: &str = "license.json";
/// Refresh the in-memory AI token this far before expiry. A small overlap keeps
/// reconnecting transcription sessions alive across a transient service blip.
const AI_TOKEN_REFRESH_WINDOW_SECS: u64 = 600;

/// Ed25519 verification key for signed account/device entitlement snapshots.
/// The matching private key exists only as a Worker secret.
const SIGNING_PUBLIC_KEY_B64: &str = "vMwGfNDpuoMjxC3SryLnSwocE0yGlmgoSNCC2R2J9Xs=";

fn default_server_url() -> String {
    std::env::var("WORDLYTE_LICENSE_URL")
        .unwrap_or_else(|_| "https://wordlyte-license.oyomworld.workers.dev".to_owned())
}

pub fn ai_gateway_url() -> String {
    std::env::var("WORDLYTE_AI_GATEWAY_URL")
        .unwrap_or_else(|_| "https://wordlyte-ai-gateway.oyomworld.workers.dev".to_owned())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LicenseStatus {
    Unactivated,
    Active,
    Revoked,
    Invalid,
    ClockTampered,
}

/// Subscription plan. Free is the permanent activated baseline. Pro and Premium
/// are independently expiring paid entitlements layered on top of that baseline.
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

fn tier_str(tier: LicenseTier) -> &'static str {
    match tier {
        LicenseTier::Free => "free",
        LicenseTier::Pro => "pro",
        LicenseTier::Premium => "premium",
    }
}

fn parse_tier(value: Option<&str>) -> LicenseTier {
    match value.map(|v| v.trim().to_ascii_lowercase()) {
        Some(value) if value == "pro" => LicenseTier::Pro,
        Some(value) if value == "premium" => LicenseTier::Premium,
        _ => LicenseTier::Free,
    }
}

/// Quantitative limits are signed by the entitlement service. This lets the
/// commercial service change plan capacity without shipping a desktop update.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseLimits {
    pub max_bible_versions: u32,
    pub max_outputs: u32,
    pub max_cameras: u32,
    pub max_scenes: u32,
    pub stream_destinations: u32,
    pub shared_audio_input: bool,
}

/// Signed access to the Wordlyte AI Add-on. Unit balances remain online-only;
/// they must never be trusted from a cached desktop entitlement.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEntitlement {
    pub addon_active: bool,
    #[serde(default)]
    pub addon_expires_at: Option<u64>,
}

/// Display-only AI Unit balance. It is fetched online and never cached in the
/// signed entitlement; only the License Worker may spend Units.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUnitBalance {
    pub addon_active: bool,
    pub monthly_units_remaining: f64,
    pub topup_units_remaining: f64,
    pub reserved_units_remaining: f64,
    pub total_units_remaining: f64,
    pub available_units_remaining: f64,
    pub monthly_reset_at: Option<u64>,
    pub rates: AiUnitRates,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUnitRates {
    pub transcription_units_per_minute: f64,
    pub standard_llm_request_units: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAccessInfo {
    pub token: String,
    pub expires_at: u64,
    pub ai: AiUnitBalance,
}

#[derive(Debug, Deserialize)]
struct ServerAiRates {
    #[serde(default)]
    transcription_units_per_minute: f64,
    #[serde(default)]
    standard_llm_request_units: f64,
}

#[derive(Debug, Deserialize)]
struct ServerAiBalance {
    #[serde(default)]
    addon_active: bool,
    #[serde(default)]
    monthly_units_remaining: f64,
    #[serde(default)]
    topup_units_remaining: f64,
    #[serde(default)]
    reserved_units_remaining: f64,
    #[serde(default)]
    total_units_remaining: f64,
    #[serde(default)]
    available_units_remaining: f64,
    #[serde(default)]
    monthly_reset_at: Option<u64>,
    #[serde(default)]
    rates: Option<ServerAiRates>,
}

#[derive(Debug, Deserialize)]
struct AiTokenResponse {
    status: String,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    expires_at: Option<u64>,
    #[serde(default)]
    ai: Option<ServerAiBalance>,
}

impl LicenseLimits {
    fn for_plan(plan: LicenseTier) -> Self {
        match plan {
            // Scripture is a core Free feature; installed translations are not
            // artificially restricted. Free is constrained by production
            // surface capacity instead.
            LicenseTier::Free => Self {
                max_bible_versions: u32::MAX,
                max_outputs: 1,
                max_cameras: 1,
                max_scenes: 3,
                stream_destinations: 0,
                shared_audio_input: false,
            },
            LicenseTier::Pro => Self {
                max_bible_versions: u32::MAX,
                max_outputs: 2,
                max_cameras: 3,
                max_scenes: u32::MAX,
                stream_destinations: 1,
                shared_audio_input: false,
            },
            LicenseTier::Premium => Self {
                max_bible_versions: u32::MAX,
                max_outputs: 10,
                max_cameras: 10,
                max_scenes: u32::MAX,
                stream_destinations: 5,
                shared_audio_input: true,
            },
        }
    }
}

/// Locally stored v3 device entitlement. `device_token` is a random per-device
/// credential used only to refresh with the Worker; it is DPAPI protected and is
/// never returned to the frontend or covered by the Worker signature.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct License {
    pub version: u32,
    pub organization_id: String,
    pub device_token: String,
    pub machine_id: String,
    pub church_name: String,
    pub email: String,
    pub core_activated_at: u64,
    pub plan: LicenseTier,
    #[serde(default)]
    pub plan_expires_at: Option<u64>,
    pub limits: LicenseLimits,
    #[serde(default)]
    pub ai: AiEntitlement,
    pub max_machines: u32,
    pub machines_used: u32,
    pub last_validated_at: u64,
    #[serde(default)]
    pub last_seen_at: u64,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub sig: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LicenseStatusInfo {
    pub status: LicenseStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub church_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub core_activated_at: Option<u64>,
    /// Effective tier. Expired or stale paid entitlements report Free while the
    /// permanent activated core remains available.
    pub tier: LicenseTier,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_expires_at: Option<u64>,
    pub limits: LicenseLimits,
    pub ai: AiEntitlement,
    pub machine_id_hash: String,
    pub max_machines: u32,
    pub machines_used: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_validated_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grace_until: Option<u64>,
    pub offline: bool,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ServerEntitlement {
    status: String,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    organization_id: Option<String>,
    #[serde(default)]
    machine_id: Option<String>,
    #[serde(default)]
    device_token: Option<String>,
    #[serde(default)]
    church_name: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    core_activated_at: Option<u64>,
    #[serde(default)]
    plan: Option<String>,
    #[serde(default)]
    plan_expires_at: Option<u64>,
    #[serde(default)]
    limits: Option<LicenseLimits>,
    #[serde(default)]
    ai: Option<AiEntitlement>,
    #[serde(default)]
    max_machines: Option<u32>,
    #[serde(default)]
    machines_used: Option<u32>,
    #[serde(default)]
    server_time: Option<u64>,
    #[serde(default)]
    sig: Option<String>,
}

pub struct LicenseManager {
    pub file: PathBuf,
    pub machine_id: String,
    license: Mutex<Option<License>>,
    verified: AtomicBool,
    server_url: String,
    client: reqwest::Client,
    /// Short-lived AI access is cached only in memory. Keeping it across
    /// reconnect attempts avoids a token round trip during transient provider
    /// disconnects, and lets a near-expiry token bridge a brief license-service
    /// outage.
    ai_token: Mutex<Option<AiAccessInfo>>,
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn compute_machine_id() -> String {
    let source = machine_uid::get().unwrap_or_else(|_| {
        std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "unknown-host".to_owned())
    });
    let mut hash = Sha256::new();
    hash.update(format!("wordlyte-device:{source}").as_bytes());
    format!("{:x}", hash.finalize())
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Wordlyte computer".to_owned())
}

fn fmt_ts(ts: u64) -> String {
    chrono::DateTime::from_timestamp(ts as i64, 0)
        .map(|date| date.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| ts.to_string())
}

/// Field order is protocol: must match `signEntitlement` in the Worker.
fn canonical_license(license: &License) -> String {
    format!(
        "wl3|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        license.organization_id,
        license.machine_id,
        license.status,
        license.core_activated_at,
        tier_str(license.plan),
        license.plan_expires_at.unwrap_or(0),
        license.max_machines,
        license.machines_used,
        license.last_validated_at,
        license.limits.max_bible_versions,
        license.limits.max_outputs,
        license.limits.max_cameras,
        license.limits.max_scenes,
        license.limits.stream_destinations,
        u8::from(license.limits.shared_audio_input),
        u8::from(license.ai.addon_active),
        license.ai.addon_expires_at.unwrap_or(0),
    )
}

fn canonical_server(entitlement: &ServerEntitlement) -> String {
    format!(
        "wl3|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        entitlement.organization_id.as_deref().unwrap_or_default(),
        entitlement.machine_id.as_deref().unwrap_or_default(),
        entitlement.status,
        entitlement.core_activated_at.unwrap_or(0),
        entitlement.plan.as_deref().unwrap_or("free"),
        entitlement.plan_expires_at.unwrap_or(0),
        entitlement.max_machines.unwrap_or(0),
        entitlement.machines_used.unwrap_or(0),
        entitlement.server_time.unwrap_or(0),
        entitlement
            .limits
            .as_ref()
            .map(|limits| limits.max_bible_versions)
            .unwrap_or(0),
        entitlement
            .limits
            .as_ref()
            .map(|limits| limits.max_outputs)
            .unwrap_or(0),
        entitlement
            .limits
            .as_ref()
            .map(|limits| limits.max_cameras)
            .unwrap_or(0),
        entitlement
            .limits
            .as_ref()
            .map(|limits| limits.max_scenes)
            .unwrap_or(0),
        entitlement
            .limits
            .as_ref()
            .map(|limits| limits.stream_destinations)
            .unwrap_or(0),
        u8::from(
            entitlement
                .limits
                .as_ref()
                .is_some_and(|limits| limits.shared_audio_input)
        ),
        u8::from(entitlement.ai.as_ref().is_some_and(|ai| ai.addon_active)),
        entitlement
            .ai
            .as_ref()
            .and_then(|ai| ai.addon_expires_at)
            .unwrap_or(0),
    )
}

fn verifying_key() -> Option<ed25519_dalek::VerifyingKey> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(SIGNING_PUBLIC_KEY_B64.trim())
        .ok()?;
    let bytes: [u8; 32] = bytes.try_into().ok()?;
    ed25519_dalek::VerifyingKey::from_bytes(&bytes).ok()
}

fn verify_signature(canonical: &str, signature: &str) -> bool {
    let Some(key) = verifying_key() else {
        return false;
    };
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(signature.trim()) else {
        return false;
    };
    let Ok(signature) = ed25519_dalek::Signature::from_slice(&bytes) else {
        return false;
    };
    key.verify_strict(canonical.as_bytes(), &signature).is_ok()
}

fn verify_license(license: &License) -> bool {
    license.version == 3
        && !license.organization_id.trim().is_empty()
        && !license.device_token.trim().is_empty()
        && !license.sig.trim().is_empty()
        && verify_signature(&canonical_license(license), &license.sig)
}

fn verify_server(entitlement: &ServerEntitlement) -> bool {
    !entitlement.sig.as_deref().unwrap_or_default().is_empty()
        && verify_signature(
            &canonical_server(entitlement),
            entitlement.sig.as_deref().unwrap_or_default(),
        )
}

#[cfg(windows)]
mod storage {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        }
    }

    fn copy_and_free(blob: &CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let result =
            unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize) }.to_vec();
        unsafe {
            if !blob.pbData.is_null() {
                LocalFree(Some(HLOCAL(blob.pbData.cast())));
            }
        }
        result
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptProtectData(
                &blob(data),
                PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
            .map_err(|error| format!("Could not protect device entitlement: {error}"))?;
        }
        Ok(copy_and_free(&out))
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        let mut out = CRYPT_INTEGER_BLOB::default();
        let mut description = PWSTR::null();
        unsafe {
            CryptUnprotectData(
                &blob(data),
                Some(&mut description),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
            .map_err(|error| format!("Could not open device entitlement: {error}"))?;
            if !description.is_null() {
                LocalFree(Some(HLOCAL(description.as_ptr().cast())));
            }
        }
        Ok(copy_and_free(&out))
    }
}

#[cfg(not(windows))]
mod storage {
    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        Ok(data.to_vec())
    }
    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        Ok(data.to_vec())
    }
}

fn effective_tier(license: &License, now: u64) -> (LicenseTier, Option<u64>, String) {
    if license.plan == LicenseTier::Free {
        return (LicenseTier::Free, None, "Activated Free plan.".to_owned());
    }
    let grace_until = license
        .last_validated_at
        .saturating_add(PAID_OFFLINE_GRACE_DAYS * 86_400);
    if license.plan_expires_at.is_some_and(|expiry| now >= expiry) {
        return (
            LicenseTier::Free,
            Some(grace_until),
            format!(
                "Your {} plan expired on {}. Wordlyte continues on the Free plan.",
                tier_label(license.plan),
                fmt_ts(license.plan_expires_at.unwrap_or_default())
            ),
        );
    }
    if now > grace_until {
        return (
            LicenseTier::Free,
            Some(grace_until),
            format!(
                "Wordlyte could not refresh the {} plan for {} days. Core presentation remains available on Free until you reconnect.",
                tier_label(license.plan), PAID_OFFLINE_GRACE_DAYS
            ),
        );
    }
    (
        license.plan,
        Some(grace_until),
        format!("{} plan active.", tier_label(license.plan)),
    )
}

impl LicenseManager {
    pub fn new(app_data_dir: &Path) -> Self {
        let file = app_data_dir.join(LICENSE_FILE);
        let (license, verified) = Self::load(&file);
        Self {
            file,
            machine_id: compute_machine_id(),
            license: Mutex::new(license),
            verified: AtomicBool::new(verified),
            server_url: default_server_url(),
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            ai_token: Mutex::new(None),
        }
    }

    fn load(path: &Path) -> (Option<License>, bool) {
        let Ok(raw) = std::fs::read(path) else {
            return (None, false);
        };
        let Ok(clear) = storage::unprotect(&raw) else {
            return (None, false);
        };
        let Ok(license) = serde_json::from_slice::<License>(&clear) else {
            return (None, false);
        };
        let verified = verify_license(&license);
        (Some(license), verified)
    }

    fn persist(&self, license: &License) -> Result<(), String> {
        let clear = serde_json::to_vec_pretty(license).map_err(|error| error.to_string())?;
        let protected = storage::protect(&clear)?;
        if let Some(parent) = self.file.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(&self.file, protected).map_err(|error| error.to_string())
    }

    fn set_license(&self, license: License) -> Result<(), String> {
        self.persist(&license)?;
        *self.license.lock() = Some(license);
        *self.ai_token.lock() = None;
        self.verified.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn evaluate(&self, license: Option<License>, offline: bool) -> LicenseStatusInfo {
        let Some(license) = license else {
            return LicenseStatusInfo {
                status: LicenseStatus::Unactivated,
                organization_id: None,
                church_name: None,
                email: None,
                core_activated_at: None,
                tier: LicenseTier::Free,
                plan_expires_at: None,
                limits: LicenseLimits::for_plan(LicenseTier::Free),
                ai: AiEntitlement {
                    addon_active: false,
                    addon_expires_at: None,
                },
                machine_id_hash: self.machine_id.clone(),
                max_machines: 0,
                machines_used: 0,
                last_validated_at: None,
                grace_until: None,
                offline,
                message: "Sign in to your Wordlyte account and activate this computer to begin."
                    .to_owned(),
            };
        };
        let base = |status, tier, grace_until, message| LicenseStatusInfo {
            status,
            organization_id: Some(license.organization_id.clone()),
            church_name: Some(license.church_name.clone()),
            email: Some(license.email.clone()),
            core_activated_at: Some(license.core_activated_at),
            tier,
            plan_expires_at: license.plan_expires_at,
            limits: license.limits.clone(),
            ai: license.ai.clone(),
            machine_id_hash: self.machine_id.clone(),
            max_machines: license.max_machines,
            machines_used: license.machines_used,
            last_validated_at: Some(license.last_validated_at),
            grace_until,
            offline,
            message,
        };
        if !self.verified.load(Ordering::SeqCst) {
            return base(
                LicenseStatus::Invalid,
                LicenseTier::Free,
                None,
                "This computer's activation record could not be verified. Activate it again online.".to_owned(),
            );
        }
        let now = now_secs();
        if license.last_seen_at > 0 && now + CLOCK_TOLERANCE_SECS < license.last_seen_at {
            return base(
                LicenseStatus::ClockTampered,
                LicenseTier::Free,
                None,
                "The system clock appears to have moved backwards. Fix the date and time, then refresh Wordlyte.".to_owned(),
            );
        }
        if license.machine_id != self.machine_id {
            return base(
                LicenseStatus::Invalid,
                LicenseTier::Free,
                None,
                "This activation belongs to a different computer. Activate this computer from your Wordlyte account.".to_owned(),
            );
        }
        if license.status == "revoked" {
            return base(
                LicenseStatus::Revoked,
                LicenseTier::Free,
                None,
                "This computer's activation has been revoked by the organization owner.".to_owned(),
            );
        }
        if license.status != "active" {
            return base(
                LicenseStatus::Invalid,
                LicenseTier::Free,
                None,
                "This computer's activation is not active. Activate it again online.".to_owned(),
            );
        }
        let (tier, grace_until, message) = effective_tier(&license, now);
        let mut info = base(LicenseStatus::Active, tier, grace_until, message);
        // A paid snapshot can outlive its subscription or its offline-grace
        // window. Its original signed capacities must not leak into the Free
        // fallback: output, scene, and other quantitative gates read this value.
        if tier == LicenseTier::Free && license.plan != LicenseTier::Free {
            info.limits = LicenseLimits::for_plan(LicenseTier::Free);
        }
        info
    }

    pub fn status(&self) -> LicenseStatusInfo {
        let now = now_secs();
        if self.verified.load(Ordering::SeqCst) {
            let mut guard = self.license.lock();
            if let Some(license) = guard.as_mut() {
                if now > license.last_seen_at {
                    license.last_seen_at = now;
                    let _ = self.persist(license);
                }
            }
        }
        self.evaluate(self.license.lock().clone(), false)
    }

    fn license_from_server(
        &self,
        response: ServerEntitlement,
        existing: Option<&License>,
    ) -> Result<License, String> {
        if response.status != "active" || !verify_server(&response) {
            return Err(response.message.unwrap_or_else(|| {
                "The account service returned an invalid activation response.".to_owned()
            }));
        }
        let server_time = response.server_time.unwrap_or_else(now_secs);
        let machine_id = response.machine_id.clone().unwrap_or_default();
        if machine_id != self.machine_id {
            return Err(
                "The account service returned an activation for a different computer.".to_owned(),
            );
        }
        let plan = parse_tier(response.plan.as_deref());
        let limits = response
            .limits
            .clone()
            .unwrap_or_else(|| LicenseLimits::for_plan(plan));
        let ai = response.ai.clone().unwrap_or_default();
        Ok(License {
            version: 3,
            organization_id: response.organization_id.unwrap_or_default(),
            device_token: response
                .device_token
                .or_else(|| existing.map(|license| license.device_token.clone()))
                .unwrap_or_default(),
            machine_id,
            church_name: response.church_name.unwrap_or_default(),
            email: response.email.unwrap_or_default(),
            core_activated_at: response.core_activated_at.unwrap_or(server_time),
            plan,
            plan_expires_at: response.plan_expires_at,
            limits,
            ai,
            max_machines: response.max_machines.unwrap_or(1),
            machines_used: response.machines_used.unwrap_or(1),
            last_validated_at: server_time,
            last_seen_at: now_secs(),
            status: response.status,
            sig: response.sig.unwrap_or_default(),
        })
    }

    /// Pair this computer with an account-created, one-time device activation code.
    pub async fn activate(&self, activation_code: &str) -> Result<LicenseStatusInfo, String> {
        let activation_code = activation_code.trim().to_ascii_uppercase();
        if activation_code.is_empty() {
            return Err("Enter the device activation code from your Wordlyte account.".to_owned());
        }
        let response = self
            .post(
                "/activate",
                serde_json::json!({
                    "activation_code": activation_code,
                    "machine_id": self.machine_id,
                    "device_name": device_name(),
                }),
            )
            .await?;
        let license = self.license_from_server(response, None)?;
        if license.device_token.is_empty() {
            return Err(
                "The account service did not issue a device credential. Try activating again."
                    .to_owned(),
            );
        }
        self.set_license(license)?;
        Ok(self.status())
    }

    pub async fn refresh(&self) -> Result<LicenseStatusInfo, String> {
        let Some(existing) = self.license.lock().clone() else {
            return Ok(self.status());
        };
        if existing.machine_id != self.machine_id {
            return Ok(self.evaluate(Some(existing), false));
        }
        match self
            .post(
                "/entitlement",
                serde_json::json!({
                    "organization_id": existing.organization_id,
                    "machine_id": self.machine_id,
                    "device_token": existing.device_token,
                }),
            )
            .await
        {
            Ok(response) => {
                if response.status == "revoked" && verify_server(&response) {
                    // Rebuild from the signed revoked payload rather than retaining
                    // stale fields from the prior active entitlement.
                    let revoked = self.license_from_signed_nonactive(response, existing.clone())?;
                    self.set_license(revoked)?;
                    return Ok(self.status());
                }
                match self.license_from_server(response, Some(&existing)) {
                    Ok(updated) => {
                        self.set_license(updated)?;
                        Ok(self.status())
                    }
                    Err(message) => {
                        // A reachable service supplied an unsigned/invalid
                        // response, so this is not an offline condition. Fail
                        // closed until the computer is activated again online.
                        self.verified.store(false, Ordering::SeqCst);
                        let mut info = self.evaluate(Some(existing), false);
                        info.message = message;
                        Ok(info)
                    }
                }
            }
            Err(_) => Ok(self.evaluate(Some(existing), true)),
        }
    }

    /// Exchange this device's activation credential for a short-lived managed
    /// AI token. This is always an online operation; no AI token or provider
    /// key is ever persisted locally.
    pub async fn ai_access(&self) -> Result<AiAccessInfo, String> {
        let existing = self
            .license
            .lock()
            .clone()
            .ok_or_else(|| "Activate this computer before using Wordlyte AI.".to_owned())?;
        if existing.machine_id != self.machine_id {
            return Err("This activation belongs to a different computer.".to_owned());
        }
        let now = now_secs();
        let cached = self.ai_token.lock().clone();
        if let Some(cached) = cached.as_ref() {
            if cached.expires_at > now.saturating_add(AI_TOKEN_REFRESH_WINDOW_SECS) {
                return Ok(cached.clone());
            }
        }
        let url = format!(
            "{}{}",
            self.server_url.trim_end_matches('/'),
            "/ai/token"
        );
        let response = match self
            .client
            .post(url)
            .json(&serde_json::json!({
                "organization_id": existing.organization_id,
                "machine_id": self.machine_id,
                "device_token": existing.device_token,
            }))
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                // A reconnect can happen while the license service is briefly
                // unreachable. Keep using the still-valid in-memory token
                // instead of failing the whole listening session.
                if let Some(cached) = cached.as_ref() {
                    if cached.expires_at > now {
                        return Ok(cached.clone());
                    }
                }
                return Err(format!("Could not reach the Wordlyte AI service: {error}"));
            }
        };
        let status = response.status();
        let payload: AiTokenResponse = response
            .json()
            .await
            .map_err(|error| format!("The Wordlyte AI service returned an invalid response: {error}"))?;
        if !status.is_success() || payload.status != "ok" {
            // Keep a still-valid cached token through transient 5xx/429
            // responses; only a definitive authorization/entitlement failure
            // should discard it.
            let transient = status.is_server_error() || status.as_u16() == 429;
            if !transient {
                *self.ai_token.lock() = None;
            }
            return Err(payload
                .message
                .unwrap_or_else(|| "Wordlyte AI is not available for this organization.".to_owned()));
        }
        let token = payload
            .token
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "The Wordlyte AI service did not issue an access token.".to_owned())?;
        let server_ai = payload
            .ai
            .ok_or_else(|| "The Wordlyte AI service did not return an AI Unit balance.".to_owned())?;
        let rates = server_ai.rates.unwrap_or(ServerAiRates {
            transcription_units_per_minute: 1.0,
            standard_llm_request_units: 10.0,
        });
        let access = AiAccessInfo {
            token,
            expires_at: payload.expires_at.unwrap_or_else(|| now_secs() + 900),
            ai: AiUnitBalance {
                addon_active: server_ai.addon_active,
                monthly_units_remaining: server_ai.monthly_units_remaining,
                topup_units_remaining: server_ai.topup_units_remaining,
                reserved_units_remaining: server_ai.reserved_units_remaining,
                total_units_remaining: server_ai.total_units_remaining,
                available_units_remaining: server_ai.available_units_remaining,
                monthly_reset_at: server_ai.monthly_reset_at,
                rates: AiUnitRates {
                    transcription_units_per_minute: rates.transcription_units_per_minute,
                    standard_llm_request_units: rates.standard_llm_request_units,
                },
            },
        };
        *self.ai_token.lock() = Some(access.clone());
        Ok(access)
    }

    /// POST a JSON payload to a License Worker endpoint that accepts the
    /// short-lived AI token. Used for explicit opt-in transcript sync.
    pub async fn post_ai_authenticated(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<(), String> {
        let access = self.ai_access().await?;
        let url = format!("{}{}", self.server_url.trim_end_matches('/'), path);
        let response = self
            .client
            .post(url)
            .bearer_auth(access.token)
            .json(body)
            .send()
            .await
            .map_err(|error| format!("Could not reach the transcript sync service: {error}"))?;
        if response.status().is_success() {
            return Ok(());
        }
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        let detail = detail.chars().take(300).collect::<String>();
        Err(format!("Transcript sync failed ({status}): {detail}"))
    }

    fn license_from_signed_nonactive(
        &self,
        response: ServerEntitlement,
        existing: License,
    ) -> Result<License, String> {
        if !verify_server(&response) || response.status != "revoked" {
            return Err("The account service returned an invalid device status.".to_owned());
        }
        let machine_id = response.machine_id.clone().unwrap_or_default();
        if machine_id != self.machine_id {
            return Err(
                "The account service returned a device status for a different computer.".to_owned(),
            );
        }
        let plan = parse_tier(response.plan.as_deref());
        let limits = response
            .limits
            .clone()
            .unwrap_or_else(|| LicenseLimits::for_plan(plan));
        let ai = response.ai.clone().unwrap_or_default();
        Ok(License {
            version: 3,
            organization_id: response.organization_id.unwrap_or(existing.organization_id),
            device_token: existing.device_token,
            machine_id,
            church_name: response.church_name.unwrap_or(existing.church_name),
            email: response.email.unwrap_or(existing.email),
            core_activated_at: response
                .core_activated_at
                .unwrap_or(existing.core_activated_at),
            plan,
            plan_expires_at: response.plan_expires_at,
            limits,
            ai,
            max_machines: response.max_machines.unwrap_or(existing.max_machines),
            machines_used: response.machines_used.unwrap_or(existing.machines_used),
            last_validated_at: response.server_time.unwrap_or_else(now_secs),
            last_seen_at: now_secs(),
            status: response.status,
            sig: response.sig.unwrap_or_default(),
        })
    }

    pub fn deactivate(&self) -> LicenseStatusInfo {
        *self.license.lock() = None;
        self.verified.store(false, Ordering::SeqCst);
        let _ = std::fs::remove_file(&self.file);
        self.evaluate(None, false)
    }

    async fn post(&self, path: &str, body: serde_json::Value) -> Result<ServerEntitlement, String> {
        let url = format!("{}{}", self.server_url.trim_end_matches('/'), path);
        let response = self
            .client
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        response.json().await.map_err(|error| error.to_string())
    }
}

pub fn spawn_periodic_refresh(app: tauri::AppHandle) {
    use tauri::Manager;
    tauri::async_runtime::spawn(async move {
        let license = app.state::<AppState>().license.clone();
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        loop {
            if let Ok(info) = license.refresh().await {
                crate::commands::license::publish_license(&app, &info);
            }
            tokio::time::sleep(std::time::Duration::from_secs(6 * 60 * 60)).await;
        }
    });
}

/// Core activation is mandatory for every plan, including permanent Free.
pub fn ensure_core_activated(state: &AppState) -> Result<(), String> {
    match state.license.status().status {
        LicenseStatus::Active => Ok(()),
        status => Err(format!(
            "Wordlyte is not activated ({status:?}). Sign in and activate this computer in Settings → License."
        )),
    }
}

/// Compatibility alias for existing basic presentation commands. New code should
/// call `ensure_core_activated` to make the intended requirement explicit.
pub fn ensure_allowed(state: &AppState) -> Result<(), String> {
    ensure_core_activated(state)
}

pub fn ensure_active_tier(state: &AppState, minimum: LicenseTier) -> Result<(), String> {
    ensure_core_activated(state)?;
    let info = state.license.status();
    if info.tier < minimum {
        return Err(format!(
            "This feature requires the {} plan. Ask your organization owner to upgrade Wordlyte.",
            tier_label(minimum)
        ));
    }
    Ok(())
}

/// Basic Bible, songs, local media, and Studio presentations require the
/// permanent Free activation. Scene compositions are a Pro production feature,
/// so every generic display IPC path must re-check it rather than trusting the
/// frontend to hide scene controls.
pub fn ensure_display_item_allowed(
    state: &AppState,
    item: &crate::store::DisplayItem,
) -> Result<(), String> {
    ensure_core_activated(state)?;
    if matches!(item, crate::store::DisplayItem::SceneComposition(_)) {
        ensure_active_tier(state, LicenseTier::Pro)?;
    }
    ensure_camera_capacity(state, item)?;
    Ok(())
}

/// Enforce the server-signed simultaneous camera capacity at the same boundary
/// as other display entitlements. Scene compositions may contain multiple
/// camera zones, so the check cannot live only in the Camera workspace UI.
fn camera_count(item: &crate::store::DisplayItem) -> usize {
    use std::collections::HashSet;

    match item {
        crate::store::DisplayItem::Camera(_) => 1,
        crate::store::DisplayItem::SceneComposition(composition) => {
            let mut feeds = HashSet::new();
            for zone in &composition.zones {
                match &zone.item {
                    crate::store::DisplayItem::Camera(camera) => {
                        feeds.insert(format!("device:{}", camera.device_id));
                    }
                    // A live camera-source zone can be populated after the
                    // composition is on air. Count it even when its saved item
                    // is only a placeholder so it cannot exceed the plan cap.
                    _ if matches!(zone.source, Some(crate::store::SceneZoneSource::Camera)) => {
                        feeds.insert(format!("zone:{}", zone.id));
                    }
                    _ => {}
                }
            }
            feeds.len()
        }
        _ => 0,
    }
}

fn ensure_camera_capacity(
    state: &AppState,
    item: &crate::store::DisplayItem,
) -> Result<(), String> {
    let cameras = camera_count(item);
    let limit = state.license.status().limits.max_cameras as usize;
    if cameras > limit {
        return Err(format!(
            "Your Wordlyte plan supports {limit} camera feed(s) at a time. Ask your organization owner to upgrade for more."
        ));
    }
    Ok(())
}

/// Enforce a signed simultaneous-stream destination capacity after confirming
/// the organization has at least Pro production access.
pub fn ensure_stream_destination_capacity(
    state: &AppState,
    destinations: usize,
) -> Result<(), String> {
    ensure_active_tier(state, LicenseTier::Pro)?;
    let info = state.license.status();
    if destinations > info.limits.stream_destinations as usize {
        return Err(format!(
            "Your Wordlyte plan supports {} simultaneous stream destination(s). Ask your organization owner to upgrade for more.",
            info.limits.stream_destinations
        ));
    }
    Ok(())
}

/// Shared program-audio transport is a Premium-scale entitlement rather than
/// an implicit property of a locally selected tier name.
pub fn ensure_shared_audio_input(state: &AppState) -> Result<(), String> {
    ensure_active_tier(state, LicenseTier::Pro)?;
    if !state.license.status().limits.shared_audio_input {
        return Err("Shared program audio requires the Premium plan. Ask your organization owner to upgrade Wordlyte.".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn license(plan: LicenseTier, expires_at: Option<u64>) -> License {
        License {
            version: 3,
            organization_id: "org_test".to_owned(),
            device_token: "device-token".to_owned(),
            machine_id: "machine".to_owned(),
            church_name: "Test Church".to_owned(),
            email: "owner@example.test".to_owned(),
            core_activated_at: 100,
            plan,
            plan_expires_at: expires_at,
            limits: LicenseLimits::for_plan(plan),
            ai: AiEntitlement::default(),
            max_machines: 1,
            machines_used: 1,
            last_validated_at: 100,
            last_seen_at: 100,
            status: "active".to_owned(),
            sig: "signature".to_owned(),
        }
    }

    #[test]
    fn free_activation_is_permanent() {
        let (tier, grace, message) = effective_tier(&license(LicenseTier::Free, None), 9_999_999);
        assert_eq!(tier, LicenseTier::Free);
        assert_eq!(grace, None);
        assert!(message.contains("Activated Free"));
    }

    #[test]
    fn expired_paid_plan_degrades_to_free() {
        let (tier, _, message) = effective_tier(&license(LicenseTier::Pro, Some(101)), 102);
        assert_eq!(tier, LicenseTier::Free);
        assert!(message.contains("continues on the Free"));
    }

    #[test]
    fn valid_cached_ai_token_avoids_a_network_round_trip() {
        let manager = LicenseManager {
            file: std::env::temp_dir().join("wordlyte-license-unused.json"),
            machine_id: "machine".to_owned(),
            license: Mutex::new(Some(license(LicenseTier::Pro, Some(9_999_999)))),
            verified: AtomicBool::new(true),
            server_url: "http://127.0.0.1:1".to_owned(),
            client: reqwest::Client::new(),
            ai_token: Mutex::new(Some(AiAccessInfo {
                token: "cached-token".to_owned(),
                expires_at: now_secs() + 3_600,
                ai: AiUnitBalance::default(),
            })),
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        let access = runtime
            .block_on(manager.ai_access())
            .expect("cached token should be returned");
        assert_eq!(access.token, "cached-token");
    }

    #[test]
    fn expired_paid_plan_uses_free_capacity_limits() {
        let manager = LicenseManager {
            file: std::env::temp_dir().join("wordlyte-license-unused.json"),
            machine_id: "machine".to_owned(),
            license: Mutex::new(None),
            verified: AtomicBool::new(true),
            server_url: "https://example.test".to_owned(),
            client: reqwest::Client::new(),
            ai_token: Mutex::new(None),
        };
        let mut paid = license(LicenseTier::Premium, Some(101));
        paid.last_seen_at = 0;
        let info = manager.evaluate(Some(paid), false);
        assert_eq!(info.tier, LicenseTier::Free);
        assert_eq!(info.limits, LicenseLimits::for_plan(LicenseTier::Free));
    }

    #[test]
    fn paid_plan_uses_cached_entitlement_within_grace() {
        let (tier, grace, _) = effective_tier(&license(LicenseTier::Premium, Some(9_999_999)), 101);
        assert_eq!(tier, LicenseTier::Premium);
        assert_eq!(grace, Some(100 + PAID_OFFLINE_GRACE_DAYS * 86_400));
    }

    #[test]
    fn stale_paid_entitlement_degrades_to_free_without_blocking_core() {
        let (tier, _, message) = effective_tier(
            &license(LicenseTier::Pro, Some(9_999_999)),
            100 + PAID_OFFLINE_GRACE_DAYS * 86_400 + 1,
        );
        assert_eq!(tier, LicenseTier::Free);
        assert!(message.contains("Core presentation remains available"));
    }

    #[test]
    fn v3_canonical_payload_is_stable() {
        let mut value = license(LicenseTier::Pro, Some(900));
        value.last_validated_at = 500;
        assert_eq!(
            canonical_license(&value),
            "wl3|org_test|machine|active|100|pro|900|1|1|500|4294967295|2|3|4294967295|1|0|0|0"
        );
    }
}
