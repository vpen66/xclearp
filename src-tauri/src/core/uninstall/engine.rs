use std::sync::Arc;
use std::time::Instant;

use tokio::sync::Mutex as TokioMutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::InstalledApp;
use super::UninstallMode;
use crate::core::event_bus::UninstallEventBus;
use crate::core::events::UninstallEvent;
use crate::platform::PlatformProvider;

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
    ) -> Result<String, String> {
        let op_id = Uuid::new_v4().to_string();
        let event_bus = Arc::clone(&self.event_bus);
        let platform = Arc::clone(&self.platform);
        let op_registry = Arc::clone(&self.op_registry);
        let op_id_clone = op_id.clone();

        tauri::async_runtime::spawn(async move {
            let cancel_token = op_registry.register(&op_id_clone).await;
            let start = Instant::now();

            let mut total_deleted: u64 = 0;
            let mut total_freed: u64 = 0;

            // Handle different uninstall modes
            match mode {
                UninstallMode::OfficialUninstaller => {
                    // Step 1: Execute the official uninstaller
                    let _ = event_bus.emit(UninstallEvent::OfficialUninstallerStarted {
                        op_id: op_id_clone.clone(),
                        command: app
                            .uninstall_string
                            .clone()
                            .or_else(|| app.package_manager.clone())
                            .unwrap_or_default(),
                    });

                    let uninstall_start = Instant::now();
                    let uninstall_result = tokio::task::spawn_blocking({
                        let platform = Arc::clone(&platform);
                        let app = app.clone();
                        move || platform.uninstall_app_native(&app)
                    })
                    .await;

                    let exit_code = match &uninstall_result {
                        Ok(Ok(())) => 0,
                        Ok(Err(e)) => {
                            let _ = event_bus.emit(UninstallEvent::OfficialUninstallerCompleted {
                                op_id: op_id_clone.clone(),
                                exit_code: -1,
                                duration_ms: uninstall_start.elapsed().as_millis() as u64,
                            });
                            let _ = event_bus.emit(UninstallEvent::UninstallError {
                                op_id: op_id_clone.clone(),
                                message: format!("Official uninstaller failed: {}", e.message),
                                recoverable: true,
                            });
                            -1
                        }
                        Err(e) => {
                            let _ = event_bus.emit(UninstallEvent::UninstallError {
                                op_id: op_id_clone.clone(),
                                message: format!("Task error: {}", e),
                                recoverable: false,
                            });
                            let _ = event_bus.emit(UninstallEvent::UninstallCancelled {
                                op_id: op_id_clone.clone(),
                            });
                            op_registry.unregister(&op_id_clone).await;
                            return;
                        }
                    };

                    let _ = event_bus.emit(UninstallEvent::OfficialUninstallerCompleted {
                        op_id: op_id_clone.clone(),
                        exit_code,
                        duration_ms: uninstall_start.elapsed().as_millis() as u64,
                    });

                    // Step 2: Scan residuals after official uninstall
                    let _ = event_bus.emit(UninstallEvent::ResidualScanStarted {
                        op_id: op_id_clone.clone(),
                    });

                    // Note: residual_paths already provided by the user from a prior scan
                    // We proceed directly to deleting the selected residuals
                }

                UninstallMode::TrashOnly => {
                    // Move the .app bundle to trash
                    let _ = event_bus.emit(UninstallEvent::AppMoveStarted {
                        op_id: op_id_clone.clone(),
                        app_path: app.app_path.clone(),
                    });

                    let app_path_buf = std::path::PathBuf::from(&app.app_path);
                    if app_path_buf.exists() {
                        let app_size = crate::platform::common::get_file_size(&app_path_buf);
                        let move_result = tokio::task::spawn_blocking({
                            let app_path_buf = app_path_buf.clone();
                            let platform_for_move = Arc::clone(&platform);
                            move || platform_for_move.move_to_trash(&app_path_buf)
                        })
                        .await;

                        match move_result {
                            Ok(Ok(())) => {
                                total_deleted += 1;
                                total_freed += app_size;
                            }
                            Ok(Err(e)) => {
                                let _ = event_bus.emit(UninstallEvent::UninstallError {
                                    op_id: op_id_clone.clone(),
                                    message: format!("Failed to move app to trash: {}", e.message),
                                    recoverable: false,
                                });
                                let _ = event_bus.emit(UninstallEvent::UninstallCancelled {
                                    op_id: op_id_clone.clone(),
                                });
                                op_registry.unregister(&op_id_clone).await;
                                return;
                            }
                            Err(e) => {
                                let _ = event_bus.emit(UninstallEvent::UninstallError {
                                    op_id: op_id_clone.clone(),
                                    message: format!("Task error moving app: {}", e),
                                    recoverable: false,
                                });
                                let _ = event_bus.emit(UninstallEvent::UninstallCancelled {
                                    op_id: op_id_clone.clone(),
                                });
                                op_registry.unregister(&op_id_clone).await;
                                return;
                            }
                        }
                    }
                }

                UninstallMode::ResidualOnly => {
                    // Skip app removal, only delete residuals
                }
            }

            // Delete residual paths (if any)
            for path_str in &residual_paths {
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
                    0
                };

                // Try direct removal first
                let result = tokio::task::spawn_blocking({
                    let path = path.clone();
                    move || {
                        if path.is_dir() {
                            std::fs::remove_dir_all(&path)
                        } else {
                            std::fs::remove_file(&path)
                        }
                    }
                })
                .await;

                match result {
                    Ok(Ok(())) => {
                        total_deleted += 1;
                        total_freed += file_size;
                    }
                    _ => {
                        // Fallback to platform safe_remove
                        match platform.safe_remove(&path) {
                            Ok(()) => {
                                total_deleted += 1;
                                total_freed += file_size;
                            }
                            Err(e) => {
                                let _ = event_bus.emit(UninstallEvent::UninstallError {
                                    op_id: op_id_clone.clone(),
                                    message: format!(
                                        "Failed to remove {}: {}",
                                        path_str, e.message
                                    ),
                                    recoverable: true,
                                });
                                continue;
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

            let duration_ms = start.elapsed().as_millis() as u64;
            let _ = event_bus.emit(UninstallEvent::UninstallCompleted {
                op_id: op_id_clone.clone(),
                total_deleted,
                total_freed,
                duration_ms,
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
    #[allow(dead_code)]
    pub fn event_bus(&self) -> &Arc<UninstallEventBus> {
        &self.event_bus
    }
}
