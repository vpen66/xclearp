#![allow(unused_imports, dead_code)]

use std::collections::HashSet;
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

#[cfg(target_os = "windows")]
use winreg::enums::*;
#[cfg(target_os = "windows")]
use winreg::RegKey;

/// Windows-specific platform provider.
pub struct WindowsProvider;

impl WindowsProvider {
    pub fn new() -> Self {
        Self
    }

    fn home_dir() -> PathBuf {
        dirs::home_dir().unwrap_or_else(std::env::temp_dir)
    }

    fn env_var(name: &str) -> Option<String> {
        std::env::var(name).ok()
    }

    /// Build search keywords from app name and publisher for fuzzy matching.
    fn search_keywords(name: &str, publisher: &Option<String>) -> Vec<String> {
        let mut keywords = Vec::new();
        let lower_name = name.to_lowercase();
        keywords.push(lower_name.clone());

        // Remove common suffixes like " (64-bit)", version numbers, etc.
        let cleaned = lower_name
            .split('(')
            .next()
            .unwrap_or(&lower_name)
            .trim()
            .to_string();
        if cleaned != lower_name && !cleaned.is_empty() {
            keywords.push(cleaned);
        }

        if let Some(pub_name) = publisher {
            let lower_pub = pub_name.to_lowercase();
            if !lower_pub.is_empty() && lower_pub != lower_name {
                keywords.push(lower_pub);
            }
        }

        keywords
    }
}

