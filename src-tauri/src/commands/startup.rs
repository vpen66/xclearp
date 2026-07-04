//! Tauri commands for startup item management.

use tauri::command;

use crate::core::startup;

/// List all startup items on the current platform.
#[command]
pub async fn list_startup_items() -> Result<Vec<startup::StartupItem>, String> {
    Ok(startup::list_startup_items())
}

/// Enable or disable a startup item identified by its source path.
#[command]
pub async fn toggle_startup_item(source: String, enabled: bool) -> Result<(), String> {
    startup::toggle_startup_item(&source, enabled)
}

/// Remove a startup item identified by its source path.
#[command]
pub async fn remove_startup_item(source: String) -> Result<(), String> {
    startup::remove_startup_item(&source)
}
