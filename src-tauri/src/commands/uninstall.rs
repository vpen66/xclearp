use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use tauri::{command, State};

use crate::core::events::{FailedItem, UninstallEvent};
use crate::core::uninstall::engine::{
    FailedUninstall, UninstallEngine, UninstallResult, UninstallState,
};
use crate::core::uninstall::{AppFileGroup, BatchAppConfig, InstalledApp, UninstallMode};

/// List all installed applications on the current platform.
#[command]
pub async fn list_apps(engine: State<'_, UninstallEngine>) -> Result<Vec<InstalledApp>, String> {
    Ok(engine.list_installed_apps())
}

/// Scan residual files for a given application.
/// Returns the file groups directly.
#[command]
pub async fn scan_app(
    engine: State<'_, UninstallEngine>,
    app: InstalledApp,
) -> Result<Vec<AppFileGroup>, String> {
    engine.scan_app(app).await
}

/// Uninstall an application with the specified mode.
/// Returns the operation ID for event tracking.
/// When `safe_mode` is true, residual files are moved to trash instead of being permanently deleted.
/// `exclude_paths` contains paths the user unchecked in the review UI — they will be skipped during deletion.
#[command]
pub async fn uninstall_app(
    engine: State<'_, UninstallEngine>,
    app: InstalledApp,
    mode: String,
    residual_paths: Vec<String>,
    safe_mode: Option<bool>,
    exclude_paths: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let uninstall_mode = match mode.as_str() {
        "official_uninstaller" => UninstallMode::OfficialUninstaller,
        "residual_only" => UninstallMode::ResidualOnly,
        "reset" => UninstallMode::Reset,
        _ => UninstallMode::TrashOnly,
    };
    let op_id = engine.uninstall_app(
        app,
        uninstall_mode,
        residual_paths,
        safe_mode.unwrap_or(true),
        exclude_paths.unwrap_or_default(),
    )?;
    Ok(serde_json::json!({ "op_id": op_id }))
}

/// Cancel an active uninstall operation by its ID.
#[command]
pub async fn cancel_uninstall(
    engine: State<'_, UninstallEngine>,
    op_id: String,
) -> Result<bool, String> {
    Ok(engine.cancel_operation(&op_id).await)
}

/// Retry deleting a list of failed paths.
/// Returns the operation ID for event tracking.
#[command]
pub async fn retry_failed_items(
    engine: State<'_, UninstallEngine>,
    paths: Vec<String>,
    safe_mode: Option<bool>,
) -> Result<serde_json::Value, String> {
    let op_id = engine.retry_failed_items(paths, safe_mode.unwrap_or(true))?;
    Ok(serde_json::json!({ "op_id": op_id }))
}

/// Get persisted failed uninstall records.
#[command]
pub async fn get_failed_uninstalls() -> Result<Vec<FailedUninstall>, String> {
    Ok(crate::core::uninstall::engine::load_failed_uninstalls())
}

/// Clear all persisted failed uninstall records.
#[command]
pub async fn clear_failed_uninstalls() -> Result<(), String> {
    crate::core::uninstall::engine::clear_failed_uninstalls();
    Ok(())
}

/// Get the current global uninstall state (Idle, InProgress, or Failed).
#[command]
pub async fn get_uninstall_state() -> Result<String, String> {
    Ok(format!("{:?}", UninstallState::current()))
}

/// Read icon files and return base64 data URLs for browser display.
/// Takes a list of PNG file paths, returns a map of path -> data URL.
#[command]
pub async fn get_icon_data_urls(paths: Vec<String>) -> Result<HashMap<String, String>, String> {
    let mut result = HashMap::new();
    for path_str in &paths {
        let path = std::path::PathBuf::from(path_str);
        if path.exists() {
            if let Ok(Ok(data)) = tokio::task::spawn_blocking(move || std::fs::read(&path)).await {
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
                result.insert(path_str.clone(), format!("data:image/png;base64,{}", b64));
            }
        }
    }
    Ok(result)
}

/// Batch uninstall multiple applications sequentially.
/// Loops through each app calling `engine.run_uninstall`, emitting progress events.
/// Returns the operation ID for event tracking.
#[command]
pub async fn batch_uninstall(
    engine: State<'_, UninstallEngine>,
    configs: Vec<BatchAppConfig>,
    safe_mode: Option<bool>,
) -> Result<serde_json::Value, String> {
    let safe_mode = safe_mode.unwrap_or(true);
    let batch_op_id = uuid::Uuid::new_v4().to_string();
    let total_apps = configs.len();

    let event_bus = Arc::clone(engine.event_bus());
    let platform = Arc::clone(engine.platform());
    let op_registry = Arc::clone(engine.op_registry());
    let batch_op_id_clone = batch_op_id.clone();

    tauri::async_runtime::spawn(async move {
        let cancel_token = op_registry.register(&batch_op_id_clone).await;
        let start = Instant::now();

        let mut grand_deleted: u64 = 0;
        let mut grand_freed: u64 = 0;
        let mut grand_failed: Vec<FailedItem> = Vec::new();

        for (idx, config) in configs.into_iter().enumerate() {
            let mode = match config.mode.as_str() {
                "official_uninstaller" => UninstallMode::OfficialUninstaller,
                "residual_only" => UninstallMode::ResidualOnly,
                "reset" => UninstallMode::Reset,
                _ => UninstallMode::TrashOnly,
            };

            // Emit batch progress event before each app
            let _ = event_bus.emit(UninstallEvent::DeleteProgress {
                op_id: batch_op_id_clone.clone(),
                deleted_files: idx as u64,
                freed_bytes: total_apps as u64,
                current_path: config.app.name.clone(),
            });

            // Call the core uninstall for this app (awaitable, no nested spawn)
            let result: UninstallResult = UninstallEngine::run_uninstall(
                Arc::clone(&event_bus),
                Arc::clone(&platform),
                cancel_token.clone(),
                batch_op_id_clone.clone(),
                config.app,
                mode,
                config.residual_paths,
                safe_mode,
                config.exclude_paths,
            )
            .await;

            grand_deleted += result.total_deleted;
            grand_freed += result.total_freed;
            grand_failed.extend(result.failed_items);
        }

        let duration_ms = start.elapsed().as_millis() as u64;
        let _ = event_bus.emit(UninstallEvent::UninstallCompleted {
            op_id: batch_op_id_clone.clone(),
            total_deleted: grand_deleted,
            total_freed: grand_freed,
            duration_ms,
            failed_items: grand_failed,
        });

        op_registry.unregister(&batch_op_id_clone).await;
    });

    Ok(serde_json::json!({ "op_id": batch_op_id }))
}
