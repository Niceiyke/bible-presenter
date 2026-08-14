use crate::remote::protocol::{RemotePermissions, RemoteRole};
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Pairing codes stay valid for 30 minutes — long enough for a volunteer to
/// walk across the room and type the code without it silently churning. Codes
/// are regenerated on demand and on expiry (see `ensure_pairing`), never
/// persisted, and remain single-use.
pub const PAIRING_TTL_SECS: u64 = 30 * 60;
/// Generous per-IP budget so a handful of mistyped codes doesn't lock a
/// volunteer out for a minute. Brute-forcing the 8-char un-confusable code
/// (≈52^8) over a full TCP+WS handshake per guess is not practical, so 30
/// tries/minute is still plenty restrictive while staying humane.
pub const PAIRING_RATE_LIMIT: usize = 30;
pub const PAIRING_RATE_WINDOW_SECS: u64 = 60;
pub const DEFAULT_LEASE_TTL_SECS: u64 = 10 * 60;
pub const COMMAND_RATE_LIMIT: usize = 30;
pub const COMMAND_RATE_WINDOW_SECS: u64 = 60;

pub fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Random opaque token (device tokens, etc.).
pub fn new_token() -> String {
    uuid::Uuid::new_v4().to_string().replace('-', "")
}

/// Generates a short random pairing code from a UUID (upper-case, un-confusable).
pub fn generate_pairing_code(token_len: usize) -> String {
    let uuid = new_token();
    let mut code = String::new();
    for c in uuid.chars() {
        let upper = c.to_ascii_uppercase();
        if code.len() >= token_len {
            break;
        }
        // Skip characters that are easy to confuse when typing by hand.
        if matches!(upper, '0' | 'O' | '1' | 'I') {
            continue;
        }
        code.push(upper);
    }
    code
}

#[derive(Debug, Clone)]
pub struct PairingCode {
    pub token_hash: String,
    pub created_at: u64,
    pub expires_at: u64,
    pub used: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StoredDevice {
    pub id: String,
    pub name: String,
    pub token_hash: String,
    pub role: RemoteRole,
    /// Content permissions; `serde(default)` keeps older device files loadable.
    /// Devices saved before this field existed are migrated in `load` to their
    /// role's preset so existing operators keep access until re-scoped.
    #[serde(default)]
    pub permissions: RemotePermissions,
    pub paired_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    PairingExpired,
    PairingAlreadyUsed,
    PairingUnknown,
    RateLimited,
    UnknownToken,
    Revoked,
    HandshakeTimeout,
}

impl AuthError {
    pub fn code(&self) -> &'static str {
        match self {
            AuthError::PairingExpired => "pairing_expired",
            AuthError::PairingAlreadyUsed => "pairing_used",
            AuthError::PairingUnknown => "pairing_unknown",
            AuthError::RateLimited => "rate_limited",
            AuthError::UnknownToken => "unknown_token",
            AuthError::Revoked => "revoked",
            AuthError::HandshakeTimeout => "handshake_timeout",
        }
    }

    pub fn message(&self) -> String {
        match self {
            AuthError::PairingExpired => "Pairing code has expired".into(),
            AuthError::PairingAlreadyUsed => "Pairing code has already been used".into(),
            AuthError::PairingUnknown => "Unknown pairing code".into(),
            AuthError::RateLimited => "Too many pairing attempts, try again later".into(),
            AuthError::UnknownToken => "Unknown device token".into(),
            AuthError::Revoked => "Device has been revoked".into(),
            AuthError::HandshakeTimeout => "Handshake timed out — please reconnect".into(),
        }
    }
}

/// Owns pairing codes and hashed device tokens. Device tokens are persisted to
/// disk so a paired phone can reconnect after Wordlyte restarts. Plaintext
/// tokens are never stored — only their SHA-256 hashes.
#[derive(Default)]
pub struct TokenStore {
    pairing: Mutex<HashMap<String, PairingCode>>,
    devices: Mutex<HashMap<String, StoredDevice>>,
    revoked: Mutex<Vec<String>>,
    pairing_attempts: Mutex<HashMap<String, Vec<u64>>>,
}

