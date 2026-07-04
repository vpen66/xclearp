use tauri::{command, State};

use crate::core::engine::CleanEngine;
use crate::core::orphan::{self, OrphanDeleteResult, OrphanGroup};

/// Quick scan: returns orphan entries immediately without computing directory sizes.
/// The frontend shows the list instantly; sizes are filled in by `calculate_orphan_stats`.
#[command]
pub async fn quick_scan_orphan_files(
    engine: State<'_, CleanEngine>,
) -> Result<Vec<OrphanGroup>, String> {
    let platform = engine.platform().clone();
    tokio::task::spawn_blocking(move || orphan::quick_scan_orphan_files(&platform))
        .await
        .map_err(|e| format!("Scan task panicked: {}", e))
}

/// Calculate full stats (size, file_count, last_modified) for the given orphan paths.
/// Returns a sparse list of OrphanGroup with only base_path, total_size, file_count,
/// and last_modified filled in. The frontend merges these into the existing list.
#[command]
pub async fn calculate_orphan_stats(paths: Vec<String>) -> Result<Vec<OrphanGroup>, String> {
    tokio::task::spawn_blocking(move || orphan::calculate_orphan_group_stats(paths))
        .await
        .map_err(|e| format!("Size calculation task panicked: {}", e))
}

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
