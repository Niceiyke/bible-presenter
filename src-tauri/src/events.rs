use serde::{Deserialize, Serialize};
use crate::store;

#[derive(Clone, Serialize)]
pub struct LiveItemUpdate {
    pub detected_item: Option<store::DisplayItem>,
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
