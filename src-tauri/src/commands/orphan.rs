use tauri::{command, State};

use crate::core::engine::CleanEngine;
use crate::core::orphan::{self, OrphanDeleteResult, OrphanGroup};

/// Scan for orphan files left behind by uninstalled applications.
#[command]
pub async fn scan_orphan_files(engine: State<'_, CleanEngine>) -> Result<Vec<OrphanGroup>, String> {
    let platform = engine.platform().clone();
    tokio::task::spawn_blocking(move || orphan::scan_orphan_files(&platform))
        .await
        .map_err(|e| format!("Scan task panicked: {}", e))
}

/// Delete selected orphan file paths.
/// When `safe_mode` is true, files are moved to trash instead of being permanently deleted.
#[command]
pub async fn delete_orphan_files(
    engine: State<'_, CleanEngine>,
    paths: Vec<String>,
    safe_mode: Option<bool>,
) -> Result<OrphanDeleteResult, String> {
    let platform = engine.platform().clone();
    let safe = safe_mode.unwrap_or(true);
    tokio::task::spawn_blocking(move || orphan::delete_orphan_files(&platform, paths, safe))
        .await
        .map_err(|e| format!("Delete task panicked: {}", e))
}
