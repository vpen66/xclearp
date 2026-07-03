use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as TokioMutex;
pub use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::InstalledApp;
use super::UninstallMode;
use crate::core::event_bus::UninstallEventBus;
use crate::core::events::{FailedItem, UninstallEvent};
use crate::platform::PlatformProvider;

/// Result of a single uninstall operation.
pub struct UninstallResult {
    pub total_deleted: u64,
    pub total_freed: u64,
    pub failed_items: Vec<FailedItem>,
}

/// Tri-state enum for global uninstall state management.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum UninstallState {
    Idle = 0,
    InProgress = 1,
    Failed = 2,
}

static UNINSTALL_STATE: AtomicU8 = AtomicU8::new(0);

impl UninstallState {
    pub fn current() -> Self {
        match UNINSTALL_STATE.load(Ordering::SeqCst) {
            1 => Self::InProgress,
            2 => Self::Failed,
            _ => Self::Idle,
        }
    }

    pub fn set(state: Self) {
        UNINSTALL_STATE.store(state as u8, Ordering::SeqCst);
    }
}

/// RAII guard that resets the global uninstall state on drop.
/// Only resets to Idle if the current state is InProgress;
/// preserves Failed state so the UI can detect and retry.
struct UninstallGuard;
impl Drop for UninstallGuard {
    fn drop(&mut self) {
        if UninstallState::current() == UninstallState::InProgress {
            UninstallState::set(UninstallState::Idle);
        }
    }
}

// --- Failed uninstall persistence ---

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FailedUninstall {
    pub app_name: String,
    pub app_path: String,
    pub failed_paths: Vec<String>,
    pub error: String,
    pub timestamp: u64,
}

fn get_failed_uninstalls_path() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(".xclearp")
        .join("failed_uninstalls.json")
}

pub fn save_failed_uninstalls(failed: &[FailedUninstall]) {
    let path = get_failed_uninstalls_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(failed) {
        let _ = std::fs::write(&path, json);
    }
}

