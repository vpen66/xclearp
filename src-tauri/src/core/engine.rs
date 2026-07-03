use std::sync::Arc;

use tokio::sync::Mutex as TokioMutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::cleaner::{CleanError, Cleaner};
use super::event_bus::EventBus;
use super::rules::CleanRule;
use super::scanner::{ScanError, ScanTarget, Scanner};
use super::whitelist::Whitelist;
use crate::platform::PlatformProvider;

/// Errors that can occur in the engine.
#[derive(Debug, Clone)]
pub struct EngineError {
    pub message: String,
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "EngineError: {}", self.message)
    }
}

impl std::error::Error for EngineError {}

impl From<ScanError> for EngineError {
    fn from(e: ScanError) -> Self {
        EngineError { message: e.message }
    }
}

impl From<CleanError> for EngineError {
    fn from(e: CleanError) -> Self {
        EngineError { message: e.message }
    }
}

/// Registry for tracking active operations and their cancellation tokens.
pub struct OperationRegistry {
    tokens: TokioMutex<std::collections::HashMap<String, CancellationToken>>,
}

impl OperationRegistry {
    pub fn new() -> Self {
        Self {
            tokens: TokioMutex::new(std::collections::HashMap::new()),
        }
    }

    /// Register a new operation and return its cancellation token.
    pub async fn register(&self, op_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        let mut map = self.tokens.lock().await;
        map.insert(op_id.to_string(), token.clone());
        token
    }

    /// Cancel an operation by its ID. Returns true if the operation was found.
    pub async fn cancel(&self, op_id: &str) -> bool {
        let map = self.tokens.lock().await;
        if let Some(token) = map.get(op_id) {
            token.cancel();
            true
        } else {
            false
        }
    }

    /// Remove a completed operation from the registry.
    pub async fn unregister(&self, op_id: &str) {
        let mut map = self.tokens.lock().await;
        map.remove(op_id);
    }
}

impl Default for OperationRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Top-level orchest engine that integrates scanning and cleaning.
pub struct CleanEngine {
    scanner: Arc<Scanner>,
    cleaner: Arc<Cleaner>,
    #[allow(dead_code)]
    event_bus: Arc<EventBus>,
    whitelist: Arc<std::sync::RwLock<Whitelist>>,
    op_registry: Arc<OperationRegistry>,
    platform: Arc<dyn PlatformProvider + Send + Sync>,
}

impl CleanEngine {
    /// Create a new CleanEngine.
    pub fn new(
        event_bus: Arc<EventBus>,
        whitelist: Arc<std::sync::RwLock<Whitelist>>,
        platform: Arc<dyn PlatformProvider + Send + Sync>,
    ) -> Self {
        let scanner = Arc::new(Scanner::new(Arc::clone(&event_bus), Arc::clone(&whitelist)));
        let cleaner = Arc::new(Cleaner::new(Arc::clone(&event_bus)));
        let op_registry = Arc::new(OperationRegistry::new());

        Self {
            scanner,
            cleaner,
            event_bus,
            whitelist,
            op_registry,
            platform,
        }
    }

    /// Execute a full scan flow in the background. Returns the op_id immediately.
    pub fn start_scan(&self, rules: &[CleanRule]) -> Result<String, EngineError> {
        let op_id = Uuid::new_v4().to_string();
        let scanner = Arc::clone(&self.scanner);
        let platform = Arc::clone(&self.platform);
        let op_registry = Arc::clone(&self.op_registry);

        let rules = rules.to_vec();
        let op_id_clone = op_id.clone();

        tauri::async_runtime::spawn(async move {
            let cancel_token = op_registry.register(&op_id_clone).await;
            let _result = scanner
                .scan_rules(&rules, platform.as_ref(), &op_id_clone, cancel_token)
                .await;
            op_registry.unregister(&op_id_clone).await;
        });

        Ok(op_id)
    }

    /// Execute a clean operation in the background. Returns the op_id immediately.
    /// When `safe_mode` is true, files are moved to trash instead of being permanently deleted.
    pub fn start_clean(&self, targets: Vec<ScanTarget>, safe_mode: bool) -> Result<String, EngineError> {
        let op_id = Uuid::new_v4().to_string();
        let cleaner = Arc::clone(&self.cleaner);
        let platform = Arc::clone(&self.platform);
        let op_registry = Arc::clone(&self.op_registry);

        let op_id_clone = op_id.clone();

        tauri::async_runtime::spawn(async move {
            let cancel_token = op_registry.register(&op_id_clone).await;
            let _result = cleaner
                .clean_targets(&targets, platform.as_ref(), &op_id_clone, cancel_token, safe_mode)
                .await;
            op_registry.unregister(&op_id_clone).await;
        });

        Ok(op_id)
    }

    /// Cancel an active operation by its ID. Returns true if found and cancelled.
    pub async fn cancel_operation(&self, op_id: &str) -> bool {
        self.op_registry.cancel(op_id).await
    }

    /// Get a reference to the event bus (for consumers to subscribe to events).
    #[allow(dead_code)]
    pub fn event_bus(&self) -> &Arc<EventBus> {
        &self.event_bus
    }

    /// Get a reference to the whitelist.
    pub fn whitelist(&self) -> &Arc<std::sync::RwLock<Whitelist>> {
        &self.whitelist
    }
}
