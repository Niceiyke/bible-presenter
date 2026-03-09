use std::{
    collections::HashMap,
    time::{Duration, SystemTime},
};
use parking_lot::Mutex;

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
