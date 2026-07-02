use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;

use tokio_util::sync::CancellationToken;

use super::event_bus::EventBus;
use super::events::CleanEvent;
use super::scanner::ScanTarget;
use crate::platform::PlatformProvider;

/// Summary of a clean operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanSummary {
    pub total_deleted: u64,
    pub total_freed: u64,
    pub duration_ms: u64,
    pub errors: Vec<String>,
}

/// Errors that can occur during cleaning.
#[derive(Debug, Clone)]
pub struct CleanError {
    pub message: String,
}

impl std::fmt::Display for CleanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "CleanError: {}", self.message)
    }
}

impl std::error::Error for CleanError {}

/// Cleaner engine that safely removes scanned files.
pub struct Cleaner {
    event_bus: Arc<EventBus>,
}

impl Cleaner {
    pub fn new(event_bus: Arc<EventBus>) -> Self {
        Self { event_bus }
    }

    /// Clean the given scan targets, returning a summary.
    pub async fn clean_targets(
        &self,
        targets: &[ScanTarget],
        platform: &dyn PlatformProvider,
        op_id: &str,
        cancel_token: CancellationToken,
    ) -> Result<CleanSummary, CleanError> {
        let start = Instant::now();
        let mut total_deleted: u64 = 0;
        let mut total_freed: u64 = 0;
        let mut errors: Vec<String> = Vec::new();

        for target in targets {
            // Check cancellation
            if cancel_token.is_cancelled() {
                let _ = self.event_bus.emit(CleanEvent::Cancelled {
                    op_id: op_id.to_string(),
                });
                break;
            }

            // Get file size before removal for accounting
            let file_size = if target.path.exists() {
                crate::platform::common::get_file_size(&target.path)
            } else {
                target.size
            };

            // Use spawn_blocking per file to avoid blocking the async runtime
            // while keeping the non-Send platform reference on the async task
            let path = target.path.clone();
            let remove_result = tokio::task::spawn_blocking(move || {
                if path.is_dir() {
                    std::fs::remove_dir_all(&path).map_err(|e| e.to_string())
                } else {
                    std::fs::remove_file(&path).map_err(|e| e.to_string())
                }
            })
            .await;

            match remove_result {
                Ok(Ok(())) => {
                    total_deleted += 1;
                    total_freed += file_size;

                    let _ = self.event_bus.emit(CleanEvent::CleanProgress {
                        op_id: op_id.to_string(),
                        deleted_files: total_deleted,
                        freed_bytes: total_freed,
                        current_path: target.path.to_string_lossy().to_string(),
                    });
                }
                Ok(Err(e)) => {
                    // Try platform-specific safe_remove as fallback
                    match platform.safe_remove(&target.path) {
                        Ok(()) => {
                            total_deleted += 1;
                            total_freed += file_size;

                            let _ = self.event_bus.emit(CleanEvent::CleanProgress {
                                op_id: op_id.to_string(),
                                deleted_files: total_deleted,
                                freed_bytes: total_freed,
                                current_path: target.path.to_string_lossy().to_string(),
                            });
                        }
                        Err(pe) => {
                            let error_msg = format!(
                                "Failed to remove {}: {} (fallback: {})",
                                target.path.display(),
                                e,
                                pe
                            );
                            let _ = self.event_bus.emit(CleanEvent::Error {
                                op_id: op_id.to_string(),
                                message: error_msg.clone(),
                                recoverable: true,
                            });
                            errors.push(error_msg);
                        }
                    }
                }
                Err(join_err) => {
                    let error_msg = format!(
                        "Task error removing {}: {}",
                        target.path.display(),
                        join_err
                    );
                    let _ = self.event_bus.emit(CleanEvent::Error {
                        op_id: op_id.to_string(),
                        message: error_msg.clone(),
                        recoverable: true,
                    });
                    errors.push(error_msg);
                }
            }
        }

        let duration_ms = start.elapsed().as_millis() as u64;

        // Emit clean_completed
        let _ = self.event_bus.emit(CleanEvent::CleanCompleted {
            op_id: op_id.to_string(),
            total_deleted,
            total_freed,
            duration_ms,
        });

        Ok(CleanSummary {
            total_deleted,
            total_freed,
            duration_ms,
            errors,
        })
    }
}
