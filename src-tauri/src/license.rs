use base64::Engine as _;
use crate::state::AppState;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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
/// The on-disk bytes are DPAPI-encrypted (Windows) and the record itself is
/// Ed25519-signed by the license server, so a hand-edited or copied file can
/// never pass verification.
const LICENSE_FILE: &str = "license.json";

/// Ed25519 public key (RFC 8032, raw 32 bytes, base64) whose private half only
/// the Wordlyte license Worker (`workers/license/`) ever holds. The client
/// verifies every server response and every persisted record with this key.
/// Regenerate with `workers/license/scripts/generate-keypair.mjs`; the worker's
/// `LICENSE_SIGN_PRIVATE_KEY` secret MUST match this key or the app refuses
/// every response as unverifiable.
const SIGNING_PUBLIC_KEY_B64: &str = "vMwGfNDpuoMjxC3SryLnSwocE0yGlmgoSNCC2R2J9Xs=";

/// License validation endpoint (Cloudflare Worker). Deploy the worker in
/// `workers/license/`, then replace the host below. `WORDLYTE_LICENSE_URL`
/// overrides it for testing — overriding it does NOT grant anything, because
/// a stubbed server cannot produce a valid Ed25519 signature.
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
    /// Bad key, the record was activated on a different computer, the key's
    /// device slot was consumed elsewhere, OR the local record failed
    /// signature verification (tampered / copied / stubbed endpoint).
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

/// Wire name used in the signed canonical payload (matches the Worker's `tier`).
fn tier_str(tier: LicenseTier) -> &'static str {
    match tier {
        LicenseTier::Free => "free",
        LicenseTier::Pro => "pro",
        LicenseTier::Premium => "premium",
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
///
/// v2: the server signs every authoritative field over `canonical_license`.
/// The client stores exactly what the server returned, so any local edit or
/// copy to another machine invalidates the signature and the app fails closed
/// to `Invalid` (repairable only by an online revalidation). `last_seen_at` is
/// the only locally-maintained field and is NOT covered by the signature — it
/// only powers the clock-rollback tripwire and cannot extend expiry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct License {
    pub version: u32,
    pub license_key: String,
    /// SHA-256 hex of the machine fingerprint this license is bound to
    /// (echoed and signed by the server at validation time).
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
    /// (used to detect clock rollback; local-only, not signed).
    #[serde(default)]
    pub last_seen_at: u64,
    /// Server-reported status for the signed record ("active"/"expired"/"revoked").
    #[serde(default)]
    pub status: String,
    /// Base64 Ed25519 signature over the authoritative fields, produced by the
    /// license Worker (`canonical_license`).
    #[serde(default)]
    pub sig: String,
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
    machine_id: Option<String>,
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
    #[serde(default)]
    sig: Option<String>,
}

/// Shared, Arc-managed license state. Persisted to `license.json` under the
/// app data dir (same pattern as `outputs.json` / `remote_devices.json`).
pub struct LicenseManager {
    pub file: PathBuf,
    /// SHA-256 hash of this machine's fingerprint — the id sent to the server
    /// and the binding stored in the license record.
    pub machine_id: String,
    license: Mutex<Option<License>>,
    /// A loaded record passed Ed25519 verification (or a server response was
    /// verified and persisted). While false the app fails closed to `Invalid`.
    verified: AtomicBool,
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

// ── Ed25519 signature verification ─────────────────────────────────────
// Field order is part of the protocol: it MUST match `signValidation` in
// `workers/license/src/index.js`. Never reorder or rename the fields.

/// Canonical string the Worker signs and the client verifies for a persisted record.
fn canonical_license(lic: &License) -> String {
    format!(
        "wl2|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        lic.license_key,
        lic.machine_id,
        lic.status,
        lic.issued_at,
        lic.expires_at,
        tier_str(lic.tier),
        lic.max_machines,
        lic.machines_used,
        lic.last_validated_at
    )
}

fn verifying_key() -> Option<ed25519_dalek::VerifyingKey> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(SIGNING_PUBLIC_KEY_B64.trim())
        .ok()?;
    let arr: [u8; 32] = bytes[..].try_into().ok()?;
    ed25519_dalek::VerifyingKey::from_bytes(&arr).ok()
}

fn verify_signature_with(vk: &ed25519_dalek::VerifyingKey, canonical: &[u8], sig_b64: &str) -> bool {
    let Ok(sig_bytes) = base64::engine::general_purpose::STANDARD.decode(sig_b64.trim()) else {
        return false;
    };
    let Ok(sig) = ed25519_dalek::Signature::from_slice(&sig_bytes) else {
        return false;
    };
    vk.verify_strict(canonical, &sig).is_ok()
}

