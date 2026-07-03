use std::path::{Path, PathBuf};

use super::common;
use super::{PermissionStatus, PlatformError, PlatformProvider};
use crate::core::rules::CleanRule;
use crate::core::uninstall::InstalledApp;

/// Windows-specific platform provider.
pub struct WindowsProvider;

impl WindowsProvider {
    pub fn new() -> Self {
        Self
    }

    fn home_dir() -> PathBuf {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("C:\\Users\\Unknown"))
    }

    fn env_var(name: &str) -> Option<String> {
        std::env::var(name).ok()
    }
}

impl PlatformProvider for WindowsProvider {
    fn default_rules(&self) -> Vec<CleanRule> {
        let temp = Self::env_var("TEMP").unwrap_or_else(|| "C:\\Windows\\Temp".to_string());
        let local_app_data = Self::env_var("LOCALAPPDATA").unwrap_or_default();

        vec![
            CleanRule {
                id: "windows_temp".to_string(),
                name: "Windows 临时文件".to_string(),
                group: "system_temp".to_string(),
                description: "Windows 系统临时文件".to_string(),
                platforms: vec!["windows".to_string()],
                paths: vec![temp.clone()],
                file_patterns: vec!["*".to_string()],
                exclude_patterns: vec!["*.lock".to_string()],
                min_age_hours: Some(24),
                max_size_mb: None,
                risk_level: crate::core::rules::RiskLevel::Safe,
                enabled: true,
            },
            CleanRule {
                id: "windows_recycle_bin".to_string(),
                name: "回收站".to_string(),
                group: "trash".to_string(),
                description: "Windows 回收站中的文件".to_string(),
                platforms: vec!["windows".to_string()],
                paths: vec![],
                file_patterns: vec![],
                exclude_patterns: vec![],
                min_age_hours: None,
                max_size_mb: None,
                risk_level: crate::core::rules::RiskLevel::Safe,
                enabled: true,
            },
            CleanRule {
                id: "windows_thumbnail_cache".to_string(),
                name: "缩略图缓存".to_string(),
                group: "system_cache".to_string(),
                description: "Windows 缩略图缓存文件".to_string(),
                platforms: vec!["windows".to_string()],
                paths: vec![format!("{}\\Microsoft\\Windows\\Explorer", local_app_data)],
                file_patterns: vec!["thumbcache_*.db".to_string()],
                exclude_patterns: vec![],
                min_age_hours: None,
                max_size_mb: None,
                risk_level: crate::core::rules::RiskLevel::Safe,
                enabled: true,
            },
        ]
    }

    fn resolve_path(&self, pattern: &str) -> Option<PathBuf> {
        // Handle environment variable patterns like %TEMP%, %LOCALAPPDATA% (with or without subdirectories)
        if let Some(stripped) = pattern.strip_prefix('%') {
            if let Some(end_idx) = stripped.find('%') {
                let var_name = &stripped[..end_idx];
                let remainder = &stripped[end_idx + 1..];
                if let Some(var_val) = Self::env_var(var_name) {
                    let mut resolved = PathBuf::from(var_val);
                    let clean_remainder =
                        remainder.trim_start_matches('\\').trim_start_matches('/');
                    if !clean_remainder.is_empty() {
                        resolved.push(clean_remainder);
                    }
                    return Some(resolved);
                }
            }
        }

        // Handle ~ for home directory
        if let Some(stripped) = pattern.strip_prefix("~/") {
            return Some(Self::home_dir().join(stripped));
        }
        if pattern.starts_with('~') {
            return Some(Self::home_dir());
        }

        let path = PathBuf::from(pattern);
        if path.is_absolute() {
            Some(path)
        } else {
            None
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

    fn move_to_trash(&self, path: &Path) -> Result<(), PlatformError> {
        if !path.exists() {
            return Ok(());
        }
        // Use PowerShell to move to recycle bin
        let ps_script = format!(
            "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('{}', 'OnlyErrorDialogs', 'SendToRecycleBin')",
            path.to_string_lossy().replace('"', "'")
        );
        let output = std::process::Command::new("powershell")
            .args(["-Command", &ps_script])
            .output()
            .map_err(|e| PlatformError {
                message: format!("Failed to run PowerShell: {}", e),
                path: Some(path.to_path_buf()),
            })?;

        if output.status.success() {
            Ok(())
        } else {
            // Fallback to direct removal
            common::safe_remove_impl(path, &PlatformError {
                message: "Failed to trash, direct remove failed".to_string(),
                path: Some(path.to_path_buf()),
            })
        }
    }

    fn empty_trash(&self) -> Result<(), PlatformError> {
        // On Windows, use shell API to empty recycle bin
        // For now, this is a simplified implementation
        Ok(())
    }

    fn cache_dirs(&self) -> Vec<PathBuf> {
        let mut dirs = Vec::new();

        if let Some(local_app_data) = Self::env_var("LOCALAPPDATA") {
            dirs.push(PathBuf::from(format!("{}\\Temp", local_app_data)));
        }

        if let Some(temp) = Self::env_var("TEMP") {
            dirs.push(PathBuf::from(temp));
        }

        dirs
    }

    fn temp_dirs(&self) -> Vec<PathBuf> {
        let mut dirs = vec![std::env::temp_dir()];

        if let Some(temp) = Self::env_var("TEMP") {
            dirs.push(PathBuf::from(temp));
        }

        dirs.push(PathBuf::from("C:\\Windows\\Temp"));
        dirs
    }

    fn name(&self) -> &str {
        "windows"
    }

    fn list_installed_apps(&self) -> Vec<InstalledApp> {
        // Windows stub: not implemented yet
        Vec::new()
    }
}
