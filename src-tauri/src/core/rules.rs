use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use dirs;

/// Risk level associated with a cleaning rule.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum RiskLevel {
    Safe,
    Medium,
    High,
}

/// A single cleaning rule that defines what files to target.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanRule {
    pub id: String,
    pub name: String,
    pub group: String,
    pub description: String,
    pub platforms: Vec<String>,
    pub paths: Vec<String>,
    pub file_patterns: Vec<String>,
    pub exclude_patterns: Vec<String>,
    pub min_age_hours: Option<u64>,
    pub max_size_mb: Option<u64>,
    pub risk_level: RiskLevel,
    pub enabled: bool,
}

/// A group of related cleaning rules.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleGroup {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub rules: Vec<CleanRule>,
    pub default_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupDef {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub default_enabled: bool,
}

pub fn get_groups_file_path() -> PathBuf {
    let config_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    config_dir.join("xclearp").join("groups.json")
}

pub fn load_group_definitions() -> Vec<GroupDef> {
    let path = get_groups_file_path();
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(defs) = serde_json::from_str::<Vec<GroupDef>>(&content) {
                return defs;
            }
        }
    }

    // Default groups (excluding developer dev_tools or keep them, but in Chinese. Let's list the core 5 or 6 ones.
    // The user said "不要英文那个了" - they probably meant the dev_tools or they just want them all Chinese. We will translate dev_tools to '开发工具缓存' and it's deleteable anyway!)
    let defaults = vec![
        GroupDef {
            id: "browser_cache".to_string(),
            name: "浏览器缓存".to_string(),
            description: "清理浏览器产生的缓存文件".to_string(),
            icon: "globe".to_string(),
            default_enabled: true,
        },
        GroupDef {
            id: "system_temp".to_string(),
            name: "系统临时文件".to_string(),
            description: "清理系统和应用临时文件".to_string(),
            icon: "folder".to_string(),
            default_enabled: true,
        },
        GroupDef {
            id: "system_cache".to_string(),
            name: "系统缓存".to_string(),
            description: "清理缩略图缓存、字体缓存等".to_string(),
            icon: "hard-drive".to_string(),
            default_enabled: true,
        },
        GroupDef {
            id: "dev_tools".to_string(),
            name: "开发工具缓存".to_string(),
            description: "清理开发工具的缓存文件".to_string(),
            icon: "code".to_string(),
            default_enabled: false,
        },
        GroupDef {
            id: "trash".to_string(),
            name: "回收站".to_string(),
            description: "清空系统回收站与垃圾桶".to_string(),
            icon: "trash-2".to_string(),
            default_enabled: true,
        },
        GroupDef {
            id: "crash_dumps".to_string(),
            name: "崩溃转储".to_string(),
            description: "清理应用崩溃产生的转储与日志文件".to_string(),
            icon: "alert-triangle".to_string(),
            default_enabled: true,
        },
        GroupDef {
            id: "build_artifacts".to_string(),
            name: "构建产物".to_string(),
            description: "清理项目构建产物，如 target、node_modules、dist 等".to_string(),
            icon: "hammer".to_string(),
            default_enabled: false,
        },
    ];

    let _ = save_group_definitions(&defaults);
    defaults
}

pub fn save_group_definitions(defs: &[GroupDef]) -> Result<(), String> {
    let path = get_groups_file_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(defs).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn load_all_rules() -> Vec<CleanRule> {
    let custom_dir = match dirs::config_dir() {
        Some(config_dir) => config_dir.join("xclearp").join("rules"),
        None => PathBuf::from(".").join("rules"),
    };

    let _ = fs::create_dir_all(&custom_dir);
    let defaults = vec![
        ("browser_cache.json", include_str!("../../rules/browser_cache.json")),
        ("system_temp.json", include_str!("../../rules/system_temp.json")),
        ("system_cache.json", include_str!("../../rules/system_cache.json")),
        ("dev_tools.json", include_str!("../../rules/dev_tools.json")),
        ("trash.json", include_str!("../../rules/trash.json")),
        ("crash_dumps.json", include_str!("../../rules/crash_dumps.json")),
        ("build_artifacts.json", include_str!("../../rules/build_artifacts.json")),
    ];
    for (filename, content) in defaults {
        let file_path = custom_dir.join(filename);
        if !file_path.exists() {
            let _ = fs::write(file_path, content);
        }
    }

    let raw_rules = load_rules_from_dir(&custom_dir).unwrap_or_default();

    // Deduplicate rules by ID, keeping the latest loaded rule.
    let mut rules_map = HashMap::new();
    for rule in raw_rules {
        rules_map.insert(rule.id.clone(), rule);
    }

    rules_map.into_values().collect()
}

/// Load all rules from JSON files in the given directory.
pub fn load_rules_from_dir(dir: &Path) -> Result<Vec<CleanRule>, String> {
    let mut all_rules = Vec::new();

    if !dir.exists() {
        return Ok(all_rules);
    }

    let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read rules directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            let content =
                fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
            let rules: Vec<CleanRule> = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse {}: {}", path.display(), e))?;
            all_rules.extend(rules);
        }
    }

    Ok(all_rules)
}



/// Filter rules by the current platform.
pub fn filter_rules_by_platform(rules: &[CleanRule], platform: &str) -> Vec<CleanRule> {
    rules
        .iter()
        .filter(|r| r.platforms.iter().any(|p| p == platform))
        .cloned()
        .collect()
}

/// Aggregate rules into rule groups.
pub fn aggregate_rule_groups(rules: &[CleanRule]) -> Vec<RuleGroup> {
    let mut group_map: HashMap<String, Vec<CleanRule>> = HashMap::new();

    for rule in rules {
        group_map
            .entry(rule.group.clone())
            .or_default()
            .push(rule.clone());
    }

    let group_defs = load_group_definitions();

    group_defs
        .iter()
        .map(|g| {
            let rules = group_map.get(&g.id).cloned().unwrap_or_default();
            RuleGroup {
                id: g.id.clone(),
                name: g.name.clone(),
                description: g.description.clone(),
                icon: g.icon.clone(),
                rules,
                default_enabled: g.default_enabled,
            }
        })
        .collect()
}

/// Get the current platform identifier.
pub fn current_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}