/// Verify a persisted record against the embedded public key.
/// Any tampered/copied record (or a record minted by a stubbed endpoint)
/// fails here, so the app fails closed to `Invalid`.
fn verify_license_sig(lic: &License) -> bool {
    if lic.version != 2 || lic.sig.trim().is_empty() {
        return false;
    }
    let Some(vk) = verifying_key() else { return false };
    verify_signature_with(&vk, canonical_license(lic).as_bytes(), &lic.sig)
}

/// Verify a fresh server response before trusting/persisting it (embedded key).
fn verify_server_payload(sv: &ServerValidation, key: &str) -> bool {
    match verifying_key() {
        Some(vk) => verify_server_payload_with(&vk, sv, key),
        None => false,
    }
}

/// Verification against an explicit key — the production path passes the
/// embedded public key; tests pass a key they signed with. Never reorder the
/// canonical fields (see `canonical_license` / the Worker's `signValidation`).
fn verify_server_payload_with(
    vk: &ed25519_dalek::VerifyingKey,
    sv: &ServerValidation,
    key: &str,
) -> bool {
    let canonical = format!(
        "wl2|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        key,
        sv.machine_id.as_deref().unwrap_or_default(),
        sv.status,
        sv.issued_at.unwrap_or(0),
        sv.expires_at.unwrap_or(0),
        sv.tier.as_deref().unwrap_or("free"),
        sv.max_machines.unwrap_or(0),
        sv.machines_used.unwrap_or(0),
        sv.server_time.unwrap_or(0)
    );
    verify_signature_with(vk, canonical.as_bytes(), sv.sig.as_deref().unwrap_or_default())
}

// ── At-rest storage ────────────────────────────────────────────────────
// Windows: DPAPI-encrypt (current-user scope, no UI) so casual copy/inspection
// of `license.json` yields ciphertext. The signature above is the real
// integrity control — DPAPI just keeps the plaintext out of a text editor and
// prevents copying the file to another user/machine.
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

    fn collect(out: &CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) };
        bytes.to_vec()
    }

    /// Release a blob that `CryptProtectData`/`CryptUnprotectData` allocated.
    fn free_blob(out: &CRYPT_INTEGER_BLOB) {
        unsafe {
            if !out.pbData.is_null() {
                LocalFree(Some(HLOCAL(out.pbData.cast())));
            }
        }
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
            .map_err(|e| format!("CryptProtectData failed: {}", e))?;
        }
        let result = collect(&out);
        free_blob(&out);
        Ok(result)
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        let mut out = CRYPT_INTEGER_BLOB::default();
        let mut descr = PWSTR::null();
        unsafe {
            CryptUnprotectData(
                &blob(data),
                Some(&mut descr),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
            .map_err(|e| format!("CryptUnprotectData failed: {}", e))?;
        }
        let result = collect(&out);
        free_blob(&out);
        if !descr.is_null() {
            unsafe {
                LocalFree(Some(HLOCAL(descr.as_ptr().cast())));
            }
        }
        Ok(result)
    }
}

