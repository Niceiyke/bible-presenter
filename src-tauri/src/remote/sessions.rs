use crate::remote::auth::{now_unix, DEFAULT_LEASE_TTL_SECS};
use crate::remote::protocol::RemoteControllerState;
use parking_lot::Mutex;
use std::collections::HashMap;

/// Single-controller lease. Only one remote device may hold mutating control
/// at a time; the desktop operator stays authoritative and any command from a
/// device without the lease is rejected. The lease expires after inactivity
/// and is renewable via heartbeats.
#[derive(Default)]
pub struct ControllerLease {
    inner: Mutex<Option<Lease>>,
}

#[derive(Debug, Clone)]
struct Lease {
    device_id: String,
    device_name: String,
    expires_at: u64,
}

impl ControllerLease {
    pub fn new() -> Self {
        Self { inner: Mutex::new(None) }
    }

    fn is_expired(lease: &Lease) -> bool {
        lease.expires_at < now_unix()
    }

    /// Best-effort expiry sweep: returns the current holder if the lease is
    /// live, otherwise clears the slot.
    fn live_holder(&self) -> Option<Lease> {
        let mut guard = self.inner.lock();
        if let Some(l) = guard.as_ref() {
            if Self::is_expired(l) {
                *guard = None;
                return None;
            }
        }
        guard.clone()
    }

    pub fn state(&self) -> RemoteControllerState {
        match self.live_holder() {
            Some(l) => RemoteControllerState::Held {
                device_id: l.device_id,
                device_name: l.device_name,
                expires_at: l.expires_at,
            },
            None => RemoteControllerState::Viewing,
        }
    }

    /// Requests the lease. Fails if another device holds a live lease.
    pub fn request(&self, device_id: &str, device_name: &str) -> bool {
        let mut guard = self.inner.lock();
        if let Some(l) = guard.as_ref() {
            if !Self::is_expired(l) && l.device_id != device_id {
                return false;
            }
        }
        *guard = Some(Lease {
            device_id: device_id.to_string(),
            device_name: device_name.to_string(),
            expires_at: now_unix() + DEFAULT_LEASE_TTL_SECS,
        });
        true
    }

    /// Renews the lease for the current holder (heartbeat).
    pub fn renew(&self, device_id: &str) -> bool {
        let mut guard = self.inner.lock();
        if let Some(l) = guard.as_ref() {
            if Self::is_expired(l) || l.device_id != device_id {
                return false;
            }
        } else {
            return false;
        }
        if let Some(l) = guard.as_mut() {
            l.expires_at = now_unix() + DEFAULT_LEASE_TTL_SECS;
        }
        true
    }

    pub fn release(&self, device_id: &str) -> bool {
        let mut guard = self.inner.lock();
        if let Some(l) = guard.as_ref() {
            if l.device_id == device_id {
                *guard = None;
                return true;
            }
        }
        false
    }

    /// True when `device_id` owns the lease right now.
    pub fn is_held_by(&self, device_id: &str) -> bool {
        matches!(&self.live_holder(), Some(l) if l.device_id == device_id)
    }

    pub fn holder_id(&self) -> Option<String> {
        self.live_holder().map(|l| l.device_id)
    }

    /// Revokes an active lease if held by `device_id` (device revocation).
    pub fn revoke_for(&self, device_id: &str) {
        self.release(device_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lease_is_exclusive() {
        let lease = ControllerLease::new();
        assert!(lease.request("dev-1", "iPad"));
        assert!(!lease.request("dev-2", "Phone"));
        assert!(lease.is_held_by("dev-1"));
        assert!(!lease.is_held_by("dev-2"));
    }

    #[test]
    fn release_frees_lease() {
        let lease = ControllerLease::new();
        lease.request("dev-1", "iPad");
        assert!(lease.release("dev-1"));
        assert!(!lease.is_held_by("dev-1"));
        assert!(lease.request("dev-2", "Phone"));
    }

    #[test]
    fn only_holder_can_release() {
        let lease = ControllerLease::new();
        lease.request("dev-1", "iPad");
        assert!(!lease.release("dev-2"));
        assert!(lease.is_held_by("dev-1"));
    }

    #[test]
    fn renew_extends_lease() {
        let lease = ControllerLease::new();
        lease.request("dev-1", "iPad");
        assert!(lease.renew("dev-1"));
        assert!(!lease.renew("dev-2"));
        assert!(lease.is_held_by("dev-1"));
    }

    #[test]
    fn expired_lease_is_freed() {
        let lease = ControllerLease::new();
        lease.request("dev-1", "iPad");
        {
            let mut guard = lease.inner.lock();
            if let Some(l) = guard.as_mut() {
                l.expires_at = 1; // force expiry in the past
            }
        }
        assert!(!lease.is_held_by("dev-1"));
        assert!(lease.request("dev-2", "Phone"));
    }

    #[test]
    fn state_is_held_or_viewing() {
        let lease = ControllerLease::new();
        assert_eq!(lease.state(), RemoteControllerState::Viewing);
        lease.request("dev-1", "iPad");
        match lease.state() {
            RemoteControllerState::Held { device_id, device_name, .. } => {
                assert_eq!(device_id, "dev-1");
                assert_eq!(device_name, "iPad");
            }
            other => panic!("expected held, got {:?}", other),
        }
    }
}

/// Live view of which devices are currently connected (for the operator-facing
/// "Connected devices" list). Disconnected devices are removed immediately.
#[derive(Default)]
pub struct ConnectedDevices {
    inner: Mutex<HashMap<String, ConnectedDevice>>,
}

#[derive(Debug, Clone)]
pub struct ConnectedDevice {
    pub device_id: String,
    pub device_name: String,
    pub connected_at: u64,
    pub last_active_at: u64,
}

impl ConnectedDevices {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn connect(&self, device_id: &str, device_name: &str) {
        let now = now_unix();
        self.inner.lock().insert(
            device_id.to_string(),
            ConnectedDevice {
                device_id: device_id.to_string(),
                device_name: device_name.to_string(),
                connected_at: now,
                last_active_at: now,
            },
        );
    }

    pub fn touch(&self, device_id: &str) {
        if let Some(d) = self.inner.lock().get_mut(device_id) {
            d.last_active_at = now_unix();
        }
    }

    pub fn disconnect(&self, device_id: &str) {
        self.inner.lock().remove(device_id);
    }

    pub fn list(&self) -> Vec<ConnectedDevice> {
        let mut list: Vec<ConnectedDevice> = self.inner.lock().values().cloned().collect();
        list.sort_by(|a, b| b.connected_at.cmp(&a.connected_at));
        list
    }
}

#[cfg(test)]
mod connected_tests {
    use super::*;

    #[test]
    fn tracks_and_removes_devices() {
        let devices = ConnectedDevices::new();
        devices.connect("d1", "iPad");
        devices.connect("d2", "Phone");
        assert_eq!(devices.list().len(), 2);
        devices.touch("d1");
        devices.disconnect("d2");
        assert_eq!(devices.list().len(), 1);
        assert_eq!(devices.list()[0].device_id, "d1");
    }
}