pub fn load_failed_uninstalls() -> Vec<FailedUninstall> {
    let path = get_failed_uninstalls_path();
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

pub fn clear_failed_uninstalls() {
    let path = get_failed_uninstalls_path();
    let _ = std::fs::remove_file(&path);
}

/// Registry for tracking active uninstall operations and their cancellation tokens.
pub struct UninstallOperationRegistry {
    tokens: TokioMutex<std::collections::HashMap<String, CancellationToken>>,
}

impl UninstallOperationRegistry {
    pub fn new() -> Self {
        Self {
            tokens: TokioMutex::new(std::collections::HashMap::new()),
        }
    }

    pub async fn register(&self, op_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        let mut map = self.tokens.lock().await;
        map.insert(op_id.to_string(), token.clone());
        token
    }

    pub async fn cancel(&self, op_id: &str) -> bool {
        let map = self.tokens.lock().await;
        if let Some(token) = map.get(op_id) {
            token.cancel();
            true
        } else {
            false
        }
    }

    pub async fn unregister(&self, op_id: &str) {
        let mut map = self.tokens.lock().await;
        map.remove(op_id);
    }
}

impl Default for UninstallOperationRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Orchestration engine for application uninstall operations.
pub struct UninstallEngine {
    event_bus: Arc<UninstallEventBus>,
    op_registry: Arc<UninstallOperationRegistry>,
    platform: Arc<dyn PlatformProvider + Send + Sync>,
}

impl UninstallEngine {
    pub fn new(
        event_bus: Arc<UninstallEventBus>,
        platform: Arc<dyn PlatformProvider + Send + Sync>,
    ) -> Self {
        let op_registry = Arc::new(UninstallOperationRegistry::new());
        Self {
            event_bus,
            op_registry,
            platform,
        }
    }

    /// Scan residual files for a given app. Returns the file groups directly.
    /// Also emits progress events via the event bus.
    pub async fn scan_app(&self, app: InstalledApp) -> Result<Vec<super::AppFileGroup>, String> {
        let op_id = Uuid::new_v4().to_string();
        let event_bus = Arc::clone(&self.event_bus);
        let platform = Arc::clone(&self.platform);

        // scan_app_residuals is synchronous I/O, run on blocking thread
        let groups = tokio::task::spawn_blocking(move || {
            platform.scan_app_residuals(&app, &event_bus, &op_id)
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?;

        Ok(groups)
    }

    /// Uninstall an application with the specified mode.
    /// Returns the operation ID for event tracking.
    pub fn uninstall_app(
        &self,
        app: InstalledApp,
        mode: UninstallMode,
        residual_paths: Vec<String>,
        safe_mode: bool,
        exclude_paths: Vec<String>,
    ) -> Result<String, String> {
        if UninstallState::current() != UninstallState::Idle {
            return Err("Another uninstall operation is in progress".to_string());
        }
        UninstallState::set(UninstallState::InProgress);

        let op_id = Uuid::new_v4().to_string();
        let event_bus = Arc::clone(&self.event_bus);
        let platform = Arc::clone(&self.platform);
        let op_registry = Arc::clone(&self.op_registry);
        let op_id_clone = op_id.clone();
        let app_name = app.name.clone();
        let app_path_str = app.app_path.clone();

        tauri::async_runtime::spawn(async move {
            let _guard = UninstallGuard;
            let cancel_token = op_registry.register(&op_id_clone).await;
            let start = Instant::now();

            let result = Self::run_uninstall(
                event_bus.clone(),
                platform,
                cancel_token,
                op_id_clone.clone(),
                app,
                mode,
                residual_paths,
                safe_mode,
                exclude_paths,
            )
            .await;

            // Persist failed items if any
            if !result.failed_items.is_empty() {
                UninstallState::set(UninstallState::Failed);
                let failed_record = FailedUninstall {
                    app_name: app_name.clone(),
                    app_path: app_path_str.clone(),
                    failed_paths: result
                        .failed_items
                        .iter()
                        .map(|f| f.path.to_string_lossy().to_string())
                        .collect(),
                    error: result
                        .failed_items
                        .first()
                        .map(|f| f.error.clone())
                        .unwrap_or_default(),
                    timestamp: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs(),
                };
                let mut existing = load_failed_uninstalls();
                existing.push(failed_record);
                save_failed_uninstalls(&existing);
            }

            let duration_ms = start.elapsed().as_millis() as u64;
            let _ = event_bus.emit(UninstallEvent::UninstallCompleted {
                op_id: op_id_clone.clone(),
                total_deleted: result.total_deleted,
                total_freed: result.total_freed,
                duration_ms,
                failed_items: result.failed_items,
            });

            op_registry.unregister(&op_id_clone).await;
        });

        Ok(op_id)
    }

    /// Core uninstall logic — async and awaitable. Used by both `uninstall_app` and batch command.
    #[allow(clippy::too_many_arguments)]
    pub async fn run_uninstall(
        event_bus: Arc<UninstallEventBus>,
        platform: Arc<dyn PlatformProvider + Send + Sync>,
        cancel_token: CancellationToken,
        op_id: String,
        app: InstalledApp,
        mode: UninstallMode,
        residual_paths: Vec<String>,
        safe_mode: bool,
        exclude_paths: Vec<String>,
    ) -> UninstallResult {
        let mut total_deleted: u64 = 0;
        let mut total_freed: u64 = 0;
        let mut failed_items: Vec<FailedItem> = Vec::new();

        // Handle different uninstall modes
        match mode {
            UninstallMode::OfficialUninstaller => {
                let _ = event_bus.emit(UninstallEvent::OfficialUninstallerStarted {
                    op_id: op_id.clone(),
                    command: app
                        .uninstall_string
                        .clone()
                        .or_else(|| app.package_manager.clone())
                        .unwrap_or_default(),
                });

                let uninstall_start = Instant::now();

                let uninstall_result = tokio::time::timeout(
                    Duration::from_secs(120),
                    tokio::task::spawn_blocking({
                        let platform = Arc::clone(&platform);
                        let app = app.clone();
                        move || platform.uninstall_app_native(&app)
                    }),
                )
                .await;

                let exit_code = match &uninstall_result {
                    Ok(Ok(Ok(()))) => 0,
                    Ok(Ok(Err(e))) => {
                        let _ = event_bus.emit(UninstallEvent::OfficialUninstallerCompleted {
                            op_id: op_id.clone(),
                            exit_code: -1,
                            duration_ms: uninstall_start.elapsed().as_millis() as u64,
                        });
                        let _ = event_bus.emit(UninstallEvent::UninstallError {
                            op_id: op_id.clone(),
                            message: format!("Official uninstaller failed: {}", e.message),
                            recoverable: true,
                        });
                        -1
                    }
                    Ok(Err(e)) => {
                        let _ = event_bus.emit(UninstallEvent::UninstallError {
                            op_id: op_id.clone(),
                            message: format!("Task error: {}", e),
                            recoverable: false,
                        });
                        return UninstallResult {
                            total_deleted,
                            total_freed,
                            failed_items,
                        };
                    }
                    Err(_) => {
                        let _ = event_bus.emit(UninstallEvent::UninstallError {
                            op_id: op_id.clone(),
                            message: "Official uninstaller timed out after 120 seconds".to_string(),
                            recoverable: false,
                        });
                        return UninstallResult {
                            total_deleted,
                            total_freed,
                            failed_items,
                        };
                    }
                };

                let _ = event_bus.emit(UninstallEvent::OfficialUninstallerCompleted {
                    op_id: op_id.clone(),
                    exit_code,
                    duration_ms: uninstall_start.elapsed().as_millis() as u64,
                });

                let _ = event_bus.emit(UninstallEvent::ResidualScanStarted {
                    op_id: op_id.clone(),
                });
            }

            UninstallMode::TrashOnly => {
                let _ = event_bus.emit(UninstallEvent::AppMoveStarted {
                    op_id: op_id.clone(),
                    app_path: app.app_path.clone(),
                });

                let app_path_buf = std::path::PathBuf::from(&app.app_path);
                if app_path_buf.exists() {
                    let app_size = crate::platform::common::get_file_size(&app_path_buf);
                    let platform_for_move = Arc::clone(&platform);
                    let path_for_move = app_path_buf.clone();
                    let move_result = tokio::task::spawn_blocking(move || {
                        platform_for_move.move_to_trash(&path_for_move)
                    })
                    .await;

                    match move_result {
                        Ok(Ok(())) => {
                            total_deleted += 1;
                            total_freed += app_size;
                        }
                        Ok(Err(e)) => {
                            failed_items.push(FailedItem {
                                path: app_path_buf.clone(),
                                error: e.message.clone(),
                            });
                        }
                        Err(e) => {
                            failed_items.push(FailedItem {
                                path: app_path_buf.clone(),
                                error: format!("Task error: {}", e),
                            });
                        }
                    }
                }
            }

            UninstallMode::ResidualOnly | UninstallMode::Reset => {
                // Skip app removal, only delete residuals
            }
        }

        // Delete residual paths (if any), skipping excluded paths
        let exclude_set: std::collections::HashSet<String> = exclude_paths.into_iter().collect();
        for path_str in &residual_paths {
            if exclude_set.contains(path_str) {
                continue;
            }

            if cancel_token.is_cancelled() {
                let _ = event_bus.emit(UninstallEvent::UninstallCancelled {
                    op_id: op_id.clone(),
                });
                break;
            }

            let path = std::path::PathBuf::from(path_str);
            let file_size = if path.exists() {
                crate::platform::common::get_file_size(&path)
            } else {
                0
            };

            if safe_mode {
                let platform_for_trash = Arc::clone(&platform);
                let path_for_trash = path.clone();
                let trash_result = tokio::task::spawn_blocking(move || {
                    platform_for_trash.move_to_trash(&path_for_trash)
                })
                .await;
                match trash_result {
                    Ok(Ok(())) => {
                        total_deleted += 1;
                        total_freed += file_size;
                    }
                    Ok(Err(e)) => {
                        failed_items.push(FailedItem {
                            path: path.clone(),
                            error: e.message.clone(),
                        });
                        let _ = event_bus.emit(UninstallEvent::UninstallError {
                            op_id: op_id.clone(),
                            message: format!("Failed to move to trash {}: {}", path_str, e.message),
                            recoverable: true,
                        });
                        continue;
                    }
                    Err(e) => {
                        failed_items.push(FailedItem {
                            path: path.clone(),
                            error: format!("Task error: {}", e),
                        });
                        continue;
                    }
                }
            } else {
                let path_clone = path.clone();
                let result = tokio::time::timeout(
                    Duration::from_secs(30),
                    tokio::task::spawn_blocking(move || {
                        if path_clone.is_dir() {
                            std::fs::remove_dir_all(&path_clone)
                        } else {
                            std::fs::remove_file(&path_clone)
                        }
                    }),
                )
                .await;

                match result {
                    Ok(Ok(Ok(()))) => {
                        total_deleted += 1;
                        total_freed += file_size;
                    }
                    _ => {
                        let platform_for_remove = Arc::clone(&platform);
                        let path_for_remove = path.clone();
                        let remove_result = tokio::time::timeout(
                            Duration::from_secs(30),
                            tokio::task::spawn_blocking(move || {
                                platform_for_remove.safe_remove(&path_for_remove)
                            }),
                        )
                        .await;
                        match remove_result {
                            Ok(Ok(Ok(()))) => {
                                total_deleted += 1;
                                total_freed += file_size;
                            }
                            Ok(Ok(Err(e))) => {
                                failed_items.push(FailedItem {
                                    path: path.clone(),
                                    error: e.message.clone(),
                                });
                                let _ = event_bus.emit(UninstallEvent::UninstallError {
                                    op_id: op_id.clone(),
                                    message: format!(
                                        "Failed to remove {}: {}",
                                        path_str, e.message
                                    ),
                                    recoverable: true,
                                });
                                continue;
                            }
                            Ok(Err(e)) => {
                                failed_items.push(FailedItem {
                                    path: path.clone(),
                                    error: format!("Task error: {}", e),
                                });
                                continue;
                            }
                            Err(_) => {
                                failed_items.push(FailedItem {
                                    path: path.clone(),
                                    error: "Timeout: removal exceeded 30 seconds".to_string(),
                                });
                                continue;
                            }
                        }
                    }
                }
            }

            let _ = event_bus.emit(UninstallEvent::DeleteProgress {
                op_id: op_id.clone(),
                deleted_files: total_deleted,
                freed_bytes: total_freed,
                current_path: path_str.clone(),
            });
        }

        UninstallResult {
            total_deleted,
            total_freed,
            failed_items,
        }
    }

    /// Retry deleting a list of failed paths.
    /// Returns a new operation ID for event tracking.
    pub fn retry_failed_items(
        &self,
        paths: Vec<String>,
        safe_mode: bool,
    ) -> Result<String, String> {
        // Global concurrency limit
        if UninstallState::current() != UninstallState::Idle {
            return Err("Another uninstall operation is in progress".to_string());
        }
        UninstallState::set(UninstallState::InProgress);

        let op_id = Uuid::new_v4().to_string();
        let event_bus = Arc::clone(&self.event_bus);
        let platform = Arc::clone(&self.platform);
        let op_registry = Arc::clone(&self.op_registry);
        let op_id_clone = op_id.clone();

        tauri::async_runtime::spawn(async move {
            let _guard = UninstallGuard;
            let cancel_token = op_registry.register(&op_id_clone).await;
            let start = Instant::now();

            let mut total_deleted: u64 = 0;
            let mut total_freed: u64 = 0;
            let mut failed_items: Vec<FailedItem> = Vec::new();

            for path_str in &paths {
                if cancel_token.is_cancelled() {
                    let _ = event_bus.emit(UninstallEvent::UninstallCancelled {
                        op_id: op_id_clone.clone(),
                    });
                    break;
                }

                let path = std::path::PathBuf::from(path_str);
                let file_size = if path.exists() {
                    crate::platform::common::get_file_size(&path)
                } else {
                    // Path no longer exists — count as success
                    total_deleted += 1;
                    continue;
                };

                if safe_mode {
                    let platform_for_trash = Arc::clone(&platform);
                    let path_for_trash = path.clone();
                    let trash_result = tokio::time::timeout(
                        Duration::from_secs(30),
                        tokio::task::spawn_blocking(move || {
                            platform_for_trash.move_to_trash(&path_for_trash)
                        }),
                    )
                    .await;
                    match trash_result {
                        Ok(Ok(Ok(()))) => {
                            total_deleted += 1;
                            total_freed += file_size;
                        }
                        Ok(Ok(Err(e))) => {
                            failed_items.push(FailedItem {
                                path: path.clone(),
                                error: e.message.clone(),
                            });
                            continue;
                        }
                        Ok(Err(_)) => {
                            failed_items.push(FailedItem {
                                path: path.clone(),
                                error: "Task error".to_string(),
                            });
                            continue;
                        }
                        Err(_) => {
                            failed_items.push(FailedItem {
                                path: path.clone(),
                                error: "Timeout: trash operation exceeded 30 seconds".to_string(),
                            });
                            continue;
                        }
                    }
                } else {
                    let path_clone = path.clone();
                    let result = tokio::time::timeout(
                        Duration::from_secs(30),
                        tokio::task::spawn_blocking(move || {
                            if path_clone.is_dir() {
                                std::fs::remove_dir_all(&path_clone)
                            } else {
                                std::fs::remove_file(&path_clone)
                            }
                        }),
                    )
                    .await;

                    match result {
                        Ok(Ok(Ok(()))) => {
                            total_deleted += 1;
                            total_freed += file_size;
                        }
                        _ => {
                            let platform_for_remove = Arc::clone(&platform);
                            let path_for_remove = path.clone();
                            let remove_result = tokio::time::timeout(
                                Duration::from_secs(30),
                                tokio::task::spawn_blocking(move || {
                                    platform_for_remove.safe_remove(&path_for_remove)
                                }),
                            )
                            .await;
                            match remove_result {
                                Ok(Ok(Ok(()))) => {
                                    total_deleted += 1;
                                    total_freed += file_size;
                                }
                                Ok(Ok(Err(e))) => {
                                    failed_items.push(FailedItem {
                                        path: path.clone(),
                                        error: e.message.clone(),
                                    });
                                    continue;
                                }
                                Ok(Err(_)) => {
                                    failed_items.push(FailedItem {
                                        path: path.clone(),
                                        error: "Task error".to_string(),
                                    });
                                    continue;
                                }
                                Err(_) => {
                                    failed_items.push(FailedItem {
                                        path: path.clone(),
                                        error: "Timeout: removal exceeded 30 seconds".to_string(),
                                    });
                                    continue;
                                }
                            }
                        }
                    }
                }

                let _ = event_bus.emit(UninstallEvent::DeleteProgress {
                    op_id: op_id_clone.clone(),
                    deleted_files: total_deleted,
                    freed_bytes: total_freed,
                    current_path: path_str.clone(),
                });
            }

            // If all succeeded, clear persisted failed records
            if failed_items.is_empty() {
                clear_failed_uninstalls();
                UninstallState::set(UninstallState::Idle);
            } else {
                UninstallState::set(UninstallState::Failed);
            }

            let duration_ms = start.elapsed().as_millis() as u64;
            let _ = event_bus.emit(UninstallEvent::UninstallCompleted {
                op_id: op_id_clone.clone(),
                total_deleted,
                total_freed,
                duration_ms,
                failed_items,
            });

            op_registry.unregister(&op_id_clone).await;
        });

        Ok(op_id)
    }

    /// Cancel an active uninstall operation.
    pub async fn cancel_operation(&self, op_id: &str) -> bool {
        self.op_registry.cancel(op_id).await
    }

    /// List installed applications using the platform provider.
    pub fn list_installed_apps(&self) -> Vec<InstalledApp> {
        self.platform.list_installed_apps()
    }

    /// Get a reference to the event bus.
    pub fn event_bus(&self) -> &Arc<UninstallEventBus> {
        &self.event_bus
    }

    /// Get a reference to the platform provider.
    pub fn platform(&self) -> &Arc<dyn PlatformProvider + Send + Sync> {
        &self.platform
    }

    /// Get a reference to the operation registry.
    pub fn op_registry(&self) -> &Arc<UninstallOperationRegistry> {
        &self.op_registry
    }
}
