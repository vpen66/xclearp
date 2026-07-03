use std::collections::HashMap;

use tauri::{command, State};

use crate::core::uninstall::engine::UninstallEngine;
use crate::core::uninstall::{AppFileGroup, InstalledApp, UninstallMode};

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
#[command]
pub async fn uninstall_app(
    engine: State<'_, UninstallEngine>,
    app: InstalledApp,
    mode: String,
    residual_paths: Vec<String>,
) -> Result<serde_json::Value, String> {
    let uninstall_mode = match mode.as_str() {
        "official_uninstaller" => UninstallMode::OfficialUninstaller,
        "residual_only" => UninstallMode::ResidualOnly,
        _ => UninstallMode::TrashOnly,
    };
    let op_id = engine.uninstall_app(app, uninstall_mode, residual_paths)?;
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
