use std::{collections::HashMap, sync::Arc};
use parking_lot::Mutex;
use super::types::TallyState;

/// Authoritative tally registry.
/// The server owns tally state — clients are told their state on connect/change.
pub struct TallyRegistry {
    states: Arc<Mutex<HashMap<String, TallyState>>>,
}

impl Clone for TallyRegistry {
    fn clone(&self) -> Self {
        Self {
            states: self.states.clone(),
        }
    }
}

impl TallyRegistry {
    pub fn new() -> Self {
        Self {
            states: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Set tally for a device. Returns true if state changed.
    pub fn set(&self, device_id: &str, state: TallyState) -> bool {
        let mut map = self.states.lock();
        let old = map.insert(device_id.to_owned(), state);
        old != Some(state)
    }

    pub fn get(&self, device_id: &str) -> TallyState {
        *self.states.lock().get(device_id).unwrap_or(&TallyState::Off)
    }

    pub fn remove(&self, device_id: &str) {
        self.states.lock().remove(device_id);
    }

    /// Returns the device_id currently on Program (if any).
    pub fn program_device(&self) -> Option<String> {
        self.states
            .lock()
            .iter()
            .find(|(_, &v)| v == TallyState::Program)
            .map(|(k, _)| k.clone())
    }

    /// Returns the device_id currently on Preview (if any).
    pub fn preview_device(&self) -> Option<String> {
        self.states
            .lock()
            .iter()
            .find(|(_, &v)| v == TallyState::Preview)
            .map(|(k, _)| k.clone())
    }

    /// Clear program (set to Off) for whichever device is on Program.
    /// Returns the device_id that was cleared.
    pub fn clear_program(&self) -> Option<String> {
        let id = self.program_device()?;
        self.set(&id, TallyState::Off);
        Some(id)
    }
}
