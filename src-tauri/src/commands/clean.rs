use tauri::{command, State};

use crate::core::engine::CleanEngine;
use crate::core::scanner::ScanTarget;

/// Start a clean operation on the given scan targets.
#[command]
pub async fn start_clean(
    engine: State<'_, CleanEngine>,
    targets: Vec<ScanTarget>,
) -> Result<serde_json::Value, String> {
    if targets.is_empty() {
        return Err("No targets provided for cleaning".to_string());
    }

    let op_id = engine
        .start_clean(targets)
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "op_id": op_id,
    }))
}
