pub mod assets;
pub mod auth;
pub mod commands;
pub mod hub;
pub mod protocol;
pub mod server;
pub mod sessions;
pub mod snapshot;
pub mod tls;

use auth::TokenStore;
use hub::RemoteHub;
use parking_lot::Mutex;
use protocol::RemoteEventKind;
use serde_json::json;
use sessions::{ConnectedDevices, ControllerLease};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Runtime state for the Remote Control server. Lives inside `AppState`
/// (behind an `Arc` so Tauri state, the axum task, and display commands all
/// share one instance). Disabled by default; started/stopped through the
/// `remote_*` Tauri commands.
pub struct RemoteControl {
    /// Remote Control enablement (default off).
    pub enabled: AtomicBool,
    /// Serializes `remote_enable` so two rapid toggles can't double-bind.
    pub start_lock: tokio::sync::Mutex<()>,
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
    /// Sliding-window mutating-command history per device (rate limiting).
    pub mutation_history: Mutex<HashMap<String, Vec<u64>>>,
    /// Device-token persistence file.
    pub devices_file: PathBuf,
    /// File holding the last-bound remote port so restarts reuse it instead of
    /// jumping to a new random port (which would orphan phones' saved URLs).
    pub port_file: PathBuf,
    /// File holding the persisted self-signed TLS certificate + key. Serving
    /// the remote bundle over HTTPS makes the phone's page a secure context so
    /// `getUserMedia` (phone camera) works over the LAN.
    pub tls_file: PathBuf,
    /// Server task handle (kept to abort on disable).
    pub task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Plaintext pairing code kept in memory so the operator can display/scan
    /// it. Only its SHA-256 hash is ever persisted/validated.
    pub pairing_code_plain: Mutex<Option<(String, String, u64)>>,
    /// Active phone cameras with their WebRTC peer connections.
    pub phone_cameras: Arc<RwLock<HashMap<String, PhoneCamera>>>,
}

/// Represents a phone camera connected via WebRTC. The backend does not
/// terminate the peer connection — it only acts as a signaling relay: the
/// *operator window* hosts the answering `RTCPeerConnection` (WebView2 speaks
/// WebRTC natively) while the phone is the offerer, and media flows directly
/// phone <-> operator window over the LAN. The backend tracks ownership so
/// operator answers/ICE can be routed back to the correct phone.
#[derive(Clone)]
pub struct PhoneCamera {
    /// Prefixed id, e.g. "phone-camera-<raw>", also used as the DisplayItem
    /// device id so the operator window can correlate a stream with an item.
    pub device_id: String,
    /// The id the phone itself used, e.g. "<raw>". Events relayed back to the
    /// phone carry this so the phone can match its own device.
    pub raw_device_id: String,
    pub device_name: String,
    /// The remote Control device.id that owns this camera (used to target
    /// operator->phone signaling back to the right phone).
    pub owner_device_id: String,
}

