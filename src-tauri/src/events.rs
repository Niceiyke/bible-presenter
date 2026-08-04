use serde::{Deserialize, Serialize};
use crate::store;

#[derive(Clone, Serialize)]
pub struct TranscriptionUpdate {
    pub text: String,
    pub detected_item: Option<store::DisplayItem>,
    pub confidence: f32,
    pub source: String,
    pub is_partial: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub text: String,
    pub timestamp_ms: u64,
    pub is_final: bool,
    pub source: String,
}

#[derive(Clone, Serialize)]
pub struct SessionStatus {
    pub status: String,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MonitorInfo {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub is_primary: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SemanticIndexStatus {
    pub downloaded: bool,
    pub path: Option<String>,
    pub size_mb: u32,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct VerseIndexStatus {
    pub downloaded: bool,
    pub path: Option<String>,
    pub size_mb: u32,
}
