use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TallyState {
    Off,
    Preview,
    Program,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    Connecting,
    Connected,
    Dead,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QualityStats {
    pub rtt_ms: Option<u32>,
    pub packet_loss_pct: Option<f32>,
    pub bitrate_kbps: Option<u32>,
    pub battery_pct: Option<u8>,
    pub resolution_w: Option<u16>,
    pub resolution_h: Option<u16>,
    pub updated_at_ms: u64, // unix millis
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraDeviceInfo {
    pub device_id: String,
    pub device_name: String,
    pub tally: TallyState,
    pub state: String, // "connecting" | "connected" | "dead"
    pub connected_at_ms: u64,
    pub last_seen_ms: u64,
    pub quality: QualityStats,
}

// --- Typed WS messages (inbound from clients) ---
#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum InboundMsg {
    // Auth
    Auth {
        pin: String,
        #[serde(default)]
        client_type: String,
        #[serde(default)]
        device_id: Option<String>,
        #[serde(default)]
        device_name: Option<String>,
        #[serde(default)]
        device_token: Option<String>,
    },
    // Signaling (relayed)
    CameraOffer {
        target: String,
        device_id: String,
        device_name: Option<String>,
        sdp: String,
    },
    CameraAnswer {
        target: String,
        device_id: String,
        sdp: String,
    },
    CameraIce {
        target: String,
        device_id: String,
        candidate: serde_json::Value,
    },
    // Control
    CameraConnectProgram { device_id: String },
    CameraDisconnectProgram { device_id: String },
    RequestAllOffers,
    OutputReady,
    CameraTelemetry {
        device_id: String,
        #[serde(default)]
        battery: Option<u8>,
        #[serde(default)]
        resolution_w: Option<u16>,
        #[serde(default)]
        resolution_h: Option<u16>,
        #[serde(default)]
        rtt_ms: Option<u32>,
        #[serde(default)]
        bitrate_kbps: Option<u32>,
    },
    // Catch-all for other remote commands (pass-through)
    #[serde(other)]
    Unknown,
}

// --- Typed WS messages (outbound to clients) ---
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutboundEvent {
    AuthOk,
    AuthFail { reason: String },
    CameraSourceConnected { device_id: String, device_name: String },
    CameraSourceDisconnected { device_id: String },
    TallyUpdate { device_id: String, tally: TallyState },
    DeviceList { devices: Vec<CameraDeviceInfo> },
    Heartbeat,
}

/// A relay signal message (SDP offer/answer, ICE — forwarded as-is to target)
#[derive(Debug, Serialize, Clone)]
pub struct RelayMsg {
    pub cmd: String,
    pub target: String,
    pub device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sdp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
}
