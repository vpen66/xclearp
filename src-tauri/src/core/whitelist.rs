use glob::Pattern;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use dirs;

/// Three-level whitelist system for excluding paths from cleaning.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Whitelist {
    /// Global exclusions that apply to all rules.
    pub global_excludes: Vec<String>,
    /// Per-group exclusions keyed by group ID.
    pub group_excludes: std::collections::HashMap<String, Vec<String>>,
    /// Per-rule exclusions keyed by rule ID.
    pub rule_excludes: std::collections::HashMap<String, Vec<String>>,
    /// Patterns that are currently disabled (not applied during scanning).
    #[serde(default)]
    pub disabled_patterns: Vec<String>,
    /// Patterns that are shown in disk analysis (eye open).
    #[serde(default)]
    pub show_in_disk_analysis: Vec<String>,
}

impl Default for Whitelist {
    fn default() -> Self {
        let mut global_excludes = vec![
            // Never touch these critical paths
            "**/.git/**".to_string(),
            "**/.gitignore".to_string(),
            "**/node_modules/.cache/**".to_string(),
        ];

        // Platform-specific system exclusions (hidden by default in disk analysis)
        #[cfg(target_os = "macos")]
        {
            global_excludes.push("/System/**".to_string());
            global_excludes.push("/private/**".to_string());
            global_excludes.push("/dev/**".to_string());
            global_excludes.push("/Volumes/**".to_string());
            global_excludes.push("/cores/**".to_string());
        }

        #[cfg(target_os = "windows")]
        {
            global_excludes.push("?:\\Windows\\**".to_string());
            global_excludes.push("?:\\$Recycle.Bin\\**".to_string());
            global_excludes.push("?:\\System Volume Information\\**".to_string());
        }

        #[cfg(target_os = "linux")]
        {
            global_excludes.push("/proc/**".to_string());
            global_excludes.push("/sys/**".to_string());
            global_excludes.push("/dev/**".to_string());
            global_excludes.push("/run/**".to_string());
            global_excludes.push("/boot/**".to_string());
            global_excludes.push("/var/run/**".to_string());
            global_excludes.push("/var/lock/**".to_string());
        }

        let show_in_disk_analysis = vec![
            "**/.git/**".to_string(),
            "**/.gitignore".to_string(),
            "**/node_modules/.cache/**".to_string(),
        ];

        Self {
            global_excludes,
            group_excludes: std::collections::HashMap::new(),
            rule_excludes: std::collections::HashMap::new(),
            disabled_patterns: vec![],
            show_in_disk_analysis,
        }
    }
}

impl Whitelist {
    /// Create a new empty whitelist.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a global exclusion pattern.
    pub fn add_global_exclude(&mut self, pattern: String) {
        if !self.global_excludes.contains(&pattern) {
            self.global_excludes.push(pattern);
        }
    }

    /// Add a group-level exclusion pattern.
    pub fn add_group_exclude(&mut self, group_id: &str, pattern: String) {
        let excludes = self.group_excludes.entry(group_id.to_string()).or_default();
        if !excludes.contains(&pattern) {
            excludes.push(pattern);
        }
    }

    /// Add a rule-level exclusion pattern.
    pub fn add_rule_exclude(&mut self, rule_id: &str, pattern: String) {
        let excludes = self.rule_excludes.entry(rule_id.to_string()).or_default();
        if !excludes.contains(&pattern) {
            excludes.push(pattern);
        }
    }

    /// Check if a path should be excluded for a given rule and group.
    /// Checks all three levels: global, group, and rule.
    /// Disabled patterns are skipped.
    pub fn is_excluded(&self, path: &Path, rule_id: &str, group_id: &str) -> bool {
        let path_str = path.to_string_lossy();

        // Check global excludes (skip disabled)
        if matches_any_pattern(&path_str, &self.global_excludes, &self.disabled_patterns) {
            return true;
        }

        // Check group excludes (skip disabled)
        if let Some(group_patterns) = self.group_excludes.get(group_id) {
            if matches_any_pattern(&path_str, group_patterns, &self.disabled_patterns) {
                return true;
            }
        }

        // Check rule excludes (skip disabled)
        if let Some(rule_patterns) = self.rule_excludes.get(rule_id) {
            if matches_any_pattern(&path_str, rule_patterns, &self.disabled_patterns) {
                return true;
            }
        }

        false
    }

    /// Checks if a path matches any active global exclude pattern.
    /// Returns:
    /// - `Some(true)` if it matches an active pattern and the eye is OPEN (show in disk analysis, but mark as whitelist).
    /// - `Some(false)` if it matches an active pattern and the eye is CLOSED (completely exclude from disk analysis).
    /// - `None` if it does not match any active global exclude pattern.
    pub fn check_disk_analysis_exclude(&self, path: &Path) -> Option<bool> {
        let path_str = path.to_string_lossy();
        
        for pattern_str in &self.global_excludes {
            // If the pattern is disabled, skip it
            if self.disabled_patterns.contains(pattern_str) {
                continue;
            }
            
            // Check if path matches pattern
            if matches_path_or_parent(&path_str, pattern_str) {
                // If it matches, check if the eye is open
                let eye_open = self.show_in_disk_analysis.contains(pattern_str);
                return Some(eye_open);
            }
        }
        None
    }
}

/// Check if a path matches the glob pattern itself, with trailing slash, or as a parent directory.
fn matches_path_or_parent(path_str: &str, pattern_str: &str) -> bool {
    // Normalize path separators to forward slashes for glob matching
    let path_str = path_str.replace('\\', "/");
    let pattern_str = pattern_str.replace('\\', "/");
    
    if let Ok(pattern) = Pattern::new(&pattern_str) {
        if pattern.matches(&path_str) {
            return true;
        }
        // If the pattern is like **/node_modules/** or has a trailing slash,
        // we test it with a trailing slash and a nested dummy child.
        if pattern.matches(&format!("{}/", path_str)) {
            return true;
        }
        if pattern.matches(&format!("{}/dummy", path_str)) {
            return true;
        }
    }
    false
}

/// Check if a path string matches any of the given glob patterns, skipping disabled ones.
fn matches_any_pattern(path: &str, patterns: &[String], disabled: &[String]) -> bool {
    for pattern_str in patterns {
        if disabled.contains(pattern_str) {
            continue;
        }
        if let Ok(pattern) = Pattern::new(pattern_str) {
            if pattern.matches(path) {
                return true;
            }
        }
    }
    false
}

pub fn get_whitelist_file_path() -> PathBuf {
    let config_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    config_dir.join("xclearp").join("whitelist.json")
}

pub fn load_whitelist() -> Whitelist {
    let path = get_whitelist_file_path();
    let mut wl = if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(parsed) = serde_json::from_str::<Whitelist>(&content) {
                parsed
            } else {
                Whitelist::default()
            }
        } else {
            Whitelist::default()
        }
    } else {
        Whitelist::default()
    };

    // Ensure platform-specific defaults are present
    let defaults = Whitelist::default();
    let mut modified = false;
    for pat in defaults.global_excludes {
        if !wl.global_excludes.contains(&pat) {
            wl.global_excludes.push(pat);
            modified = true;
        }
    }

    if modified || !path.exists() {
        let _ = save_whitelist(&wl);
    }

    wl
}

pub fn save_whitelist(wl: &Whitelist) -> Result<(), String> {
    let path = get_whitelist_file_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(wl).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())?;
    Ok(())
}
