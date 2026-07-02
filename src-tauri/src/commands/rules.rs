use std::fs;
use std::path::PathBuf;
use tauri::command;
use uuid::Uuid;

use crate::core::rules::{self, aggregate_rule_groups, CleanRule, RuleGroup};

/// Get all rule groups (aggregated from embedded + custom rules).
#[command]
pub async fn get_groups() -> Result<Vec<RuleGroup>, String> {
    let all_rules = rules::load_all_rules();
    let platform = rules::current_platform();
    let platform_rules = rules::filter_rules_by_platform(&all_rules, platform);
    Ok(aggregate_rule_groups(&platform_rules))
}

/// Get all rules for the current platform (embedded + custom).
#[command]
pub async fn get_rules() -> Result<Vec<CleanRule>, String> {
    let all_rules = rules::load_all_rules();
    let platform = rules::current_platform();
    Ok(rules::filter_rules_by_platform(&all_rules, platform))
}

/// Update an existing rule (persists to the user custom rules directory).
#[command]
pub async fn update_rule(rule: CleanRule) -> Result<bool, String> {
    let custom_dir = get_custom_rules_dir()?;
    
    // Try to update the rule in place in existing files
    let mut updated = false;
    if let Ok(entries) = fs::read_dir(&custom_dir) {
        for entry in entries {
            if let Ok(entry) = entry {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("json") {
                    if let Ok(content) = fs::read_to_string(&path) {
                        if let Ok(mut rules) = serde_json::from_str::<Vec<CleanRule>>(&content) {
                            if let Some(pos) = rules.iter().position(|r| r.id == rule.id) {
                                rules[pos] = rule.clone();
                                if let Ok(json) = serde_json::to_string_pretty(&rules) {
                                    if fs::write(&path, json).is_ok() {
                                        updated = true;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if !updated {
        // Fallback: write as a single-element array to a new file
        let file_path = custom_dir.join(format!("{}.json", rule.id));
        let json = serde_json::to_string_pretty(&vec![&rule])
            .map_err(|e| format!("Failed to serialize rule: {}", e))?;
        fs::write(&file_path, json)
            .map_err(|e| format!("Failed to write rule file: {}", e))?;
    }

    Ok(true)
}

/// Import a list of cleaning rules, updating existing ones in-place and adding new ones.
/// Also auto-creates missing group definitions.
#[command]
pub async fn import_rules(rules: Vec<CleanRule>) -> Result<bool, String> {
    let custom_dir = get_custom_rules_dir()?;
    
    // Auto-create missing groups during import
    let mut defs = rules::load_group_definitions();
    let mut changed_defs = false;
    for rule in &rules {
        if !defs.iter().any(|g| g.id == rule.group) {
            defs.push(rules::GroupDef {
                id: rule.group.clone(),
                name: rule.group.clone(),
                description: "导入的规则组".to_string(),
                icon: "folder".to_string(),
                default_enabled: true,
            });
            changed_defs = true;
        }
    }
    if changed_defs {
        let _ = rules::save_group_definitions(&defs);
    }

    let mut file_rules_map: std::collections::HashMap<PathBuf, Vec<CleanRule>> = std::collections::HashMap::new();
    let mut existing_rule_to_file: std::collections::HashMap<String, PathBuf> = std::collections::HashMap::new();
    
    if let Ok(entries) = fs::read_dir(&custom_dir) {
        for entry in entries {
            if let Ok(entry) = entry {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("json") {
                    if let Ok(content) = fs::read_to_string(&path) {
                        if let Ok(file_rules) = serde_json::from_str::<Vec<CleanRule>>(&content) {
                            for r in &file_rules {
                                existing_rule_to_file.insert(r.id.clone(), path.clone());
                            }
                            file_rules_map.insert(path, file_rules);
                        }
                    }
                }
            }
        }
    }
    
    let mut new_rules = Vec::new();
    
    for rule in rules {
        if let Some(path) = existing_rule_to_file.get(&rule.id) {
            if let Some(vec) = file_rules_map.get_mut(path) {
                if let Some(pos) = vec.iter().position(|r| r.id == rule.id) {
                    vec[pos] = rule;
                } else {
                    vec.push(rule);
                }
            }
        } else {
            new_rules.push(rule);
        }
    }
    
    // Save updated files
    for (path, vec) in file_rules_map {
        let json = serde_json::to_string_pretty(&vec)
            .map_err(|e| format!("Failed to serialize rules: {}", e))?;
        fs::write(path, json)
            .map_err(|e| format!("Failed to write rule file: {}", e))?;
    }
    
    // Save new rules in custom_imported.json
    if !new_rules.is_empty() {
        let imported_path = custom_dir.join("custom_imported.json");
        let mut existing_imported = if imported_path.exists() {
            if let Ok(content) = fs::read_to_string(&imported_path) {
                serde_json::from_str::<Vec<CleanRule>>(&content).unwrap_or_default()
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };
        
        for rule in new_rules {
            if let Some(pos) = existing_imported.iter().position(|r| r.id == rule.id) {
                existing_imported[pos] = rule;
            } else {
                existing_imported.push(rule);
            }
        }
        
        let json = serde_json::to_string_pretty(&existing_imported)
            .map_err(|e| format!("Failed to serialize imported rules: {}", e))?;
        fs::write(imported_path, json)
            .map_err(|e| format!("Failed to write imported rules: {}", e))?;
    }
    
    Ok(true)
}

/// Add a custom rule to the user configuration directory.
#[command]
pub async fn add_custom_rule(rule: CleanRule) -> Result<bool, String> {
    let custom_dir = get_custom_rules_dir()?;
    let file_path = custom_dir.join(format!("custom_{}.json", rule.id));

    let json = serde_json::to_string_pretty(&vec![&rule])
        .map_err(|e| format!("Failed to serialize rule: {}", e))?;
    fs::write(&file_path, json)
        .map_err(|e| format!("Failed to write custom rule file: {}", e))?;

    Ok(true)
}

/// Add a new dynamic rule group.
#[command]
pub async fn add_group(name: String, description: String, icon: String) -> Result<bool, String> {
    let mut defs = rules::load_group_definitions();
    let new_group = rules::GroupDef {
        id: Uuid::new_v4().to_string(),
        name,
        description,
        icon,
        default_enabled: true,
    };
    defs.push(new_group);
    rules::save_group_definitions(&defs)?;
    Ok(true)
}

/// Delete a dynamic rule group.
#[command]
pub async fn delete_group(id: String) -> Result<bool, String> {
    let mut defs = rules::load_group_definitions();
    if let Some(pos) = defs.iter().position(|g| g.id == id) {
        defs.remove(pos);
        rules::save_group_definitions(&defs)?;
    }

    // Also delete any custom rules that belong to this group
    let custom_dir = get_custom_rules_dir()?;
    if custom_dir.exists() {
        if let Ok(entries) = fs::read_dir(&custom_dir) {
            for entry in entries {
                if let Ok(entry) = entry {
                    let path = entry.path();
                    if path.extension().and_then(|e| e.to_str()) == Some("json") {
                        if let Ok(content) = fs::read_to_string(&path) {
                            if let Ok(rules) = serde_json::from_str::<Vec<CleanRule>>(&content) {
                                if rules.iter().any(|r| r.group == id) {
                                    let _ = fs::remove_file(path);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(true)
}

/// Get the user custom rules directory, creating it if needed.
fn get_custom_rules_dir() -> Result<PathBuf, String> {
    let config_dir = dirs::config_dir()
        .ok_or_else(|| "Could not determine config directory".to_string())?;
    let custom_dir = config_dir.join("xclearp").join("rules");
    fs::create_dir_all(&custom_dir)
        .map_err(|e| format!("Failed to create custom rules directory: {}", e))?;
    Ok(custom_dir)
}

/// Get the active whitelist.
#[command]
pub async fn get_whitelist(
    engine: tauri::State<'_, crate::core::engine::CleanEngine>,
) -> Result<crate::core::whitelist::Whitelist, String> {
    let wl = engine.whitelist().read().unwrap().clone();
    Ok(wl)
}

/// Save and update the active whitelist.
#[command]
pub async fn update_whitelist(
    engine: tauri::State<'_, crate::core::engine::CleanEngine>,
    whitelist: crate::core::whitelist::Whitelist,
) -> Result<bool, String> {
    crate::core::whitelist::save_whitelist(&whitelist)?;
    let mut wl_guard = engine.whitelist().write().unwrap();
    *wl_guard = whitelist;
    Ok(true)
}