#[cfg(not(windows))]
mod storage {
    // Non-Windows builds (compile-only targets) store the record in the clear.
    // The signature verification still prevents forgery; there is simply no
    // at-rest encryption on these platforms.
    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        Ok(data.to_vec())
    }
    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        Ok(data.to_vec())
    }
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
    if lic.status == "revoked" {
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
        let (license, verified) = Self::load(&file);
        Self {
            file,
            machine_id,
            license: Mutex::new(license),
            verified: AtomicBool::new(verified),
            server_url: default_server_url(),
            // Bound both connect and total request time so a hung network or a
            // stuck license endpoint can never block the app indefinitely
            // (a license refresh runs on the operator path).
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        }
    }

    /// Read + decrypt + verify the on-disk record. Returns `(Some(license), verified)`.
    /// A record that exists but fails signature verification is still surfaced
    /// (so `refresh` can re-validate its key online and migrate it to a verified
    /// v2 record) but is treated as `Invalid` until then. An unparseable file is
    /// treated as absent, which forces a fresh activation.
    fn load(path: &Path) -> (Option<License>, bool) {
        let raw = match std::fs::read(path) {
            Ok(r) => r,
            Err(_) => return (None, false),
        };
        // Path a: DPAPI-encrypted v2 record.
        if let Ok(plain) = storage::unprotect(&raw) {
            if let Ok(lic) = serde_json::from_slice::<License>(&plain) {
                let verified = verify_license_sig(&lic);
                return (Some(lic), verified);
            }
            // Decrypted fine but not a v2 record — fall through.
        }
        // Path b: legacy plaintext record (pre-signing schema, e.g. an existing
        // install before this upgrade). Parse it so refresh() can re-validate
        // the stored key against the server; it is unverified until then.
        if let Ok(lic) = serde_json::from_slice::<License>(&raw) {
            return (Some(lic), false);
        }
        (None, false)
    }

    fn persist(&self, lic: &License) -> Result<(), String> {
        let json = serde_json::to_vec_pretty(lic).map_err(|e| e.to_string())?;
        let encrypted = storage::protect(&json).map_err(|e| e.to_string())?;
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&self.file, encrypted).map_err(|e| e.to_string())
    }

    fn set_license(&self, lic: License) -> Result<(), String> {
        self.persist(&lic)?;
        *self.license.lock() = Some(lic);
        self.verified.store(true, Ordering::SeqCst);
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

        // Fail closed: any record that failed signature verification (tampered,
        // or copied from another machine) is blocked even if its fields look
        // generous. Only a successful online revalidation clears the flag.
        if !self.verified.load(Ordering::SeqCst) {
            return LicenseStatusInfo {
                status: LicenseStatus::Invalid,
                license_key: Some(mask_key(&lic.license_key)),
                church_name: Some(lic.church_name.clone()),
                email: Some(lic.email.clone()),
                issued_at: Some(lic.issued_at),
                expires_at: Some(lic.expires_at),
                machine_id_hash: self.machine_id.clone(),
                tier: lic.tier,
                max_machines: lic.max_machines,
                machines_used: lic.machines_used,
                last_validated_at: Some(lic.last_validated_at),
                grace_until: Some(lic.last_validated_at.saturating_add(grace_days(lic.tier) * 86400)),
                offline,
                message: "This computer's license record could not be verified. Connect to the internet and refresh the license to restore it.".to_owned(),
            };
        }

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
            // Only advance the anchor for verified records; an unverified
            // record must not be re-persisted (it is repaired by refresh).
            if self.verified.load(Ordering::SeqCst) {
                if let Some(lic) = guard.as_mut() {
                    if now > lic.last_seen_at {
                        lic.last_seen_at = now;
                        let _ = self.persist(lic);
                    }
                }
            }
        }
        self.evaluate(self.license.lock().clone(), false)
    }

    /// Validate a license key against the server and, on success, persist it
    /// bound to this machine. Fails with a descriptive error when the server
    /// cannot be reached, rejects the key, or its response cannot be verified
    /// (a stubbed `WORDLYTE_LICENSE_URL` endpoint fails here).
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
        if !verify_server_payload(&sv, &key) {
            return Err(
                "The license server response could not be verified. If you changed WORDLYTE_LICENSE_URL, restore the official license endpoint and try again."
                    .to_owned(),
            );
        }
        if let Some(mid) = &sv.machine_id {
            if !mid.eq_ignore_ascii_case(&self.machine_id) {
                return Err("This key was validated for a different computer.".to_owned());
            }
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
            version: 2,
            license_key: key,
            machine_id: sv.machine_id.clone().unwrap_or_else(|| self.machine_id.clone()),
            church_name: sv.church_name.clone().unwrap_or_default(),
            email: sv.email.clone().unwrap_or_default(),
            issued_at: sv.issued_at.unwrap_or(server_now),
            expires_at: sv.expires_at.unwrap_or(server_now),
            tier: parse_tier(&sv.tier),
            max_machines: sv.max_machines.unwrap_or(1),
            machines_used: sv.machines_used.unwrap_or(1),
            last_validated_at: server_now,
            last_seen_at: server_now,
            status: sv.status.clone(),
            sig: sv.sig.clone().unwrap_or_default(),
        };
        self.set_license(lic)?;
        Ok(self.status())
    }

    /// Re-validate the stored license online. Applies authoritative server
    /// fields (expiry, revocation, machine slots) and updates the offline
    /// anchor. Falls back to the local status with `offline: true` when the
    /// server is unreachable, so a church PC without internet keeps working
    /// through the grace window. Any response that fails signature verification
    /// blocks the record (see `LicenseStatus::Invalid`).
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
            Ok(sv) => {
                // Only statuses the app persists as a record are signed-and-stored.
                if !matches!(sv.status.as_str(), "active" | "expired" | "revoked") {
                    let mut info = self.evaluate(Some(lic), false);
                    info.status = LicenseStatus::Invalid;
                    info.message = sv
                        .message
                        .clone()
                        .unwrap_or_else(|| {
                            "This license is no longer valid on the license server. Contact the Wordlyte team."
                                .to_owned()
                        });
                    return Ok(info);
                }
                // The real anti-stub gate: a forged/stubbed endpoint cannot
                // produce a valid signature, so the record stays blocked.
                if !verify_server_payload(&sv, &lic.license_key) {
                    let mut info = self.evaluate(Some(lic), false);
                    info.status = LicenseStatus::Invalid;
                    info.message =
                        "The license server response could not be verified. Restore the official license endpoint and refresh."
                            .to_owned();
                    return Ok(info);
                }
                if let Some(st) = sv.server_time {
                    if now.abs_diff(st) > CLOCK_TOLERANCE_SECS {
                        let mut info = self.evaluate(Some(lic), false);
                        info.status = LicenseStatus::ClockTampered;
                        info.message =
                            "The system clock differs from the license server. Fix the date and time, then refresh.".to_owned();
                        return Ok(info);
                    }
                }
                let server_now = sv.server_time.unwrap_or(now);
                let updated = License {
                    version: 2,
                    license_key: lic.license_key.clone(),
                    machine_id: sv.machine_id.clone().unwrap_or_else(|| self.machine_id.clone()),
                    church_name: sv.church_name.clone().unwrap_or(lic.church_name.clone()),
                    email: sv.email.clone().unwrap_or(lic.email.clone()),
                    issued_at: sv.issued_at.unwrap_or(lic.issued_at),
                    expires_at: sv.expires_at.unwrap_or(lic.expires_at),
                    tier: parse_tier(&sv.tier),
                    max_machines: sv.max_machines.unwrap_or(lic.max_machines),
                    machines_used: sv.machines_used.unwrap_or(lic.machines_used),
                    last_validated_at: server_now,
                    last_seen_at: now.max(lic.last_seen_at),
                    status: sv.status.clone(),
                    sig: sv.sig.clone().unwrap_or_default(),
                };
                self.set_license(updated)?;
                Ok(self.evaluate(self.license.lock().clone(), false))
            }
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
        self.verified.store(false, Ordering::SeqCst);
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

