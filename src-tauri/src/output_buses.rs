//! Registry for independently routable presentation buses.
//!
//! `primary` remains backed by the existing presentation state while the
//! multi-output migration introduces independently stateful auxiliary buses.

use crate::outputs::{OutputConfig, OutputKind};
use crate::state::PresentationState;
use crate::store::PresentationSettings;
use parking_lot::RwLock;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::Arc;

pub const PRIMARY_BUS_ID: &str = "primary";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutputBusInfo {
    pub id: String,
    pub label: String,
    pub primary: bool,
}

#[derive(Clone)]
pub struct OutputBusManager {
    buses: Arc<RwLock<BTreeMap<String, AuxiliaryBus>>>,
}

#[derive(Clone)]
struct AuxiliaryBus {
    info: OutputBusInfo,
    presentation: PresentationState,
}

impl OutputBusManager {
    pub fn new(configs: &[OutputConfig], settings: &PresentationSettings) -> Self {
        let manager = Self {
            buses: Arc::new(RwLock::new(BTreeMap::new())),
        };
        manager.sync(configs, settings);
        manager
    }

    /// Window surfaces define program buses. Recorder and streaming surfaces
    /// subscribe to a bus but do not create a new independent program.
    pub fn sync(&self, configs: &[OutputConfig], settings: &PresentationSettings) {
        let mut previous = self.buses.write();
        let mut next = BTreeMap::new();
        for output in configs {
            if output.kind != OutputKind::Window || output.program_bus == PRIMARY_BUS_ID {
                continue;
            }
            let id = output.program_bus.clone();
            let label = output.label.clone();
            let mut entry = previous.remove(&id).unwrap_or_else(|| AuxiliaryBus {
                info: OutputBusInfo {
                    id: id.clone(),
                    label: label.clone(),
                    primary: false,
                },
                presentation: PresentationState::new(settings.clone()),
            });
            entry.info.label = label;
            next.entry(id).or_insert(entry);
        }
        *previous = next;
    }

    pub fn list(&self) -> Vec<OutputBusInfo> {
        let mut buses = vec![OutputBusInfo {
            id: PRIMARY_BUS_ID.to_string(),
            label: "Primary".to_string(),
            primary: true,
        }];
        buses.extend(self.buses.read().values().map(|bus| bus.info.clone()));
        buses
    }

    pub fn contains(&self, id: &str) -> bool {
        id == PRIMARY_BUS_ID || self.buses.read().contains_key(id)
    }

    pub fn auxiliary_presentation(&self, id: &str) -> Option<PresentationState> {
        self.buses
            .read()
            .get(id)
            .map(|bus| bus.presentation.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outputs::default_outputs;

    #[test]
    fn defaults_have_primary_and_overflow_bus() {
        let buses =
            OutputBusManager::new(&default_outputs(), &PresentationSettings::default()).list();
        assert_eq!(buses[0].id, PRIMARY_BUS_ID);
        assert!(buses[0].primary);
        assert!(buses.iter().any(|bus| bus.id == "aux-overflow"));
    }
}
