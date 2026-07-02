use tauri::{command, State};

use crate::core::engine::CleanEngine;
use crate::core::rules::{self, CleanRule};

/// Start a scan operation with the given rule IDs.
#[command]
pub async fn start_scan(
    engine: State<'_, CleanEngine>,
    rule_ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    // Load all rules (embedded + custom) and filter by the requested IDs
    let all_rules = rules::load_all_rules();
    let platform_filter = rules::current_platform();
    let platform_rules = rules::filter_rules_by_platform(&all_rules, platform_filter);

    let selected_rules: Vec<CleanRule> = platform_rules
        .into_iter()
        .filter(|r| rule_ids.contains(&r.id))
        .collect();

    if selected_rules.is_empty() {
        return Err("No matching rules found for the given rule IDs".to_string());
    }

    let op_id = engine
        .start_scan(&selected_rules)
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "op_id": op_id,
    }))
}

/// Cancel an active operation by its ID.
#[command]
pub async fn cancel_operation(
    engine: State<'_, CleanEngine>,
    op_id: String,
) -> Result<bool, String> {
    Ok(engine.cancel_operation(&op_id).await)
}
