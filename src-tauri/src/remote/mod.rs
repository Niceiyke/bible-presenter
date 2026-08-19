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
use serde::Serialize;
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
    /// Sliding-window expensive read-query history per device (search rate
    /// limiting — Phase 10).
    pub read_query_history: Mutex<HashMap<String, Vec<u64>>>,
    /// Device-token persistence file.
    pub devices_file: PathBuf,
    /// File holding the last-bound remote port so restarts reuse it instead of
    /// jumping to a new random port (which would orphan phones' saved URLs).
    pub port_file: PathBuf,
    /// File holding remote preferences (e.g. the idle auto-revoke threshold).
    pub prefs_file: PathBuf,
    /// Idle auto-revoke threshold in hours. When set, paired devices that are
    /// neither connected nor seen for longer than this are revoked so stale
    /// devices can't linger indefinitely. `None` = never auto-revoke.
    pub auto_revoke_hours: Mutex<Option<u32>>,
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
    /// Revocation signal: every connected socket subscribes; the operator
    /// `notify_revoked` broadcasts the revoked device id and the matching
    /// socket closes immediately (audit #9 — revocation must take effect now).
    pub revoked_tx: tokio::sync::broadcast::Sender<String>,
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
    /// Physical screen orientation reported by the phone on `camera.start`
    /// ("portrait" | "landscape"), used to auto-correct display rotation.
    pub orientation: Option<String>,
}

/// Operator-facing summary of a connected phone camera (the Camera tab lists
/// these so the operator can pick which feed to stage/live).
#[derive(Debug, Clone, Serialize)]
pub struct PhoneCameraInfo {
    /// Prefixed id, also used as the DisplayItem device id ("phone-camera-...").
    pub device_id: String,
    pub device_name: String,
    /// Physical screen orientation reported by the phone ("portrait" | "landscape").
    pub orientation: Option<String>,
}

