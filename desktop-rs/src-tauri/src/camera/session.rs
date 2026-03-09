use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use parking_lot::Mutex;
use tokio::sync::mpsc::UnboundedSender;
use super::types::{SessionState, TallyState, QualityStats, CameraDeviceInfo};

pub struct CameraSession {
    pub device_id: String,
    pub device_name: String,
    pub client_key: String, // "mobile:{device_id}"
    pub state: SessionState,
    pub connected_at: SystemTime,
    pub last_heartbeat: SystemTime,
    pub tally: TallyState,
    pub quality: QualityStats,
    pub tx: UnboundedSender<String>,
}

impl CameraSession {
    pub fn new(device_id: String, device_name: String, tx: UnboundedSender<String>) -> Self {
        let now = SystemTime::now();
        let client_key = format!("mobile:{}", device_id);
        Self {
            device_id,
            device_name,
            client_key,
            state: SessionState::Connecting,
            connected_at: now,
            last_heartbeat: now,
            tally: TallyState::Off,
            quality: QualityStats {
                rtt_ms: None,
                packet_loss_pct: None,
                bitrate_kbps: None,
                battery_pct: None,
                resolution_w: None,
                resolution_h: None,
                updated_at_ms: 0,
            },
            tx,
        }
    }

    pub fn mark_connected(&mut self) {
        self.state = SessionState::Connected;
        self.last_heartbeat = SystemTime::now();
    }

    pub fn touch(&mut self) {
        self.last_heartbeat = SystemTime::now();
    }

    pub fn is_stale(&self, timeout: Duration) -> bool {
        self.last_heartbeat.elapsed().unwrap_or(Duration::MAX) > timeout
    }

    pub fn send(&self, msg: &str) {
        let _ = self.tx.send(msg.to_owned());
    }

    pub fn to_info(&self) -> CameraDeviceInfo {
        fn ms(t: SystemTime) -> u64 {
            t.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
        }
        CameraDeviceInfo {
            device_id: self.device_id.clone(),
            device_name: self.device_name.clone(),
            tally: self.tally,
            state: match self.state {
                SessionState::Connecting => "connecting",
                SessionState::Connected => "connected",
                SessionState::Dead => "dead",
            }
            .to_string(),
            connected_at_ms: ms(self.connected_at),
            last_seen_ms: ms(self.last_heartbeat),
            quality: self.quality.clone(),
        }
    }
}

/// Thread-safe registry of active mobile camera sessions.
pub struct SessionRegistry {
    inner: Arc<Mutex<HashMap<String, CameraSession>>>,
}

impl Clone for SessionRegistry {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn insert(&self, session: CameraSession) {
        self.inner.lock().insert(session.device_id.clone(), session);
    }

    pub fn remove(&self, device_id: &str) -> Option<CameraSession> {
        self.inner.lock().remove(device_id)
    }

    pub fn get_tx(&self, device_id: &str) -> Option<UnboundedSender<String>> {
        self.inner.lock().get(device_id).map(|s| s.tx.clone())
    }

    pub fn touch(&self, device_id: &str) {
        if let Some(s) = self.inner.lock().get_mut(device_id) {
            s.touch();
        }
    }

    pub fn mark_connected(&self, device_id: &str) {
        if let Some(s) = self.inner.lock().get_mut(device_id) {
            s.mark_connected();
        }
    }

    pub fn set_tally(&self, device_id: &str, tally: TallyState) {
        if let Some(s) = self.inner.lock().get_mut(device_id) {
            s.tally = tally;
        }
    }

    pub fn update_quality(&self, device_id: &str, f: impl FnOnce(&mut QualityStats)) {
        if let Some(s) = self.inner.lock().get_mut(device_id) {
            f(&mut s.quality);
        }
    }

    pub fn list(&self) -> Vec<CameraDeviceInfo> {
        self.inner.lock().values().map(|s| s.to_info()).collect()
    }

    pub fn device_ids(&self) -> Vec<String> {
        self.inner.lock().keys().cloned().collect()
    }

    /// Returns device_ids of sessions that exceed `timeout` without a heartbeat.
    pub fn stale_ids(&self, timeout: Duration) -> Vec<String> {
        self.inner
            .lock()
            .values()
            .filter(|s| s.is_stale(timeout))
            .map(|s| s.device_id.clone())
            .collect()
    }

    pub fn send_to(&self, device_id: &str, msg: &str) {
        if let Some(s) = self.inner.lock().get(device_id) {
            s.send(msg);
        }
    }

    pub fn broadcast(&self, msg: &str) {
        for s in self.inner.lock().values() {
            s.send(msg);
        }
    }
}
