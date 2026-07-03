use super::events::CleanEvent;
use super::events::UninstallEvent;
use tokio::sync::mpsc;

/// Event bus for broadcasting scan/clean events to consumers.
/// Uses tokio mpsc channel under the hood (observer pattern).
pub struct EventBus {
    sender: mpsc::UnboundedSender<CleanEvent>,
}

impl EventBus {
    /// Create a new EventBus, returning the bus and the receiver for events.
    pub fn new() -> (Self, mpsc::UnboundedReceiver<CleanEvent>) {
        let (sender, receiver) = mpsc::unbounded_channel();
        (Self { sender }, receiver)
    }

    /// Emit an event to the bus.
    pub fn emit(&self, event: CleanEvent) -> Result<(), String> {
        self.sender
            .send(event)
            .map_err(|e| format!("Failed to emit event: {}", e))
    }

    /// Get a clone of the sender for use in multiple tasks.
    #[allow(dead_code)]
    pub fn sender(&self) -> mpsc::UnboundedSender<CleanEvent> {
        self.sender.clone()
    }
}

/// Event bus for broadcasting uninstall events to consumers.
pub struct UninstallEventBus {
    sender: mpsc::UnboundedSender<UninstallEvent>,
}

impl UninstallEventBus {
    pub fn new() -> (Self, mpsc::UnboundedReceiver<UninstallEvent>) {
        let (sender, receiver) = mpsc::unbounded_channel();
        (Self { sender }, receiver)
    }

    pub fn emit(&self, event: UninstallEvent) -> Result<(), String> {
        self.sender
            .send(event)
            .map_err(|e| format!("Failed to emit uninstall event: {}", e))
    }

    #[allow(dead_code)]
    pub fn sender(&self) -> mpsc::UnboundedSender<UninstallEvent> {
        self.sender.clone()
    }
}