impl RemoteControl {
    pub fn new(files_dir: PathBuf, app_data_dir: &Path) -> Self {
        let devices_file = app_data_dir.join("remote_devices.json");
        if let Some(dir) = devices_file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let prefs_file = app_data_dir.join("remote_prefs.json");
        let auto_revoke_hours = std::fs::read_to_string(&prefs_file)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.get("auto_revoke_hours").and_then(|h| h.as_u64()))
            .map(|h| h as u32)
            .filter(|h| *h > 0);
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
            read_query_history: Mutex::new(HashMap::new()),
            devices_file: devices_file.clone(),
            port_file: app_data_dir.join("remote_port.txt"),
            prefs_file: prefs_file.clone(),
            auto_revoke_hours: Mutex::new(auto_revoke_hours),
            tls_file: app_data_dir.join("remote_tls.json"),
            task: Mutex::new(None),
            pairing_code_plain: Mutex::new(None),
            phone_cameras: Arc::new(RwLock::new(HashMap::new())),
            revoked_tx: tokio::sync::broadcast::channel(64).0,
        };
        control.tokens.load(&devices_file);
        control
    }

    /// Broadcasts that a device was revoked so its live socket closes
    /// immediately. Called by `remote_revoke_device` / `remote_revoke_all`.
    pub fn notify_revoked(&self, device_id: &str) {
        let _ = self.revoked_tx.send(device_id.to_string());
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

    /// Current idle auto-revoke threshold in hours (`None` = disabled).
    pub fn auto_revoke_hours(&self) -> Option<u32> {
        *self.auto_revoke_hours.lock()
    }

    /// Sets (or clears, with `None`) the idle auto-revoke threshold and
    /// persists it to `remote_prefs.json`.
    pub fn set_auto_revoke_hours(&self, hours: Option<u32>) {
        let hours = hours.filter(|h| *h > 0);
        *self.auto_revoke_hours.lock() = hours;
        let json = serde_json::json!({ "auto_revoke_hours": hours });
        if let Some(dir) = self.prefs_file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&self.prefs_file, serde_json::to_string(&json).unwrap_or_else(|_| "{}".into()));
    }

    /// Revokes paired devices that are neither currently connected nor have
    /// been seen for longer than the configured idle threshold. Returns the
    /// names of the revoked devices so the caller can log/notify.
    pub fn sweep_idle_devices(&self) -> Vec<String> {
        let Some(hours) = self.auto_revoke_hours() else {
            return Vec::new();
        };
        let now = auth::now_unix();
        let threshold = now.saturating_sub(hours as u64 * 3600);
        let connected: Vec<String> = self.sessions.list().into_iter().map(|d| d.device_id).collect();
        let mut removed = Vec::new();
        for device in self.tokens.list_devices() {
            if connected.contains(&device.id) {
                continue;
            }
            let last_seen = device.last_seen_at.unwrap_or(device.paired_at);
            if last_seen < threshold && self.tokens.revoke_device(&device.id) {
                removed.push(device.name);
            }
        }
        if !removed.is_empty() {
            self.persist_devices();
        }
        removed
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

    /// Sliding-window budget for expensive READ queries (bible/song search) per
    /// connected device. These are cheap enough to allow but expensive enough
    /// that an abusive client should not be able to hammer them; when exceeded
    /// the query is rejected (Phase 10).
    pub fn allow_read_query(&self, device_id: &str) -> bool {
        use crate::remote::auth::now_unix;
        const READ_QUERY_RATE_LIMIT: usize = 15;
        const READ_QUERY_WINDOW_SECS: u64 = 10;
        let now = now_unix();
        let mut map = self.read_query_history.lock();
        let list = map.entry(device_id.to_string()).or_default();
        list.retain(|t| *t >= now.saturating_sub(READ_QUERY_WINDOW_SECS));
        if list.len() >= READ_QUERY_RATE_LIMIT {
            return false;
        }
        list.push(now);
        true
    }

    /// Push the device's current role + permissions to it immediately, so a
    /// revoked or permission-reduced client updates its UI WITHOUT reconnecting
    /// (Phase 10). Targeted (does not advance the global revision).
    pub fn publish_permissions_changed(&self, device_id: &str) {
        if let Some(dev) = self.tokens.device(device_id) {
            self.hub.publish_to(
                RemoteEventKind::PermissionsChanged,
                json!({ "role": dev.role, "permissions": dev.permissions }),
                None,
                Some(device_id.to_string()),
            );
        }
    }

    /// Register a phone camera device. Called when a remote client sends
    /// `camera.start` command. `owner_device_id` is the remote Control
    /// session id of the phone so operator->phone signaling can be targeted.
    pub async fn register_phone_camera(&self, device_id: &str, raw_device_id: &str, device_name: &str, owner_device_id: &str, orientation: Option<String>) {
        let camera = PhoneCamera {
            device_id: device_id.to_string(),
            raw_device_id: raw_device_id.to_string(),
            device_name: device_name.to_string(),
            owner_device_id: owner_device_id.to_string(),
            orientation,
        };
        self.phone_cameras.write().await.insert(device_id.to_string(), camera);
    }

    /// Unregister a phone camera device. Called when a remote client sends
    /// `camera.stop` command or disconnects.
    pub async fn unregister_phone_camera(&self, device_id: &str) {
        self.phone_cameras.write().await.remove(device_id);
    }

    /// Operator-facing list of connected phone cameras (for the Camera tab).
    pub async fn list_phone_cameras(&self) -> Vec<PhoneCameraInfo> {
        let mut list: Vec<PhoneCameraInfo> = self
            .phone_cameras
            .read()
            .await
            .values()
            .map(|c| PhoneCameraInfo {
                device_id: c.device_id.clone(),
                device_name: c.device_name.clone(),
                orientation: c.orientation.clone(),
            })
            .collect();
        list.sort_by(|a, b| a.device_name.cmp(&b.device_name));
        list
    }

    /// Removes every camera owned by a remote device (used when that device
    /// disconnects so stale entries don't linger in the Camera tab). Returns
    /// the removed prefixed ids.
    pub async fn unregister_phone_cameras_for_owner(&self, owner_device_id: &str) -> Vec<String> {
        let mut map = self.phone_cameras.write().await;
        let removed: Vec<String> = map
            .iter()
            .filter(|(_, c)| c.owner_device_id == owner_device_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &removed {
            map.remove(id);
        }
        removed
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