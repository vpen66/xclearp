#![allow(dead_code)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use super::common;
use super::{PermissionStatus, PlatformError, PlatformProvider};
use crate::core::event_bus::UninstallEventBus;
use crate::core::events::UninstallEvent;
use crate::core::rules::CleanRule;
use crate::core::uninstall::app_scanner::scan_paths_to_groups;
use crate::core::uninstall::{AppFileCategory, AppFileGroup, InstalledApp, RiskLevel};

/// Linux-specific platform provider (follows XDG Base Directory Specification).
pub struct LinuxProvider;

impl LinuxProvider {
    pub fn new() -> Self {
        Self
    }

    fn home_dir() -> PathBuf {
        dirs::home_dir().unwrap_or_else(std::env::temp_dir)
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

    fn xdg_config_home() -> PathBuf {
        let home = Self::home_dir();
        std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join(".config"))
    }

    fn xdg_state_home() -> PathBuf {
        let home = Self::home_dir();
        std::env::var("XDG_STATE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join(".local/state"))
    }

    /// Build search keywords for fuzzy matching from app name.
    fn search_keywords(name: &str) -> Vec<String> {
        let mut keywords = Vec::new();
        let lower = name.to_lowercase();
        keywords.push(lower.clone());

        // Replace spaces with hyphens: "Google Chrome" -> "google-chrome"
        let hyphenated = lower.replace(' ', "-");
        if hyphenated != lower {
            keywords.push(hyphenated.clone());
        }

        // Remove spaces entirely: "Google Chrome" -> "googlechrome"
        let compact = lower.replace(' ', "");
        if compact != lower && compact != hyphenated {
            keywords.push(compact);
        }

        // Replace spaces with underscores: "Google Chrome" -> "google_chrome"
        let underscored = lower.replace(' ', "_");
        if underscored != lower && underscored != hyphenated {
            keywords.push(underscored);
        }

        keywords
    }
}

// ---------------------------------------------------------------------------
// .desktop file parser
// ---------------------------------------------------------------------------

struct DesktopEntry {
    name: String,
    exec: String,
    icon: String,
    version: String,
    #[allow(dead_code)]
    desktop_file_path: String,
}

/// Parse a .desktop file and extract the Application entry fields.
fn parse_desktop_file(path: &Path) -> Option<DesktopEntry> {
    let content = std::fs::read_to_string(path).ok()?;

    let mut in_desktop_entry = false;
    let mut name = String::new();
    let mut exec = String::new();
    let mut icon = String::new();
    let mut version = String::new();
    let mut entry_type = String::new();
    let mut no_display = false;

    for line in content.lines() {
        let trimmed = line.trim();

        if trimmed.starts_with('[') {
            in_desktop_entry = trimmed == "[Desktop Entry]";
            continue;
        }

        if !in_desktop_entry || trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        if let Some(val) = trimmed.strip_prefix("Name=") {
            if name.is_empty() {
                // Take the first Name= (default locale)
                name = val.trim().to_string();
            }
        } else if let Some(val) = trimmed.strip_prefix("Exec=") {
            exec = val.trim().to_string();
        } else if let Some(val) = trimmed.strip_prefix("Icon=") {
            icon = val.trim().to_string();
        } else if let Some(val) = trimmed.strip_prefix("Version=") {
            version = val.trim().to_string();
        } else if let Some(val) = trimmed.strip_prefix("Type=") {
            entry_type = val.trim().to_string();
        } else if let Some(val) = trimmed.strip_prefix("NoDisplay=") {
            no_display = val.trim().eq_ignore_ascii_case("true");
        }
    }

    // Only accept Application type
    if entry_type != "Application" && !entry_type.is_empty() {
        return None;
    }
    if no_display || name.is_empty() {
        return None;
    }

    Some(DesktopEntry {
        name,
        exec,
        icon,
        version,
        desktop_file_path: path.to_string_lossy().to_string(),
    })
}

/// Parse the Exec field to extract the actual executable path.
/// Removes field codes like %f, %F, %u, %U, etc.
fn parse_exec_field(exec: &str) -> String {
    let parts: Vec<&str> = exec.split_whitespace().collect();
    for part in &parts {
        let p = part.trim_matches('"').trim_matches('\'');
        if !p.starts_with('%') && !p.is_empty() {
            return p.to_string();
        }
    }
    String::new()
}

/// Resolve an icon name to an actual icon file path.
fn resolve_icon_path(icon: &str) -> Option<String> {
    if icon.is_empty() {
        return None;
    }

    // If it's an absolute path, use directly
    let icon_path = Path::new(icon);
    if icon_path.is_absolute() && icon_path.exists() {
        return Some(icon.to_string());
    }

    // Search in standard icon directories
    let search_dirs = vec![
        PathBuf::from("/usr/share/icons/hicolor/128x128/apps"),
        PathBuf::from("/usr/share/icons/hicolor/64x64/apps"),
        PathBuf::from("/usr/share/icons/hicolor/48x48/apps"),
        PathBuf::from("/usr/share/icons/hicolor/scalable/apps"),
        PathBuf::from("/usr/share/pixmaps"),
        LinuxProvider::home_dir().join(".local/share/icons/hicolor/128x128/apps"),
    ];

    let extensions = ["png", "svg", "xpm"];

    for dir in &search_dirs {
        for ext in &extensions {
            let candidate = dir.join(format!("{}.{}", icon, ext));
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }

    None
}

/// Detect which system package manager is available.
fn detect_package_manager() -> String {
    let managers = ["apt", "dnf", "pacman", "zypper", "apk"];
    for mgr in &managers {
        if std::process::Command::new("which")
            .arg(mgr)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return mgr.to_string();
        }
    }
    "unknown".to_string()
}

/// Try to determine the package name for a given executable.
fn find_package_name(exec_path: &str) -> Option<String> {
    if exec_path.is_empty() {
        return None;
    }

    // Try dpkg -S (Debian/Ubuntu)
    if let Ok(output) = std::process::Command::new("dpkg")
        .args(["-S", exec_path])
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(first_line) = stdout.lines().next() {
                if let Some(colon) = first_line.find(':') {
                    return Some(first_line[..colon].trim().to_string());
                }
            }
        }
    }

    // Try rpm -qf (Fedora/RHEL)
    if let Ok(output) = std::process::Command::new("rpm")
        .args(["-qf", "%{NAME}", exec_path])
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !stdout.is_empty() && !stdout.contains("not owned") {
                return Some(stdout);
            }
        }
    }

    // Try pacman -Qo (Arch)
    if let Ok(output) = std::process::Command::new("pacman")
        .args(["-Qo", exec_path])
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            // Output: "/path is owned by package version"
            if let Some(owned_by) = stdout.find("is owned by") {
                let rest = &stdout[owned_by + 12..];
                let pkg = rest.split_whitespace().next().unwrap_or("");
                if !pkg.is_empty() {
                    return Some(pkg.to_string());
                }
            }
        }
    }

    None
}