impl TokenStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn generate_pairing_code(&self) -> (String, PairingCode) {
        let token = generate_pairing_code(8);
        let hash = hash_token(&token);
        let now = now_unix();
        let code = PairingCode {
            token_hash: hash.clone(),
            created_at: now,
            expires_at: now + PAIRING_TTL_SECS,
            used: false,
        };
        self.pairing.lock().insert(hash.clone(), code.clone());
        (token, code)
    }

    pub fn regenerate_pairing_code(&self) -> (String, PairingCode) {
        self.pairing.lock().clear();
        self.generate_pairing_code()
    }

    pub fn pairing_expires_at(&self) -> Option<u64> {
        self.pairing.lock().values().next().map(|c| c.expires_at)
    }

    /// Validates a pairing token and enforces per-IP rate limiting. Does not
    /// consume the token — call `consume_pairing` only after issuing a device.
    pub fn validate_pairing(&self, token: &str, client_ip: &str) -> Result<(), AuthError> {
        let now = now_unix();

        {
            let mut attempts = self.pairing_attempts.lock();
            let list = attempts.entry(client_ip.to_string()).or_default();
            list.retain(|t| *t >= now.saturating_sub(PAIRING_RATE_WINDOW_SECS));
            if list.len() >= PAIRING_RATE_LIMIT {
                return Err(AuthError::RateLimited);
            }
            list.push(now);
        }

        let hash = hash_token(token);
        let pairing = self.pairing.lock();
        let code = pairing.get(&hash).ok_or(AuthError::PairingUnknown)?;
        if code.used {
            return Err(AuthError::PairingAlreadyUsed);
        }
        if code.expires_at < now {
            return Err(AuthError::PairingExpired);
        }
        Ok(())
    }

    pub fn consume_pairing(&self, token: &str) {
        let hash = hash_token(token);
        if let Some(code) = self.pairing.lock().get_mut(&hash) {
            code.used = true;
        }
    }

    pub fn register_device(
        &self,
        device_token: &str,
        name: String,
        role: RemoteRole,
    ) -> StoredDevice {
        let mut devices = self.devices.lock();
        let token_hash = hash_token(device_token);
        // Re-pairing the same physical device (same token) updates its name but
        // preserves its role and permissions — a re-pair must never silently
        // grant or revoke access, and the pairing code grants a read-only
        // device until the operator promotes it.
        if let Some(existing) = devices.values_mut().find(|d| d.token_hash == token_hash) {
            existing.name = name;
            let device = existing.clone();
            // Prevent the old token from every being treated as revoked.
            self.revoked.lock().retain(|h| h != &token_hash);
            return device;
        }
        let permissions = role.preset_permissions();
        let device = StoredDevice {
            id: new_token(),
            name,
            token_hash,
            role,
            permissions,
            paired_at: now_unix(),
            last_seen_at: None,
        };
        devices.insert(device.id.clone(), device.clone());
        device
    }

    pub fn authenticate_device(&self, token: &str) -> Result<StoredDevice, AuthError> {
        let hash = hash_token(token);
        if self.revoked.lock().contains(&hash) {
            return Err(AuthError::Revoked);
        }
        let devices = self.devices.lock();
        devices
            .values()
            .find(|d| d.token_hash == hash)
            .cloned()
            .ok_or(AuthError::UnknownToken)
    }

    pub fn touch_last_seen(&self, device_id: &str) {
        if let Some(d) = self.devices.lock().get_mut(device_id) {
            d.last_seen_at = Some(now_unix());
        }
    }

    pub fn revoke_device(&self, device_id: &str) -> bool {
        let mut devices = self.devices.lock();
        if let Some(device) = devices.remove(device_id) {
            self.revoked.lock().push(device.token_hash);
            true
        } else {
            false
        }
    }

    pub fn revoke_all(&self) -> usize {
        let mut devices = self.devices.lock();
        let count = devices.len();
        let revoked = &mut self.revoked.lock();
        for (_, d) in devices.drain() {
            revoked.push(d.token_hash);
        }
        count
    }

    pub fn list_devices(&self) -> Vec<StoredDevice> {
        let mut list: Vec<StoredDevice> = self.devices.lock().values().cloned().collect();
        list.sort_by_key(|b| std::cmp::Reverse(b.paired_at));
        list
    }

    pub fn device(&self, device_id: &str) -> Option<StoredDevice> {
        self.devices.lock().get(device_id).cloned()
    }

    /// Changes the role of a paired device. Returns false if the device is
    /// unknown. The new role is enforced immediately for the current socket by
    /// checking the token store (not a cached role) on every dispatch.
    ///
    /// Changing the role resets the device's permissions to that role's preset
    /// (a demotion to Viewer strips every permission; a promotion to Operator
    /// grants the full set). The operator can then override individual
    /// permissions with `set_permissions`.
    pub fn set_role(&self, device_id: &str, role: RemoteRole) -> bool {
        let mut devices = self.devices.lock();
        match devices.get_mut(device_id) {
            Some(d) => {
                d.role = role.clone();
                d.permissions = role.preset_permissions();
                true
            }
            None => false,
        }
    }

    /// Overrides the per-device permission flags without changing its role.
    /// Returns false if the device is unknown.
    pub fn set_permissions(&self, device_id: &str, permissions: RemotePermissions) -> bool {
        let mut devices = self.devices.lock();
        match devices.get_mut(device_id) {
            Some(d) => {
                d.permissions = permissions;
                true
            }
            None => false,
        }
    }

    pub fn persist(&self, path: &Path) -> std::io::Result<()> {
        let devices: Vec<StoredDevice> = self.list_devices();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let json = serde_json::to_string(&devices).unwrap_or_else(|_| "[]".into());
        // Write to a temp file and rename so a crash mid-write can never leave
        // a truncated `remote_devices.json` behind. A corrupt file would
        // otherwise silently clear every paired device token on the next load.
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    pub fn load(&self, path: &Path) {
        if let Ok(json) = std::fs::read_to_string(path) {
            // Deserialize into a raw value first so devices persisted before
            // `permissions` existed can be migrated: a device without the field
            // inherits its role's preset (existing operators keep access until
            // re-scoped) rather than silently dropping to read-only.
            if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&json) {
                if let Some(arr) = value.as_array_mut() {
                    for item in arr.iter_mut() {
                        if item.get("permissions").is_none() {
                            let preset = item
                                .get("role")
                                .and_then(|r| serde_json::from_value::<RemoteRole>(r.clone()).ok())
                                .unwrap_or_default()
                                .preset_permissions();
                            item["permissions"] = serde_json::to_value(preset).unwrap_or_default();
                        }
                    }
                }
                if let Ok(devices) = serde_json::from_value::<Vec<StoredDevice>>(value) {
                    let mut map = self.devices.lock();
                    map.clear();
                    for d in devices {
                        map.insert(d.id.clone(), d);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashing_is_deterministic_and_does_not_store_plaintext() {
        let a = hash_token("secret-token");
        let b = hash_token("secret-token");
        assert_eq!(a, b);
        assert_ne!(a, "secret-token");
    }

    #[test]
    fn pairing_token_is_single_use_and_expires() {
        let store = TokenStore::new();
        let (token, _) = store.generate_pairing_code();
        assert!(store.validate_pairing(&token, "127.0.0.1").is_ok());

        store.register_device("dev-token", "iPad".into(), RemoteRole::Operator);
        store.consume_pairing(&token);
        assert_eq!(store.validate_pairing(&token, "127.0.0.1"), Err(AuthError::PairingAlreadyUsed));
    }

    #[test]
    fn regenerating_invalidates_old_pairing() {
        let store = TokenStore::new();
        let (old_token, _) = store.generate_pairing_code();
        let (new_token, _) = store.regenerate_pairing_code();
        assert_ne!(old_token, new_token);
        assert_eq!(store.validate_pairing(&old_token, "10.0.0.1"), Err(AuthError::PairingUnknown));
        assert!(store.validate_pairing(&new_token, "10.0.0.1").is_ok());
    }

    #[test]
    fn pairing_is_rate_limited_per_ip() {
        let store = TokenStore::new();
        store.regenerate_pairing_code();
        let (token, _) = store.generate_pairing_code();

        // Force expiry checks out of the picture by consuming rate limit first.
        let mut results = Vec::new();
        for _ in 0..=PAIRING_RATE_LIMIT {
            results.push(store.validate_pairing(&token, "10.1.2.3"));
        }
        // The first PAIRING_RATE_LIMIT succeed, then the limiter trips.
        assert!(results[..PAIRING_RATE_LIMIT].iter().all(Result::is_ok));
        assert_eq!(results[PAIRING_RATE_LIMIT], Err(AuthError::RateLimited));
    }

    #[test]
    fn device_registration_and_revocation() {
        let store = TokenStore::new();
        let device = store.register_device("device-token-1", "Phone".into(), RemoteRole::Operator);
        assert_eq!(store.authenticate_device("device-token-1").unwrap().id, device.id);

        assert!(store.revoke_device(&device.id));
        assert!(matches!(store.authenticate_device("device-token-1"), Err(AuthError::Revoked)));
    }

    #[test]
    fn repairing_same_token_keps_device_id() {
        let store = TokenStore::new();
        let d1 = store.register_device("tok", "iPad".into(), RemoteRole::Operator);
        let d2 = store.register_device("tok", "iPad 2".into(), RemoteRole::Operator);
        assert_eq!(d1.id, d2.id);
        assert_eq!(d2.name, "iPad 2");
    }

    #[test]
    fn persist_and_load_round_trip() {
        let store = TokenStore::new();
        store.register_device("tok", "Phone".into(), RemoteRole::Viewer);
        let path = std::env::temp_dir().join(format!("remote_devices_test_{}.json", uuid::Uuid::new_v4()));
        store.persist(&path).unwrap();
        drop(store);
        let loaded = TokenStore::new();
        loaded.load(&path);
        let devices = loaded.list_devices();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].name, "Phone");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn persist_leaves_no_temp_file_behind() {
        let store = TokenStore::new();
        store.register_device("tok-atomic", "iPad".into(), RemoteRole::Operator);
        let base = std::env::temp_dir().join(format!("remote_devices_atomic_test_{}", uuid::Uuid::new_v4()));
        let path = base.with_extension("json");
        let tmp = base.with_extension("json.tmp");
        store.persist(&path).unwrap();
        assert!(path.exists());
        assert!(!tmp.exists(), "atomic persist left a temp file behind");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn pairing_code_avoids_confusable_characters() {
        let code = generate_pairing_code(8);
        assert_eq!(code.len(), 8);
        assert!(!code.contains('0') && !code.contains('O') && !code.contains('1') && !code.contains('I'));
    }

    #[test]
    fn new_device_gets_role_preset_permissions() {
        let store = TokenStore::new();
        let viewer = store.register_device("v", "Viewer".into(), RemoteRole::Viewer);
        assert!(!viewer.permissions.any());
        let operator = store.register_device("o", "Operator".into(), RemoteRole::Operator);
        assert!(operator.permissions.any());
        assert!(operator.permissions.scripture && operator.permissions.presentation);
    }

    #[test]
    fn re_pairing_preserves_role_and_permissions() {
        let store = TokenStore::new();
        store.register_device("tok", "iPad".into(), RemoteRole::Operator);
        let d = store.list_devices().into_iter().next().unwrap();
        // Demote to a partial operator: scripture only.
        let mut partial = d.permissions;
        partial.presentation = false;
        store.set_permissions(&d.id, partial);
        // Re-pair with the same token — name updates, role/permissions survive.
        let re = store.register_device("tok", "iPad 2".into(), RemoteRole::Viewer);
        assert_eq!(re.name, "iPad 2");
        assert_eq!(re.role, RemoteRole::Operator);
        assert!(!re.permissions.presentation);
        assert!(re.permissions.scripture);
    }

    #[test]
    fn set_role_resets_permissions_to_preset() {
        let store = TokenStore::new();
        store.register_device("tok", "iPad".into(), RemoteRole::Operator);
        let d = store.list_devices().into_iter().next().unwrap();
        store.set_permissions(&d.id, RemotePermissions {
            scripture: false, song: false, camera: false, lower_third: false, presentation: false,
        });
        assert!(!store.device(&d.id).unwrap().permissions.any());
        store.set_role(&d.id, RemoteRole::Operator);
        assert!(store.device(&d.id).unwrap().permissions.any());
        store.set_role(&d.id, RemoteRole::Viewer);
        assert!(!store.device(&d.id).unwrap().permissions.any());
    }

    #[test]
    fn load_migrates_legacy_devices_to_role_preset() {
        // A file persisted before `permissions` existed: an operator device
        // without the field must inherit full access, a viewer none.
        let json = serde_json::json!([
            { "id": "a", "name": "iPad", "token_hash": "h1", "role": "operator", "paired_at": 1 },
            { "id": "b", "name": "Tablet", "token_hash": "h2", "role": "viewer", "paired_at": 2 }
        ]);
        let path = std::env::temp_dir().join(format!("remote_devices_migrate_test_{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&path, json.to_string()).unwrap();
        let store = TokenStore::new();
        store.load(&path);
        let mut by_id = std::collections::HashMap::new();
        for d in store.list_devices() {
            by_id.insert(d.id.clone(), d);
        }
        assert!(by_id["a"].permissions.any());
        assert!(!by_id["b"].permissions.any());
        let _ = std::fs::remove_file(&path);
    }
}