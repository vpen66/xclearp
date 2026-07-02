use std::path::{Path, PathBuf};

use crate::core::rules::CleanRule;
use super::{PermissionStatus, PlatformError, PlatformProvider};
use super::common;

/// macOS-specific platform provider.
pub struct MacOSProvider;

impl MacOSProvider {
    pub fn new() -> Self {
        Self
    }

    fn home_dir() -> PathBuf {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("/Users/unknown"))
    }
}

impl PlatformProvider for MacOSProvider {
    fn default_rules(&self) -> Vec<CleanRule> {
        let home = Self::home_dir();
        let home_str = home.to_string_lossy();

        vec![
            CleanRule {
                id: "macos_system_cache".to_string(),
                name: "macOS 系统缓存".to_string(),
                group: "system_cache".to_string(),
                description: "macOS 系统级缓存文件".to_string(),
                platforms: vec!["macos".to_string()],
                paths: vec![format!("{}/Library/Caches", home_str)],
                file_patterns: vec!["*".to_string()],
                exclude_patterns: vec!["*.lock".to_string()],
                min_age_hours: Some(24),
                max_size_mb: None,
                risk_level: crate::core::rules::RiskLevel::Safe,
                enabled: true,
            },
            CleanRule {
                id: "macos_logs".to_string(),
                name: "macOS 日志".to_string(),
                group: "system_temp".to_string(),
                description: "macOS 系统和应用日志文件".to_string(),
                platforms: vec!["macos".to_string()],
                paths: vec![format!("{}/Library/Logs", home_str)],
                file_patterns: vec!["*.log".to_string(), "*.crash".to_string()],
                exclude_patterns: vec![],
                min_age_hours: Some(48),
                max_size_mb: None,
                risk_level: crate::core::rules::RiskLevel::Safe,
                enabled: true,
            },
            CleanRule {
                id: "macos_trash".to_string(),
                name: "废纸篓".to_string(),
                group: "trash".to_string(),
                description: "macOS 废纸篓中的文件".to_string(),
                platforms: vec!["macos".to_string()],
                paths: vec![format!("{}/.Trash", home_str)],
                file_patterns: vec!["*".to_string()],
                exclude_patterns: vec![],
                min_age_hours: None,
                max_size_mb: None,
                risk_level: crate::core::rules::RiskLevel::Safe,
                enabled: true,
            },
        ]
    }

    fn resolve_path(&self, pattern: &str) -> Option<PathBuf> {
        if pattern.starts_with("~/") {
            let home = Self::home_dir();
            Some(home.join(&pattern[2..]))
        } else if pattern.starts_with('~') {
            Some(Self::home_dir())
        } else {
            let path = PathBuf::from(pattern);
            if path.is_absolute() {
                Some(path)
            } else {
                None
            }
        }
    }

    fn check_permission(&self, path: &Path) -> PermissionStatus {
        if !path.exists() {
            return PermissionStatus::Denied;
        }

        match std::fs::metadata(path) {
            Ok(meta) => {
                let perms = meta.permissions();
                if perms.readonly() {
                    PermissionStatus::ReadOnly
                } else {
                    PermissionStatus::Granted
                }
            }
            Err(_) => PermissionStatus::Denied,
        }
    }

    fn safe_remove(&self, path: &Path) -> Result<(), PlatformError> {
        common::safe_remove_impl(path, &PlatformError {
            message: "Failed to remove".to_string(),
            path: Some(path.to_path_buf()),
        })
    }

    fn empty_trash(&self) -> Result<(), PlatformError> {
        let trash_dir = Self::home_dir().join(".Trash");
        if !trash_dir.exists() {
            return Ok(());
        }

        let entries = std::fs::read_dir(&trash_dir).map_err(|e| PlatformError {
            message: format!("Failed to read trash: {}", e),
            path: Some(trash_dir.clone()),
        })?;

        for entry in entries {
            let entry = entry.map_err(|e| PlatformError {
                message: format!("Failed to read entry: {}", e),
                path: Some(trash_dir.clone()),
            })?;
            let path = entry.path();
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(&path);
            } else {
                let _ = std::fs::remove_file(&path);
            }
        }

        Ok(())
    }

    fn cache_dirs(&self) -> Vec<PathBuf> {
        let home = Self::home_dir();
        vec![
            home.join("Library/Caches"),
            PathBuf::from("/Library/Caches"),
            PathBuf::from("/System/Library/Caches"),
        ]
    }

    fn temp_dirs(&self) -> Vec<PathBuf> {
        vec![
            std::env::temp_dir(),
            PathBuf::from("/private/var/folders"),
            PathBuf::from("/tmp"),
        ]
    }

    fn name(&self) -> &str {
        "macos"
    }
}
