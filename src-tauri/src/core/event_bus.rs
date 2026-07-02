use super::events::CleanEvent;
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
    pub fn sender(&self) -> mpsc::UnboundedSender<CleanEvent> {
        self.sender.clone()
    }
}
