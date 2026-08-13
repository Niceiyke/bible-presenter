pub mod assets;
pub mod auth;
pub mod commands;
pub mod hub;
pub mod protocol;
pub mod server;
pub mod sessions;
pub mod snapshot;

use auth::TokenStore;
use hub::RemoteHub;
use parking_lot::Mutex;
use protocol::RemoteEventKind;
use serde_json::json;
use sessions::{ConnectedDevices, ControllerLease};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

/// Runtime state for the Remote Control server. Lives inside `AppState`
/// (behind an `Arc` so Tauri state, the axum task, and display commands all
/// share one instance). Disabled by default; started/stopped through the
/// `remote_*` Tauri commands.
pub struct RemoteControl {
    /// Remote Control enablement (default off).
    pub enabled: AtomicBool,
    /// Bound address after a successful `start` (port 0 = random).
    pub bound_addr: Mutex<Option<std::net::SocketAddr>>,
    /// Directory that contains the compiled remote web bundle (and dist).
    pub files_dir: PathBuf,
    /// Persisted device token store (hashed tokens only).
    pub tokens: TokenStore,
    /// Event bus + revision counter shared with every connected client.
    pub hub: RemoteHub,
    /// Single-controller lease.
    pub lease: ControllerLease,
    /// Devices connected right now (for the "connected devices" UI).
    pub sessions: ConnectedDevices,
    /// Device-token persistence file.
    pub devices_file: PathBuf,
    /// Server task handle (kept to abort on disable).
    pub task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Plaintext pairing code kept in memory so the operator can display/scan
    /// it. Only its SHA-256 hash is ever persisted/validated.
    pub pairing_code_plain: Mutex<Option<(String, String, u64)>>,
}

impl RemoteControl {
    pub fn new(files_dir: PathBuf, app_data_dir: &Path) -> Self {
        let devices_file = app_data_dir.join("remote_devices.json");
        if let Some(dir) = devices_file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let control = Self {
            enabled: AtomicBool::new(false),
            bound_addr: Mutex::new(None),
            files_dir,
            tokens: TokenStore::new(),
            hub: RemoteHub::new(),
            lease: ControllerLease::new(),
            sessions: ConnectedDevices::new(),
            devices_file: devices_file.clone(),
            task: Mutex::new(None),
            pairing_code_plain: Mutex::new(None),
        };
        control.tokens.load(&devices_file);
        control
    }

    pub fn bound_addr(&self) -> Option<std::net::SocketAddr> {
        *self.bound_addr.lock()
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub fn persist_devices(&self) {
        let _ = self.tokens.persist(&self.devices_file);
    }

    /// Returns a fresh pairing code, reusing the current one while it is
    /// still valid.
    pub fn ensure_pairing(&self) -> String {
        if let Some((code, _, expires_at)) = self.pairing_code_plain.lock().as_ref() {
            if !code.is_empty() && *expires_at > auth::now_unix() {
                return code.clone();
            }
        }
        self.generate_pairing()
    }

    /// Generates a new pairing code and keeps its plaintext for display.
    pub fn generate_pairing(&self) -> String {
        let (token, code) = self.tokens.generate_pairing_code();
        *self.pairing_code_plain.lock() = Some((token.clone(), code.token_hash, code.expires_at));
        token
    }

    pub fn token_for_display(&self) -> String {
        self.ensure_pairing()
    }

    /// Invalidates the current pairing code and issues a new one.
    pub fn regenerate_pairing(&self) -> String {
        let (token, code) = self.tokens.regenerate_pairing_code();
        *self.pairing_code_plain.lock() = Some((token.clone(), code.token_hash, code.expires_at));
        token
    }

    pub fn hub_publish_controller_changed(&self) {
        self.hub
            .publish(RemoteEventKind::ControllerChanged, json!({ "controller_state": self.lease.state() }), None);
    }
}

/// The desktop operator can always reclaim control.
pub const DESKTOP_CONTROLLER_ID: &str = "main-console";

/// Build the public LAN URLs the operator can open / scan.
pub fn public_urls(files_dir: &PathBuf, addr: &std::net::SocketAddr) -> Vec<String> {
    let _ = files_dir;
    let port = addr.port();
    match primary_local_ip() {
        Some(ip) => vec![format!("http://{}:{}/remote", ip, port)],
        None => vec![format!("http://127.0.0.1:{}/remote", port)],
    }
}

/// Finds the "primary" LAN IPv4 using the connect-UDP trick (no extra crate).
pub fn primary_local_ip() -> Option<std::net::IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    // 8.8.8.8 is only used to force the OS to pick a route; no packets are sent.
    socket.connect("8.8.8.8:80").ok()?;
    let local = socket.local_addr().ok()?;
    Some(local.ip())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_are_formed_with_random_port() {
        let urls = public_urls(&PathBuf::new(), &"0.0.0.0:43211".parse().unwrap());
        assert!(!urls.is_empty());
        assert!(urls[0].ends_with("/remote"));
    }
}