/// Background revalidation loop: one check shortly after startup, then every
/// ~6h (jittered) while the app runs. Keeps revocations, expiry changes, and
/// any forged/stale local record in sync with the authoritative signed server
/// state without waiting for the operator to open Settings → License.
/// Unactivated machines skip network I/O entirely (`refresh` short-circuits
/// when no record exists).
pub fn spawn_periodic_refresh(app: tauri::AppHandle) {
    use tauri::Manager;
    tauri::async_runtime::spawn(async move {
        let license = app.state::<AppState>().license.clone();
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        loop {
            if let Ok(info) = license.refresh().await {
                crate::commands::license::publish_license(&app, &info);
            }
            let base = std::time::Duration::from_secs(6 * 60 * 60);
            // Jitter so every install does not hit the endpoint on the same tick.
            let jitter = std::time::Duration::from_secs(now_secs() % 1800);
            tokio::time::sleep(base + jitter).await;
        }
    });
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
    use ed25519_dalek::{Signer, SigningKey};

    fn lic(mutate: impl FnOnce(&mut License)) -> License {
        let mut l = License {
            version: 2,
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
            status: "active".to_owned(),
            sig: String::new(),
        };
        mutate(&mut l);
        l
    }

    /// Sign a `License` like the Worker does, so tests exercise the real verify path.
    fn sign_license(l: &mut License, sk: &SigningKey) {
        l.sig = base64::engine::general_purpose::STANDARD
            .encode(sk.sign(canonical_license(l).as_bytes()).to_bytes());
    }

    fn test_signing_key() -> SigningKey {
        let mut seed = [0u8; 32];
        seed[0] = 7;
        SigningKey::from_bytes(&seed)
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
        let l = lic(|l| l.status = "revoked".to_owned());
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

    #[test]
    fn signed_record_verifies_and_tampering_breaks_it() {
        let sk = test_signing_key();
        let mut l = lic(|l| {
            l.tier = LicenseTier::Pro;
            l.max_machines = 3;
            l.machines_used = 2;
        });
        sign_license(&mut l, &sk);

        // Verification path uses the same embedded public key we built the
        // signature with (hermetic: the canonical string + dalek verify).
        let vk = sk.verifying_key();
        let ok = verify_signature_with(&vk, canonical_license(&l).as_bytes(), &l.sig);
        assert!(ok, "signature must verify against the signing key");

        // Tampering with ANY signed field must invalidate the record.
        let mut t1 = l.clone();
        t1.tier = LicenseTier::Premium;
        let ok1 = verify_signature_with(&vk, canonical_license(&t1).as_bytes(), &t1.sig);
        assert!(!ok1, "tier edit must break the signature");

        let mut t2 = l.clone();
        t2.expires_at = 4_102_444_800;
        let ok2 = verify_signature_with(&vk, canonical_license(&t2).as_bytes(), &t2.sig);
        assert!(!ok2, "expiry edit must break the signature");

        let mut t3 = l.clone();
        t3.machine_id = "attacker-controlled".to_owned();
        let ok3 = verify_signature_with(&vk, canonical_license(&t3).as_bytes(), &t3.sig);
        assert!(!ok3, "machine-id edit must break the signature");
    }

    #[test]
    fn unsigned_or_version_one_records_never_verify() {
        let l = lic(|_| {});
        assert!(!verify_license_sig(&l), "empty sig must fail verification");
        let mut v1 = lic(|_| {});
        v1.version = 1;
        sign_license(&mut v1, &test_signing_key());
        assert!(!verify_license_sig(&v1), "version 1 must never pass");
    }

    #[test]
    fn server_payload_verification_matches_worker() {
        // Reproduce exactly what the Worker signs (see `signValidation`).
        let sk = test_signing_key();
        let key = "WORDLYTE-TEST-TEST-TEST-TEST";
        struct Fields<'a> {
            machine_id: &'a str,
            status: &'a str,
            issued_at: u64,
            expires_at: u64,
            tier: &'a str,
            max_machines: u32,
            machines_used: u32,
            server_time: u64,
        }
        let f = Fields {
            machine_id: "m1",
            status: "active",
            issued_at: 100,
            expires_at: 1_000_000,
            tier: "pro",
            max_machines: 3,
            machines_used: 2,
            server_time: 600,
        };
        let canonical = format!(
            "wl2|{}|{}|{}|{}|{}|{}|{}|{}|{}",
            key, f.machine_id, f.status, f.issued_at, f.expires_at, f.tier, f.max_machines, f.machines_used, f.server_time
        );
        let sig = base64::engine::general_purpose::STANDARD.encode(sk.sign(canonical.as_bytes()).to_bytes());

        let sv = ServerValidation {
            status: f.status.to_string(),
            message: Some("ok".to_owned()),
            machine_id: Some(f.machine_id.to_owned()),
            expires_at: Some(f.expires_at),
            issued_at: Some(f.issued_at),
            church_name: Some("First Test Church".to_owned()),
            email: Some("test@church.org".to_owned()),
            max_machines: Some(f.max_machines),
            machines_used: Some(f.machines_used),
            tier: Some(f.tier.to_owned()),
            server_time: Some(f.server_time),
            sig: Some(sig),
        };
        assert!(verify_server_payload_with(&sk.verifying_key(), &sv, key));
        let mut forged = sv.clone();
        forged.tier = Some("premium".to_owned());
        assert!(!verify_server_payload_with(&sk.verifying_key(), &forged, key), "forged tier must fail");
        // The production verifier pins to the EMBEDDED public key — a response
        // signed by any other key must be rejected, not merely "unverified".
        assert!(
            !verify_server_payload(&sv, key),
            "a response signed by a non-production key must be rejected"
        );
    }

    #[test]
    fn embedded_public_key_decodes_and_matches_const() {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(SIGNING_PUBLIC_KEY_B64.trim())
            .expect("embedded key must be valid base64");
        assert_eq!(bytes.len(), 32, "Ed25519 public keys are 32 bytes");
        let vk = verifying_key().expect("embedded key must parse");
        assert_eq!(vk.to_bytes().as_slice(), bytes.as_slice());
    }

    #[test]
    fn canonical_format_is_the_protocol_shape() {
        let l = lic(|l| {
            l.tier = LicenseTier::Pro;
            l.max_machines = 3;
            l.machines_used = 2;
            l.last_validated_at = 600;
        });
        assert_eq!(
            canonical_license(&l),
            "wl2|WORDLYTE-TEST-TEST-TEST-TEST|m1|active|100|1000000|pro|3|2|600"
        );
    }

    #[test]
    fn signature_is_deterministic() {
        let sk = test_signing_key();
        let msg = canonical_license(&lic(|_| {}));
        let a = sk.sign(msg.as_bytes());
        let b = sk.sign(msg.as_bytes());
        assert_eq!(a.to_bytes(), b.to_bytes(), "Ed25519 is deterministic");
        assert_eq!(a.to_bytes().len(), 64);
    }
}