/// Determine the package manager type based on the .desktop file path.
fn detect_package_manager_from_path(desktop_path: &str) -> (String, Option<String>) {
    if desktop_path.contains("flatpak") {
        // Extract Flatpak app ID from path
        // e.g. /var/lib/flatpak/exports/share/applications/com.spotify.Client.desktop
        let filename = Path::new(desktop_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        return ("flatpak".to_string(), Some(filename.to_string()));
    }
    if desktop_path.contains("snapd") {
        // Extract snap name from path
        let filename = Path::new(desktop_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        let snap_name = filename.split('_').next().unwrap_or(filename);
        return ("snap".to_string(), Some(snap_name.to_string()));
    }

    (detect_package_manager(), None)
}

// ---------------------------------------------------------------------------
// PlatformProvider implementation
// ---------------------------------------------------------------------------

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
        if let Some(stripped) = pattern.strip_prefix("~/") {
            let home = Self::home_dir();
            Some(home.join(stripped))
        } else if pattern.starts_with('~') {
            Some(Self::home_dir())
        } else if let Some(stripped) = pattern.strip_prefix("$XDG_CACHE_HOME") {
            Some(Self::xdg_cache_home().join(stripped))
        } else if let Some(stripped) = pattern.strip_prefix("$XDG_DATA_HOME") {
            Some(Self::xdg_data_home().join(stripped))
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
        let output = std::process::Command::new("gio")
            .args(["trash", &path.to_string_lossy()])
            .output()
            .or_else(|_| std::process::Command::new("trash-put").arg(path).output())
            .map_err(|e| PlatformError {
                message: format!("Failed to move to trash: {}", e),
                path: Some(path.to_path_buf()),
            })?;

        if output.status.success() {
            Ok(())
        } else {
            common::safe_remove_impl(
                path,
                &PlatformError {
                    message: "Failed to trash, direct remove failed".to_string(),
                    path: Some(path.to_path_buf()),
                },
            )
        }
    }

    fn empty_trash(&self) -> Result<(), PlatformError> {
        let trash_dir = Self::xdg_data_home().join("Trash");
        if !trash_dir.exists() {
            return Ok(());
        }

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

    fn list_installed_apps(&self) -> Vec<InstalledApp> {
        let mut apps = Vec::new();
        let home = Self::home_dir();

        let scan_dirs = vec![
            (PathBuf::from("/usr/share/applications"), false),
            (home.join(".local/share/applications"), false),
            (
                PathBuf::from("/var/lib/flatpak/exports/share/applications"),
                true,
            ),
            (
                home.join(".local/share/flatpak/exports/share/applications"),
                true,
            ),
            (PathBuf::from("/var/lib/snapd/desktop/applications"), true),
        ];

        let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();

        for (dir, _is_special) in &scan_dirs {
            if !dir.exists() {
                continue;
            }
            let entries = match std::fs::read_dir(dir) {
                Ok(e) => e,
                Err(_) => continue,
            };

            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
                    continue;
                }

                let desktop = match parse_desktop_file(&path) {
                    Some(d) => d,
                    None => continue,
                };

                // Dedup by name
                let lower_name = desktop.name.to_lowercase();
                if seen_names.contains(&lower_name) {
                    continue;
                }
                seen_names.insert(lower_name);

                let exec_path = parse_exec_field(&desktop.exec);
                let icon_path = resolve_icon_path(&desktop.icon);
                let (pkg_mgr, pkg_name) =
                    detect_package_manager_from_path(&desktop.desktop_file_path);

                // Determine final package name
                let final_pkg_name = pkg_name.or_else(|| {
                    if pkg_mgr == "flatpak" || pkg_mgr == "snap" {
                        None
                    } else {
                        find_package_name(&exec_path)
                    }
                });

                let app_size = if !exec_path.is_empty() {
                    let exe = PathBuf::from(&exec_path);
                    if exe.exists() {
                        crate::platform::common::get_file_size(&exe)
                    } else {
                        0
                    }
                } else {
                    0
                };

                apps.push(InstalledApp {
                    name: desktop.name,
                    bundle_id: String::new(),
                    version: desktop.version,
                    app_path: exec_path,
                    icon_path,
                    app_size,
                    uninstall_string: None,
                    install_location: None,
                    publisher: None,
                    package_manager: Some(pkg_mgr),
                    package_name: final_pkg_name,
                    risk_level: RiskLevel::Safe,
                });
            }
        }

        apps.sort_by_key(|a| a.name.to_lowercase());
        apps
    }

    fn scan_app_residuals(
        &self,
        app: &InstalledApp,
        event_bus: &Arc<UninstallEventBus>,
        op_id: &str,
    ) -> Vec<AppFileGroup> {
        let _ = event_bus.emit(UninstallEvent::AppScanStarted {
            op_id: op_id.to_string(),
            app_name: app.name.clone(),
        });
        let start = Instant::now();

        let keywords = Self::search_keywords(&app.name);
        let mut category_paths: HashMap<AppFileCategory, Vec<PathBuf>> = HashMap::new();

        let mut add = |cat: AppFileCategory, p: PathBuf| {
            category_paths.entry(cat).or_default().push(p);
        };

        // ~/.config/{app_name}
        let config_home = Self::xdg_config_home();
        for kw in &keywords {
            let p = config_home.join(kw);
            if p.exists() {
                add(AppFileCategory::UserData, p);
            }
        }

        // ~/.local/share/{app_name}
        let data_home = Self::xdg_data_home();
        for kw in &keywords {
            let p = data_home.join(kw);
            if p.exists() {
                add(AppFileCategory::XdgData, p);
            }
        }

        // ~/.cache/{app_name}
        let cache_home = Self::xdg_cache_home();
        for kw in &keywords {
            let p = cache_home.join(kw);
            if p.exists() {
                add(AppFileCategory::Cache, p);
            }
        }

        // ~/.local/state/{app_name}
        let state_home = Self::xdg_state_home();
        for kw in &keywords {
            let p = state_home.join(kw);
            if p.exists() {
                add(AppFileCategory::XdgState, p);
            }
        }

        // Desktop shortcuts
        let desktop_dir = Self::home_dir().join("Desktop");
        for kw in &keywords {
            let p = desktop_dir.join(format!("{}.desktop", kw));
            if p.exists() {
                add(AppFileCategory::Desktop, p);
            }
        }

        scan_paths_to_groups(category_paths, event_bus, op_id, start)
    }

    fn uninstall_app_native(&self, app: &InstalledApp) -> Result<(), PlatformError> {
        let pm = app.package_manager.as_deref().unwrap_or("unknown");
        let pkg = app.package_name.as_deref().ok_or(PlatformError {
            message: "No package name available for uninstall".into(),
            path: None,
        })?;

        let result = match pm {
            "apt" => std::process::Command::new("pkexec")
                .args(["apt", "remove", "-y", pkg])
                .output(),
            "dnf" => std::process::Command::new("pkexec")
                .args(["dnf", "remove", "-y", pkg])
                .output(),
            "pacman" => std::process::Command::new("pkexec")
                .args(["pacman", "-R", "--noconfirm", pkg])
                .output(),
            "flatpak" => std::process::Command::new("flatpak")
                .args(["uninstall", "-y", pkg])
                .output(),
            "snap" => std::process::Command::new("pkexec")
                .args(["snap", "remove", pkg])
                .output(),
            _ => Err(std::io::Error::other(format!(
                "Unknown package manager: {}",
                pm
            ))),
        };

        match result {
            Ok(output) if output.status.success() => Ok(()),
            Ok(output) => Err(PlatformError {
                message: format!(
                    "Package manager exited with code {}",
                    output.status.code().unwrap_or(-1)
                ),
                path: None,
            }),
            Err(e) => Err(PlatformError {
                message: format!("Failed to run package manager: {}", e),
                path: None,
            }),
        }
    }

    fn supports_official_uninstall(&self, app: &InstalledApp) -> bool {
        app.package_name.is_some()
    }
}
