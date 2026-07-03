use tauri::{command, State};

use crate::core::engine::CleanEngine;
use crate::core::scanner::ScanTarget;

/// Start a clean operation on the given scan targets.
/// When `safe_mode` is true, files are moved to trash instead of being permanently deleted.
#[command]
pub async fn start_clean(
    engine: State<'_, CleanEngine>,
    targets: Vec<ScanTarget>,
    safe_mode: Option<bool>,
) -> Result<serde_json::Value, String> {
    if targets.is_empty() {
        return Err("No targets provided for cleaning".to_string());
    }

    let op_id = engine
        .start_clean(targets, safe_mode.unwrap_or(true))
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "op_id": op_id,
    }))
}
