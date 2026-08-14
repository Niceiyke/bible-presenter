use crate::remote::protocol::{RemoteEvent, RemoteEventKind};
use parking_lot::Mutex;
use std::sync::Arc;
use tokio::sync::broadcast;

/// Central event bus for the remote protocol. Mutating backend operations
/// publish full sub-state payloads through the hub; every connected remote
/// receives them. The revision counter makes staleness detectable and lets
/// clients ignore out-of-order copies.
///
/// Events carry full authoritative sub-state (not diffs), so any delivery
/// order converges to the same final UI state.
#[derive(Clone)]
pub struct RemoteHub {
    tx: broadcast::Sender<RemoteEvent>,
    revision: Arc<Mutex<u64>>,
}

const CHANNEL_CAPACITY: usize = 512;

impl RemoteHub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(CHANNEL_CAPACITY);
        Self { tx, revision: Arc::new(Mutex::new(0)) }
    }

    pub fn current_revision(&self) -> u64 {
        *self.revision.lock()
    }

    /// Publishes an event, incrementing the revision counter. Returns the new
    /// revision assigned to the event. Every connected client receives the
    /// event; slow consumers that fall behind receive a `RecvError::Lagged`
    /// and reconnect their snapshot.
    pub fn publish(&self, kind: RemoteEventKind, payload: serde_json::Value, source_device_id: Option<String>) -> u64 {
        self.publish_to(kind, payload, source_device_id, None)
    }

    /// Publishes an event that is addressed to a single connected device. The
    /// server's per-connection loop only forwards it to the device whose id
    /// matches `target_device_id`. Used to relay operator->phone camera
    /// signaling without broadcasting it to every client.
    pub fn publish_to(&self, kind: RemoteEventKind, payload: serde_json::Value, source_device_id: Option<String>, target_device_id: Option<String>) -> u64 {
        let mut rev = self.revision.lock();
        *rev += 1;
        let revision = *rev;
        drop(rev);

        let event = RemoteEvent {
            kind,
            revision,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            source_device_id,
            target_device_id,
            payload,
        };
        let _ = self.tx.send(event);
        revision
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RemoteEvent> {
        self.tx.subscribe()
    }
}

impl Default for RemoteHub {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revisions_increment_monotonically() {
        let hub = RemoteHub::new();
        let a = hub.publish(RemoteEventKind::LiveChanged, serde_json::json!({ "live_item": null }), None);
        let b = hub.publish(RemoteEventKind::StagedChanged, serde_json::json!({ "staged_item": null }), None);
        assert_eq!(a, 1);
        assert_eq!(b, 2);
        assert_eq!(hub.current_revision(), 2);
    }

    #[test]
    fn subscribers_receive_events_in_order() {
        let hub = RemoteHub::new();
        let mut rx = hub.subscribe();
        hub.publish(RemoteEventKind::LiveChanged, serde_json::json!({ "live_item": null }), None);
        let ev = rx.try_recv().unwrap();
        assert_eq!(ev.kind, RemoteEventKind::LiveChanged);
        assert_eq!(ev.revision, 1);
    }

    #[tokio::test]
    async fn subscriber_receives_async_event() {
        let hub = RemoteHub::new();
        let mut rx = hub.subscribe();
        hub.publish(RemoteEventKind::BlackoutChanged, serde_json::json!({ "blackout": true }), Some("dev-1".into()));
        let ev = rx.recv().await.unwrap();
        assert_eq!(ev.source_device_id.as_deref(), Some("dev-1"));
        assert_eq!(ev.payload["blackout"], true);
    }
}