// ---------------------------------------------------------------------------
// Windows-specific helpers (only compiled on Windows)
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn read_registry_apps() -> Vec<InstalledApp> {
    use std::collections::HashMap;

    let registry_paths: Vec<(winreg::HKEY, &str)> = vec![
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
        (
            HKEY_CURRENT_USER,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
    ];

    let mut apps: Vec<InstalledApp> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for (hkey, subkey_path) in &registry_paths {
        let root = RegKey::predef(*hkey);
        let subkey = match root.open_subkey(subkey_path) {
            Ok(k) => k,
            Err(_) => continue,
        };

        for key_name in subkey.enum_keys().flatten() {
            let app_key = match subkey.open_subkey(&key_name) {
                Ok(k) => k,
                Err(_) => continue,
            };

            // Skip system components
            if let Ok(sys_comp) = app_key.get_value::<u32, _>("SystemComponent") {
                if sys_comp == 1 {
                    continue;
                }
            }

            let display_name: String = app_key.get_value("DisplayName").unwrap_or_default();
            if display_name.is_empty() {
                continue;
            }

            // Skip common runtimes and redistributables
            let lower_name = display_name.to_lowercase();
            if lower_name.contains("visual c++")
                || lower_name.contains(".net framework")
                || lower_name.contains("microsoft visual")
                || lower_name.starts_with("kb")
            {
                continue;
            }

            let install_location: String = app_key.get_value("InstallLocation").unwrap_or_default();

            // Dedup by DisplayName + InstallLocation
            let dedup_key = format!("{}|{}", lower_name, install_location.to_lowercase());
            if seen.contains(&dedup_key) {
                continue;
            }
            seen.insert(dedup_key);

            let version: String = app_key.get_value("DisplayVersion").unwrap_or_default();
            let uninstall_string: String = app_key.get_value("UninstallString").unwrap_or_default();
            let publisher: String = app_key.get_value("Publisher").unwrap_or_default();
            let display_icon: String = app_key.get_value("DisplayIcon").unwrap_or_default();
            let estimated_size: u32 = app_key.get_value("EstimatedSize").unwrap_or(0);

            // Parse icon path: remove ",0" suffix
            let icon_path = parse_icon_path(&display_icon);

            // app_path: prefer InstallLocation, fallback to parsing UninstallString
            let app_path = if !install_location.is_empty() {
                install_location.clone()
            } else {
                extract_exe_from_uninstall_string(&uninstall_string)
            };

            apps.push(InstalledApp {
                name: display_name,
                bundle_id: String::new(),
                version,
                app_path,
                icon_path,
                app_size: estimated_size as u64 * 1024, // KB -> bytes
                uninstall_string: if uninstall_string.is_empty() {
                    None
                } else {
                    Some(uninstall_string)
                },
                install_location: if install_location.is_empty() {
                    None
                } else {
                    Some(install_location)
                },
                publisher: if publisher.is_empty() {
                    None
                } else {
                    Some(publisher)
                },
                package_manager: None,
                package_name: None,
                risk_level: RiskLevel::Safe,
            });
        }
    }

    apps.sort_by_key(|a| a.name.to_lowercase());
    apps
}

#[cfg(target_os = "windows")]
fn parse_icon_path(raw: &str) -> Option<String> {
    if raw.is_empty() {
        return None;
    }
    // Remove ",N" suffix (e.g. "C:\app\icon.exe,0")
    let path = if let Some(idx) = raw.rfind(',') {
        let suffix = &raw[idx + 1..];
        if suffix.chars().all(|c| c.is_ascii_digit()) {
            &raw[..idx]
        } else {
            raw
        }
    } else {
        raw
    };
    let path = path.trim_matches('"');
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

#[cfg(target_os = "windows")]
fn extract_exe_from_uninstall_string(uninstall_str: &str) -> String {
    if uninstall_str.is_empty() {
        return String::new();
    }
    let s = uninstall_str.trim();
    if s.starts_with('"') {
        // Quoted path: "C:\path\uninstall.exe" /args
        if let Some(end) = s[1..].find('"') {
            return s[1..end + 1].to_string();
        }
    }
    // Unquoted: take first token ending in .exe
    for token in s.split_whitespace() {
        if token.to_lowercase().ends_with(".exe") {
            return token.to_string();
        }
    }
    // Fallback: first token
    s.split_whitespace().next().unwrap_or("").to_string()
}

#[cfg(target_os = "windows")]
fn build_windows_residual_paths(
    app: &InstalledApp,
) -> std::collections::HashMap<AppFileCategory, Vec<PathBuf>> {
    let mut category_paths: std::collections::HashMap<AppFileCategory, Vec<PathBuf>> =
        std::collections::HashMap::new();
    let keywords = WindowsProvider::search_keywords(&app.name, &app.publisher);

    let mut add = |cat: AppFileCategory, p: PathBuf| {
        category_paths.entry(cat).or_default().push(p);
    };

    // InstallLocation residual
    if let Some(ref loc) = app.install_location {
        let p = PathBuf::from(loc);
        if p.exists() {
            add(AppFileCategory::ApplicationSupport, p);
        }
    }

    // AppData\Roaming
    if let Some(appdata) = WindowsProvider::env_var("APPDATA") {
        for kw in &keywords {
            let p = PathBuf::from(&appdata).join(kw);
            if p.exists() {
                add(AppFileCategory::UserData, p);
            }
        }
        // Also scan Start Menu shortcuts
        let start_menu = PathBuf::from(&appdata).join(r"Microsoft\Windows\Start Menu\Programs");
        for kw in &keywords {
            let p = start_menu.join(kw);
            if p.exists() {
                add(AppFileCategory::StartMenu, p);
            }
        }
    }

    // AppData\Local
    if let Some(local) = WindowsProvider::env_var("LOCALAPPDATA") {
        for kw in &keywords {
            let p = PathBuf::from(&local).join(kw);
            if p.exists() {
                add(AppFileCategory::LocalAppData, p);
            }
        }
    }

    // ProgramData
    if let Some(progdata) = WindowsProvider::env_var("PROGRAMDATA") {
        for kw in &keywords {
            let p = PathBuf::from(&progdata).join(kw);
            if p.exists() {
                add(AppFileCategory::ProgramData, p);
            }
        }
    }

    // Desktop shortcuts
    let desktop = WindowsProvider::home_dir().join("Desktop");
    for kw in &keywords {
        let lnk = desktop.join(format!("{}.lnk", kw));
        if lnk.exists() {
            add(AppFileCategory::Desktop, lnk);
        }
    }

    category_paths
}

#[cfg(target_os = "windows")]
fn scan_registry_residuals(app: &InstalledApp) -> Vec<crate::core::uninstall::AppFileEntry> {
    let keywords = WindowsProvider::search_keywords(&app.name, &app.publisher);
    let mut entries = Vec::new();

    let search_roots: Vec<(winreg::HKEY, &str, &str)> = vec![
        (HKEY_CURRENT_USER, "SOFTWARE", "HKCU\\SOFTWARE"),
        (HKEY_LOCAL_MACHINE, "SOFTWARE", "HKLM\\SOFTWARE"),
    ];

    for (hkey, subkey, prefix) in &search_roots {
        let root = match RegKey::predef(*hkey).open_subkey(subkey) {
            Ok(k) => k,
            Err(_) => continue,
        };

        for key_name in root.enum_keys().flatten() {
            let lower_key = key_name.to_lowercase();
            let matched = keywords.iter().any(|kw| lower_key.contains(kw));
            if matched {
                // Estimate registry key size (rough approximation)
                let est_size = estimate_registry_key_size(&root, &key_name);
                entries.push(crate::core::uninstall::AppFileEntry {
                    path: format!("{}\\{}", prefix, key_name),
                    size: est_size,
                    is_dir: false,
                });
            }
        }
    }

    entries
}

#[cfg(target_os = "windows")]
fn estimate_registry_key_size(parent: &RegKey, subkey_name: &str) -> u64 {
    let mut total: u64 = 0;
    if let Ok(key) = parent.open_subkey(subkey_name) {
        for (name, _value) in key.enum_values().flatten() {
            total += name.len() as u64 + 64;
        }
        let mut sub_count: u32 = 0;
        for sub_name in key.enum_keys().flatten() {
            if sub_count >= 10 {
                break;
            }
            total += estimate_registry_key_size_limited(&key, &sub_name, 2);
            sub_count += 1;
        }
    }
    total
}

#[cfg(target_os = "windows")]
fn estimate_registry_key_size_limited(parent: &RegKey, subkey_name: &str, max_depth: u32) -> u64 {
    if max_depth == 0 {
        return 0;
    }
    let mut total: u64 = 0;
    if let Ok(key) = parent.open_subkey(subkey_name) {
        if let Ok(info) = key.query_info() {
            total += info.values as u64 * 64;
        }
        let mut sub_count: u32 = 0;
        for sub_name in key.enum_keys().flatten() {
            if sub_count >= 5 {
                break;
            }
            total += estimate_registry_key_size_limited(&key, &sub_name, max_depth - 1);
            sub_count += 1;
        }
    }
    total
}

#[cfg(target_os = "windows")]
fn parse_and_execute_uninstall(uninstall_str: &str) -> Result<i32, PlatformError> {
    let s = uninstall_str.trim();

    // Determine executable and base arguments
    let (exe, base_args) = if s.starts_with('"') {
        if let Some(end) = s[1..].find('"') {
            let exe = &s[1..end + 1];
            let rest = s[end + 2..].trim();
            (
                exe.to_string(),
                if rest.is_empty() {
                    Vec::new()
                } else {
                    vec![rest.to_string()]
                },
            )
        } else {
            (s[1..].to_string(), Vec::new())
        }
    } else {
        let parts: Vec<&str> = s.splitn(2, ' ').collect();
        let exe = parts[0].to_string();
        let args = if parts.len() > 1 {
            vec![parts[1].to_string()]
        } else {
            Vec::new()
        };
        (exe, args)
    };

    let lower_exe = exe.to_lowercase();

    // Determine silent flags based on installer type
    let mut args = base_args;
    if lower_exe.contains("msiexec") {
        // MSI: convert /I{GUID} to /x {GUID} /qn /norestart
        let mut new_args = Vec::new();
        for arg in &args {
            if arg.starts_with("/I") || arg.starts_with("/i") {
                new_args.push("/x".to_string());
                new_args.push(arg[2..].to_string());
            } else {
                new_args.push(arg.clone());
            }
        }
        new_args.push("/qn".to_string());
        new_args.push("/norestart".to_string());
        args = new_args;
    } else if lower_exe.contains("unins") {
        // InnoSetup
        args.push("/VERYSILENT".to_string());
        args.push("/NORESTART".to_string());
    } else {
        // NSIS / generic: try /S
        args.push("/S".to_string());
    }

    let output = std::process::Command::new(&exe)
        .args(&args)
        .output()
        .map_err(|e| PlatformError {
            message: format!("Failed to execute uninstaller '{}': {}", exe, e),
            path: Some(PathBuf::from(&exe)),
        })?;

    Ok(output.status.code().unwrap_or(-1))
}

// ---------------------------------------------------------------------------
// PlatformProvider implementation
// ---------------------------------------------------------------------------

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
        #[cfg(target_os = "windows")]
        {
            read_registry_apps()
        }
        #[cfg(not(target_os = "windows"))]
        {
            Vec::new()
        }
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

        #[cfg(target_os = "windows")]
        {
            let start = Instant::now();
            let category_paths = build_windows_residual_paths(app);

            // Add registry residuals as a special group
            let registry_entries = scan_registry_residuals(app);
            if !registry_entries.is_empty() {
                let total_size: u64 = registry_entries.iter().map(|e| e.size).sum();
                let file_count = registry_entries.len() as u64;

                let _ = event_bus.emit(UninstallEvent::CategoryDiscovered {
                    op_id: op_id.to_string(),
                    category: AppFileCategory::Registry.display_name().to_string(),
                    file_count,
                    total_size,
                    risk_hint: AppFileCategory::Registry.risk_hint().to_string(),
                });

                // We'll add registry as a separate group after scan_paths_to_groups
                let mut groups = scan_paths_to_groups(category_paths, event_bus, op_id, start);

                groups.push(AppFileGroup {
                    category: AppFileCategory::Registry,
                    category_name: AppFileCategory::Registry.display_name().to_string(),
                    risk_hint: AppFileCategory::Registry.risk_hint().to_string(),
                    risk_level: AppFileCategory::Registry.risk_level(),
                    files: registry_entries,
                    total_size,
                    file_count,
                });

                return groups;
            }

            scan_paths_to_groups(category_paths, event_bus, op_id, start)
        }

        #[cfg(not(target_os = "windows"))]
        {
            Vec::new()
        }
    }

    fn uninstall_app_native(&self, _app: &InstalledApp) -> Result<(), PlatformError> {
        #[cfg(target_os = "windows")]
        {
            let app = _app;
            let uninstall_str = app.uninstall_string.as_deref().ok_or(PlatformError {
                message: "No uninstall string available".into(),
                path: None,
            })?;
            let exit_code = parse_and_execute_uninstall(uninstall_str)?;
            if exit_code == 0 || exit_code == 3010
            /* reboot required */
            {
                Ok(())
            } else {
                Err(PlatformError {
                    message: format!("Uninstaller exited with code {}", exit_code),
                    path: None,
                })
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            Err(PlatformError {
                message: "Windows uninstall not available on this platform".into(),
                path: None,
            })
        }
    }

    fn supports_official_uninstall(&self, app: &InstalledApp) -> bool {
        app.uninstall_string.is_some()
    }
}
