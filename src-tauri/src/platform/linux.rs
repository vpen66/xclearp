use std::path::{Path, PathBuf};

use super::common;
use super::{PermissionStatus, PlatformError, PlatformProvider};
use crate::core::rules::CleanRule;

/// Linux-specific platform provider (follows XDG Base Directory Specification).
pub struct LinuxProvider;

impl LinuxProvider {
    pub fn new() -> Self {
        Self
    }

    fn home_dir() -> PathBuf {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("/home/unknown"))
    }

    fn xdg_cache_home() -> PathBuf {
        let home = Self::home_dir();
        std::env::var("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join(".cache"))
    }

    fn xdg_data_home() -> PathBuf {
        let home = Self::home_dir();
        std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join(".local/share"))
    }
}

impl PlatformProvider for LinuxProvider {
    fn default_rules(&self) -> Vec<CleanRule> {
        let cache = Self::xdg_cache_home();
        let cache_str = cache.to_string_lossy();

        vec![
            CleanRule {
                id: "linux_cache".to_string(),
                name: "Linux 缓存".to_string(),
                group: "system_cache".to_string(),
                description: "XDG 缓存目录中的文件".to_string(),
                platforms: vec!["linux".to_string()],
                paths: vec![format!("{}", cache_str)],
                file_patterns: vec!["*".to_string()],
                exclude_patterns: vec!["*.lock".to_string()],
                min_age_hours: Some(24),
                max_size_mb: None,
                risk_level: crate::core::rules::RiskLevel::Safe,
                enabled: true,
            },
            CleanRule {
                id: "linux_tmp".to_string(),
                name: "Linux 临时文件".to_string(),
                group: "system_temp".to_string(),
                description: "/tmp 目录中的文件".to_string(),
                platforms: vec!["linux".to_string()],
                paths: vec!["/tmp".to_string()],
                file_patterns: vec!["*".to_string()],
                exclude_patterns: vec![],
                min_age_hours: Some(48),
                max_size_mb: None,
                risk_level: crate::core::rules::RiskLevel::Safe,
                enabled: true,
            },
            CleanRule {
                id: "linux_trash".to_string(),
                name: "回收站".to_string(),
                group: "trash".to_string(),
                description: "Linux 回收站中的文件".to_string(),
                platforms: vec!["linux".to_string()],
                paths: vec![format!("{}/Trash", Self::xdg_data_home().display())],
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
        } else if pattern.starts_with("$XDG_CACHE_HOME") {
            Some(Self::xdg_cache_home().join(&pattern["$XDG_CACHE_HOME".len()..]))
        } else if pattern.starts_with("$XDG_DATA_HOME") {
            Some(Self::xdg_data_home().join(&pattern["$XDG_DATA_HOME".len()..]))
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
        common::safe_remove_impl(
            path,
            &PlatformError {
                message: "Failed to remove".to_string(),
                path: Some(path.to_path_buf()),
            },
        )
    }

    fn empty_trash(&self) -> Result<(), PlatformError> {
        let trash_dir = Self::xdg_data_home().join("Trash");
        if !trash_dir.exists() {
            return Ok(());
        }

        // XDG Trash spec: files/ and info/ subdirectories
        for sub in &["files", "info"] {
            let sub_dir = trash_dir.join(sub);
            if sub_dir.exists() {
                let entries = std::fs::read_dir(&sub_dir).map_err(|e| PlatformError {
                    message: format!("Failed to read trash {}: {}", sub, e),
                    path: Some(sub_dir.clone()),
                })?;

                for entry in entries {
                    let entry = entry.map_err(|e| PlatformError {
                        message: format!("Failed to read entry: {}", e),
                        path: Some(sub_dir.clone()),
                    })?;
                    let path = entry.path();
                    if path.is_dir() {
                        let _ = std::fs::remove_dir_all(&path);
                    } else {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }

        Ok(())
    }

    fn cache_dirs(&self) -> Vec<PathBuf> {
        vec![Self::xdg_cache_home(), PathBuf::from("/var/cache")]
    }

    fn temp_dirs(&self) -> Vec<PathBuf> {
        vec![
            std::env::temp_dir(),
            PathBuf::from("/tmp"),
            PathBuf::from("/var/tmp"),
        ]
    }

    fn name(&self) -> &str {
        "linux"
    }
}
