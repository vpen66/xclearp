use std::path::{Path, PathBuf};

use super::common;
use super::{PermissionStatus, PlatformError, PlatformProvider};
use crate::core::rules::CleanRule;
use crate::core::uninstall::InstalledApp;

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
        if let Some(stripped) = pattern.strip_prefix("~/") {
            let home = Self::home_dir();
            Some(home.join(stripped))
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
        // Use Finder via AppleScript to move to trash (native macOS behavior)
        let script = format!(
            "tell application \"Finder\" to delete POSIX file \"{}\"",
            path.to_string_lossy()
        );
        let output = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| PlatformError {
                message: format!("Failed to run osascript: {}", e),
                path: Some(path.to_path_buf()),
            })?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(PlatformError {
                message: format!("Failed to move to trash: {}", stderr),
                path: Some(path.to_path_buf()),
            })
        }
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

    fn list_installed_apps(&self) -> Vec<InstalledApp> {
        let mut apps = Vec::new();

        // Scan /Applications and /Applications/Utilities
        let app_dirs = vec![
            PathBuf::from("/Applications"),
            PathBuf::from("/Applications/Utilities"),
            Self::home_dir().join("Applications"),
        ];

        for app_dir in &app_dirs {
            if !app_dir.exists() {
                continue;
            }
            let entries = match std::fs::read_dir(app_dir) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("app") {
                    continue;
                }

                let app_name = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();

                if app_name.is_empty() {
                    continue;
                }

                // Parse Info.plist for bundle_id and version
                let plist_path = path.join("Contents/Info.plist");
                let (bundle_id, version) = if plist_path.exists() {
                    parse_info_plist(&plist_path)
                } else {
                    (String::new(), String::new())
                };

                // Get app size
                let app_size = calculate_dir_size_simple(&path);

                // Get icon path
                let icon_path = find_app_icon(&path);

                apps.push(InstalledApp {
                    name: app_name,
                    bundle_id,
                    version,
                    app_path: path.to_string_lossy().to_string(),
                    icon_path,
                    app_size,
                });
            }
        }

        // Sort by name
        apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        apps
    }
}

/// Parse Info.plist to extract bundle identifier and version.
fn parse_info_plist(path: &Path) -> (String, String) {
    match plist::from_file::<_, plist::Dictionary>(path) {
        Ok(dict) => {
            let bundle_id = dict
                .get("CFBundleIdentifier")
                .and_then(|v| v.as_string())
                .unwrap_or("")
                .to_string();
            let version = dict
                .get("CFBundleShortVersionString")
                .and_then(|v| v.as_string())
                .unwrap_or("")
                .to_string();
            (bundle_id, version)
        }
        Err(_) => (String::new(), String::new()),
    }
}

/// Calculate directory size without depth limit (simple version).
fn calculate_dir_size_simple(path: &Path) -> u64 {
    let mut total: u64 = 0;
    if !path.exists() {
        return 0;
    }
    for entry in walkdir::WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .flatten()
    {
        if entry.file_type().is_file() {
            total += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    total
}

/// Find the app icon path, converting .icns to .png for browser display.
/// Returns the path to a cached PNG file, or None if no icon found.
fn find_app_icon(app_path: &Path) -> Option<String> {
    let resources = app_path.join("Contents/Resources");
    if !resources.exists() {
        return None;
    }

    let icns_path = find_icns_path(app_path, &resources)?;
    convert_icns_to_png(&icns_path, app_path)
}

/// Find the .icns file path inside the app bundle.
fn find_icns_path(app_path: &Path, resources: &Path) -> Option<PathBuf> {
    // First try Info.plist CFBundleIconFile
    let plist_path = app_path.join("Contents/Info.plist");
    if plist_path.exists() {
        if let Ok(dict) = plist::from_file::<_, plist::Dictionary>(&plist_path) {
            if let Some(icon_file) = dict.get("CFBundleIconFile").and_then(|v| v.as_string()) {
                let icon_name = if icon_file.ends_with(".icns") {
                    icon_file.to_string()
                } else {
                    format!("{}.icns", icon_file)
                };
                let icon_path = resources.join(&icon_name);
                if icon_path.exists() {
                    return Some(icon_path);
                }
            }
        }
    }

    // Fallback: find first .icns file in Resources
    if let Ok(entries) = std::fs::read_dir(resources) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("icns") {
                return Some(path);
            }
        }
    }
    None
}

/// Convert .icns to .png using macOS sips, cache in app cache dir.
/// Returns the PNG path if successful.
fn convert_icns_to_png(icns_path: &Path, app_path: &Path) -> Option<String> {
    let app_name = app_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");

    // Use app-specific cache directory
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/Users/unknown"));
    let cache_dir = home.join("Library/Caches/com.xclearp.app/icons");
    if !cache_dir.exists() {
        let _ = std::fs::create_dir_all(&cache_dir);
    }

    let png_path = cache_dir.join(format!("{}.png", app_name));

    // If PNG already cached, return it
    if png_path.exists() {
        return Some(png_path.to_string_lossy().to_string());
    }

    // Convert .icns to .png using sips
    let result = std::process::Command::new("sips")
        .args([
            "-s",
            "format",
            "png",
            "--resampleWidth",
            "128",
            icns_path.to_str()?,
            "--out",
            png_path.to_str()?,
        ])
        .output();

    match result {
        Ok(output) if output.status.success() && png_path.exists() => {
            Some(png_path.to_string_lossy().to_string())
        }
        _ => None,
    }
}
