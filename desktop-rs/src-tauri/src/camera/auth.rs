use std::{
    collections::HashMap,
    time::{Duration, SystemTime},
};
use parking_lot::Mutex;
use hmac::{Hmac, Mac};
use sha2::Sha256;

const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(60);
const MAX_ATTEMPTS_PER_WINDOW: u32 = 10;
const LOCKOUT_DURATION: Duration = Duration::from_secs(15 * 60); // 15 min

struct AttemptRecord {
    count: u32,
    window_start: SystemTime,
    locked_until: Option<SystemTime>,
}

impl AttemptRecord {
    fn new() -> Self {
        Self {
            count: 0,
            window_start: SystemTime::now(),
            locked_until: None,
        }
    }

    fn is_locked(&self) -> bool {
        self.locked_until
            .map_or(false, |t| SystemTime::now() < t)
    }

    /// Record a failed attempt. Returns true if now locked out.
    fn record_failure(&mut self) -> bool {
        let now = SystemTime::now();
        if now
            .duration_since(self.window_start)
            .unwrap_or_default()
            > RATE_LIMIT_WINDOW
        {
            self.count = 0;
            self.window_start = now;
        }
        self.count += 1;
        if self.count >= MAX_ATTEMPTS_PER_WINDOW {
            self.locked_until = Some(now + LOCKOUT_DURATION);
            return true;
        }
        false
    }

    fn reset(&mut self) {
        self.count = 0;
        self.locked_until = None;
    }
}

pub struct AuthManager {
    /// Correct PIN
    pin: String,
    /// Per-IP rate limiter
    attempts: Mutex<HashMap<String, AttemptRecord>>,
}

impl AuthManager {
    pub fn new(pin: String) -> Self {
        Self {
            pin,
            attempts: Mutex::new(HashMap::new()),
        }
    }

    /// Verify a PIN from the given peer address (for rate limiting).
    /// Returns Ok(()) on success, Err(reason) on failure.
    pub fn verify_pin(&self, pin: &str, peer_ip: &str) -> Result<(), &'static str> {
        let mut map = self.attempts.lock();
        let record = map
            .entry(peer_ip.to_owned())
            .or_insert_with(AttemptRecord::new);

        if record.is_locked() {
            return Err("Too many failed attempts. Try again later.");
        }

        if pin == self.pin {
            record.reset();
            Ok(())
        } else {
            record.record_failure();
            Err("Invalid PIN")
        }
    }

    pub fn pin(&self) -> &str {
        &self.pin
    }
}

/// Generate a random 6-digit PIN string.
pub fn generate_pin() -> String {
    use rand::Rng;
    let n: u32 = rand::thread_rng().gen_range(100_000..=999_999);
    n.to_string()
}

// ─── Device Token Manager ─────────────────────────────────────────────────────

/// Token lifetime — mobile devices re-authenticate after this period.
const TOKEN_TTL: Duration = Duration::from_secs(30 * 24 * 3600); // 30 days

/// Issues and validates HMAC-signed device tokens so mobile cameras do not
/// need to re-enter the PIN on every reconnect.
///
/// Token format (URL-safe base64 of `device_id|issued_ms|hmac`).
pub struct DeviceTokenManager {
    secret: Vec<u8>,
    /// Revocation list: tokens that have been explicitly invalidated (e.g. kick).
    revoked: Mutex<std::collections::HashSet<String>>,
}

impl DeviceTokenManager {
    /// Create a new manager.  `secret` should be a long random byte string
    /// unique to this installation (derived from the PIN + a persistent random
    /// salt stored alongside the TLS cert works well).
    pub fn new(secret: Vec<u8>) -> Self {
        Self {
            secret,
            revoked: Mutex::new(std::collections::HashSet::new()),
        }
    }

    /// Issue a token for `device_id`.
    pub fn issue(&self, device_id: &str) -> String {
        let issued_ms = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let payload = format!("{}|{}", device_id, issued_ms);
        let sig = self.sign(payload.as_bytes());
        // Encode as base64url: `{payload_b64}.{sig_b64}`
        let payload_b64 = base64_url_encode(payload.as_bytes());
        let sig_b64     = base64_url_encode(&sig);
        format!("{}.{}", payload_b64, sig_b64)
    }

    /// Validate a token. Returns the `device_id` on success.
    pub fn verify(&self, token: &str) -> Result<String, &'static str> {
        if self.revoked.lock().contains(token) {
            return Err("Token revoked");
        }
        let (payload_b64, sig_b64) = token.split_once('.').ok_or("Malformed token")?;
        let payload_bytes = base64_url_decode(payload_b64).ok_or("Malformed token")?;
        let sig_bytes     = base64_url_decode(sig_b64).ok_or("Malformed token")?;

        // Constant-time MAC verification
        let expected = self.sign(&payload_bytes);
        if expected.len() != sig_bytes.len()
            || expected.iter().zip(&sig_bytes).any(|(a, b)| a != b)
        {
            return Err("Invalid token signature");
        }

        let payload = std::str::from_utf8(&payload_bytes).map_err(|_| "Malformed token")?;
        let mut parts = payload.splitn(2, '|');
        let device_id  = parts.next().ok_or("Malformed token")?;
        let issued_ms: u64 = parts.next().ok_or("Malformed token")?.parse().map_err(|_| "Malformed token")?;

        // Check TTL
        let issued = SystemTime::UNIX_EPOCH + Duration::from_millis(issued_ms);
        if SystemTime::now().duration_since(issued).unwrap_or(Duration::MAX) > TOKEN_TTL {
            return Err("Token expired");
        }

        Ok(device_id.to_string())
    }

    /// Revoke a specific token (e.g. when a device is kicked).
    pub fn revoke(&self, token: &str) {
        self.revoked.lock().insert(token.to_owned());
    }

    fn sign(&self, data: &[u8]) -> Vec<u8> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.secret)
            .expect("HMAC accepts any key size");
        mac.update(data);
        mac.finalize().into_bytes().to_vec()
    }
}

fn base64_url_encode(data: &[u8]) -> String {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    URL_SAFE_NO_PAD.encode(data)
}

fn base64_url_decode(s: &str) -> Option<Vec<u8>> {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    URL_SAFE_NO_PAD.decode(s).ok()
}