impl RemoteControl {
    pub fn new(files_dir: PathBuf, app_data_dir: &Path) -> Self {
        let devices_file = app_data_dir.join("remote_devices.json");
        if let Some(dir) = devices_file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let control = Self {
            enabled: AtomicBool::new(false),
            start_lock: tokio::sync::Mutex::new(()),
            bound_addr: Mutex::new(None),
            files_dir,
            tokens: TokenStore::new(),
            hub: RemoteHub::new(),
            lease: ControllerLease::new(),
            sessions: ConnectedDevices::new(),
            mutation_history: Mutex::new(HashMap::new()),
            devices_file: devices_file.clone(),
            port_file: app_data_dir.join("remote_port.txt"),
            tls_file: app_data_dir.join("remote_tls.json"),
            task: Mutex::new(None),
            pairing_code_plain: Mutex::new(None),
            phone_cameras: Arc::new(RwLock::new(HashMap::new())),
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

    /// Returns the port bound on the last run, if any. Used so `start` can
    /// re-bind the same port and keep phones' saved URLs working across app
    /// restarts.
    pub fn stored_port(&self) -> Option<u16> {
        std::fs::read_to_string(&self.port_file)
            .ok()
            .and_then(|s| s.trim().parse::<u16>().ok())
            .filter(|p| *p > 0)
    }

    /// Records the port that was successfully bound so the next app start can
    /// reuse it. Written to a temp file and renamed to stay atomic.
    pub fn persist_port(&self, port: u16) {
        let _ = std::fs::create_dir_all(self.port_file.parent().unwrap_or(std::path::Path::new(".")));
        let tmp = self.port_file.with_extension("txt.tmp");
        if std::fs::write(&tmp, port.to_string()).is_ok() {
            let _ = std::fs::rename(&tmp, &self.port_file);
        }
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

    /// Expiry of the pairing code currently shown in the operator UI. Derived
    /// from the in-memory plaintext record so it always matches the displayed
    /// code (the token store's map can hold stale entries from regenerations).
    pub fn pairing_expires_at(&self) -> Option<u64> {
        self.pairing_code_plain
            .lock()
            .as_ref()
            .filter(|(code, _, _)| !code.is_empty())
            .map(|(_, _, expires_at)| *expires_at)
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

    /// Sliding-window budget for mutating commands per connected device. A
    /// device cannot exceed `COMMAND_RATE_LIMIT` mutations within
    /// `COMMAND_RATE_WINDOW_SECS`; extra attempts are rejected (not queued).
    /// Read-only commands are unaffected.
    pub fn allow_mutating(&self, device_id: &str) -> bool {
        use crate::remote::auth::{now_unix, COMMAND_RATE_LIMIT, COMMAND_RATE_WINDOW_SECS};
        let now = now_unix();
        let mut map = self.mutation_history.lock();
        let list = map.entry(device_id.to_string()).or_default();
        list.retain(|t| *t >= now.saturating_sub(COMMAND_RATE_WINDOW_SECS));
        if list.len() >= COMMAND_RATE_LIMIT {
            return false;
        }
        list.push(now);
        true
    }

    /// Register a phone camera device. Called when a remote client sends
    /// `camera.start` command. `owner_device_id` is the remote Control
    /// session id of the phone so operator->phone signaling can be targeted.
    pub async fn register_phone_camera(&self, device_id: &str, raw_device_id: &str, device_name: &str, owner_device_id: &str) {
        let camera = PhoneCamera {
            device_id: device_id.to_string(),
            raw_device_id: raw_device_id.to_string(),
            device_name: device_name.to_string(),
            owner_device_id: owner_device_id.to_string(),
        };
        self.phone_cameras.write().await.insert(device_id.to_string(), camera);
    }

    /// Unregister a phone camera device. Called when a remote client sends
    /// `camera.stop` command or disconnects.
    pub async fn unregister_phone_camera(&self, device_id: &str) {
        self.phone_cameras.write().await.remove(device_id);
    }

    /// Looks up the owner (remote Control session id) for a registered phone
    /// camera, if any. Used to route operator answers/ICE to the right phone.
    pub async fn phone_camera_owner(&self, device_id: &str) -> Option<String> {
        self.phone_cameras.read().await.get(device_id).map(|c| c.owner_device_id.clone())
    }

    /// Returns both the raw id the phone itself uses (for matching events on
    /// the phone) and the owner session id (for routing), given the prefixed
    /// DisplayItem device id.
    pub async fn phone_camera_route(&self, device_id: &str) -> Option<(String, String)> {
        self.phone_cameras
            .read()
            .await
            .get(device_id)
            .map(|c| (c.raw_device_id.clone(), c.owner_device_id.clone()))
    }
}

/// The desktop operator can always reclaim control.
pub const DESKTOP_CONTROLLER_ID: &str = "main-console";

/// Build the public LAN URLs the operator can open / scan.
pub fn public_urls(files_dir: &PathBuf, addr: &std::net::SocketAddr) -> Vec<String> {
    let _ = files_dir;
    let port = addr.port();
    match primary_local_ip() {
        Some(ip) => vec![format!("https://{}:{}/remote", ip, port)],
        None => vec![format!("https://127.0.0.1:{}/remote", port)],
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