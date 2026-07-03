//! Cross-platform startup item manager.
//!
//! Scans, enables/disables, and removes programs that launch at system startup.

use serde::{Deserialize, Serialize};

/// A single startup item discovered on the system.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct StartupItem {
    /// Display name of the startup item.
    pub name: String,
    /// The command or executable path launched at startup.
    pub command: String,
    /// Source path (plist file, registry key, desktop file, etc.).
    pub source: String,
    /// Platform identifier: "macos" | "windows" | "linux".
    pub platform: String,
    /// Whether this item is currently enabled.
    pub enabled: bool,
    /// Type of startup entry.
    /// "launch_agent" | "launch_daemon" | "login_item" |
    /// "registry_run" | "desktop_file" | "systemd_user"
    pub item_type: String,
    /// Scope: "user" | "system".
    pub user_level: String,
}

// ---------------------------------------------------------------------------
// macOS implementation
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    /// Return all startup items on macOS.
    pub fn list_startup_items() -> Vec<StartupItem> {
        let mut items = Vec::new();

        // User-level LaunchAgents
        if let Some(home) = dirs::home_dir() {
            let user_agents = home.join("Library/LaunchAgents");
            scan_plist_dir(&user_agents, "launch_agent", "user", &mut items);
        }

        // System-level LaunchAgents
        scan_plist_dir(
            Path::new("/Library/LaunchAgents"),
            "launch_agent",
            "system",
            &mut items,
        );

        // System-level LaunchDaemons
        scan_plist_dir(
            Path::new("/Library/LaunchDaemons"),
            "launch_daemon",
            "system",
            &mut items,
        );

        // Login Items via osascript
        collect_login_items(&mut items);

        items
    }

    /// Toggle a startup item's enabled state.
    pub fn toggle_startup_item(source: &str, enabled: bool) -> Result<(), String> {
        // login_item type cannot be managed via launchctl; redirect to System Settings
        if source.starts_with("login_item") {
            let _ = Command::new("open")
                .arg("x-apple.systempreferences:com.apple.Users-Groups-Settings.extension")
                .status();
            return Err("Login Items must be managed in System Settings".into());
        }
        let path = Path::new(source);
        if !path.exists() {
            return Err(format!("Source file not found: {}", source));
        }
        if enabled {
            // load via launchctl
            let status = Command::new("launchctl")
                .arg("load")
                .arg("-w")
                .arg(source)
                .status()
                .map_err(|e| format!("Failed to run launchctl load: {}", e))?;
            if !status.success() {
                return Err("launchctl load failed".into());
            }
        } else {
            // unload via launchctl
            let status = Command::new("launchctl")
                .arg("unload")
                .arg("-w")
                .arg(source)
                .status()
                .map_err(|e| format!("Failed to run launchctl unload: {}", e))?;
            if !status.success() {
                return Err("launchctl unload failed".into());
            }
        }
        Ok(())
    }

    /// Remove a startup item by deleting its source plist.
    pub fn remove_startup_item(source: &str) -> Result<(), String> {
        // login_item type cannot be managed via launchctl; redirect to System Settings
        if source.starts_with("login_item") {
            let _ = std::process::Command::new("open")
                .arg("x-apple.systempreferences:com.apple.Users-Groups-Settings.extension")
                .status();
            return Err("Login Items must be managed in System Settings".into());
        }
        // Try to unload first (ignore errors)
        let _ = Command::new("launchctl")
            .arg("unload")
            .arg("-w")
            .arg(source)
            .status();
        std::fs::remove_file(source).map_err(|e| format!("Failed to remove {}: {}", source, e))
    }

    // -----------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------

    fn scan_plist_dir(dir: &Path, item_type: &str, user_level: &str, out: &mut Vec<StartupItem>) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("plist") {
                continue;
            }
            if let Some(item) = parse_launchd_plist(&path, item_type, user_level) {
                out.push(item);
            }
        }
    }

    fn parse_launchd_plist(path: &Path, item_type: &str, user_level: &str) -> Option<StartupItem> {
        let dict: plist::Dictionary = plist::from_file(path).ok()?;

        let label = dict
            .get("Label")
            .and_then(|v| v.as_string())
            .unwrap_or_else(|| {
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("unknown")
            })
            .to_string();

        let name = label.rsplit('.').next().unwrap_or(&label).to_string();

        // Build command from ProgramArguments or Program
        let command = if let Some(args) = dict.get("ProgramArguments").and_then(|v| v.as_array()) {
            args.iter()
                .filter_map(|v| v.as_string())
                .collect::<Vec<_>>()
                .join(" ")
        } else if let Some(prog) = dict.get("Program").and_then(|v| v.as_string()) {
            prog.to_string()
        } else {
            String::new()
        };

        // Determine enabled state: RunAtLoad or KeepAlive
        let run_at_load = dict
            .get("RunAtLoad")
            .and_then(|v| v.as_boolean())
            .unwrap_or(false);
        let keep_alive = dict
            .get("KeepAlive")
            .and_then(|v| match v {
                plist::Value::Boolean(b) => Some(*b),
                plist::Value::Dictionary(d) => {
                    // KeepAlive can be a dict with SuccessfulExit etc.
                    Some(!d.is_empty())
                }
                _ => None,
            })
            .unwrap_or(false);

        // Disabled key explicitly set?
        let disabled = dict
            .get("Disabled")
            .and_then(|v| v.as_boolean())
            .unwrap_or(false);

        let enabled = (run_at_load || keep_alive) && !disabled;

        Some(StartupItem {
            name,
            command,
            source: path.to_string_lossy().into_owned(),
            platform: "macos".into(),
            enabled,
            item_type: item_type.into(),
            user_level: user_level.into(),
        })
    }

    /// Collect Login Items via osascript (best-effort).
    fn collect_login_items(out: &mut Vec<StartupItem>) {
        let script = r#"
            tell application "System Events"
                get the name of every login item
            end tell
        "#;
        let output = match Command::new("osascript").arg("-e").arg(script).output() {
            Ok(o) => o,
            Err(_) => return,
        };
        if !output.status.success() {
            return;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        for name in stdout
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            // Avoid duplicates (launch agents may cover the same app)
            if out.iter().any(|i| i.name.eq_ignore_ascii_case(name)) {
                continue;
            }
            out.push(StartupItem {
                name: name.to_string(),
                command: String::new(),
                source: format!("login_item://{}", name),
                platform: "macos".into(),
                enabled: true,
                item_type: "login_item".into(),
                user_level: "user".into(),
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Windows implementation
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use winreg::enums::*;
    use winreg::RegKey;

    pub fn list_startup_items() -> Vec<StartupItem> {
        let mut items = Vec::new();

        // HKCU Run
        scan_registry_key(
            HKEY_CURRENT_USER,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
            "registry_run",
            "user",
            &mut items,
        );
        // HKCU RunOnce
        scan_registry_key(
            HKEY_CURRENT_USER,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce",
            "registry_run",
            "user",
            &mut items,
        );
        // HKLM Run
        scan_registry_key(
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
            "registry_run",
            "system",
            &mut items,
        );
        // HKLM RunOnce
        scan_registry_key(
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce",
            "registry_run",
            "system",
            &mut items,
        );
        // HKLM WoW6432Node Run (32-bit apps on 64-bit Windows)
        scan_registry_key(
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Wow6432Node\Microsoft\Windows\CurrentVersion\Run",
            "registry_run",
            "system",
            &mut items,
        );
        // HKLM WoW6432Node RunOnce (32-bit apps on 64-bit Windows)
        scan_registry_key(
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Wow6432Node\Microsoft\Windows\CurrentVersion\RunOnce",
            "registry_run",
            "system",
            &mut items,
        );

        // Startup folders
        items.extend(scan_startup_folders());

        items
    }

    pub fn toggle_startup_item(source: &str, enabled: bool) -> Result<(), String> {
        // `source` is "hive\\subkey\\value_name"
        let parts: Vec<&str> = source.splitn(3, '\\').collect();
        if parts.len() < 3 {
            return Err("Invalid source format".into());
        }
        let hive = match parts[0] {
            "HKCU" => HKEY_CURRENT_USER,
            "HKLM" => HKEY_LOCAL_MACHINE,
            other => return Err(format!("Unknown registry hive: {}", other)),
        };
        // We stored a backup value with suffix ".xclearp_disabled"
        let key = RegKey::predef(hive)
            .open_subkey_with_flags(parts[1], KEY_READ | KEY_WRITE)
            .map_err(|e| format!("Failed to open registry key: {}", e))?;
        let disabled_name = format!("{}.xclearp_disabled", parts[2]);
        if enabled {
            // Restore from backup
            if let Ok(val) = key.get_value::<String, _>(&disabled_name) {
                key.set_value(parts[2], &val)
                    .map_err(|e| format!("Failed to restore value: {}", e))?;
                let _ = key.delete_value(&disabled_name);
            }
        } else {
            // Backup current value then delete
            if let Ok(val) = key.get_value::<String, _>(parts[2]) {
                key.set_value(&disabled_name, &val)
                    .map_err(|e| format!("Failed to backup value: {}", e))?;
                key.delete_value(parts[2])
                    .map_err(|e| format!("Failed to delete value: {}", e))?;
            }
        }
        Ok(())
    }

    pub fn remove_startup_item(source: &str) -> Result<(), String> {
        let parts: Vec<&str> = source.splitn(3, '\\').collect();
        if parts.len() < 3 {
            return Err("Invalid source format".into());
        }
        let hive = match parts[0] {
            "HKCU" => HKEY_CURRENT_USER,
            "HKLM" => HKEY_LOCAL_MACHINE,
            other => return Err(format!("Unknown registry hive: {}", other)),
        };
        let key = RegKey::predef(hive)
            .open_subkey_with_flags(parts[1], KEY_WRITE)
            .map_err(|e| format!("Failed to open registry key: {}", e))?;
        key.delete_value(parts[2])
            .map_err(|e| format!("Failed to delete registry value: {}", e))?;
        // Clean up backup if exists
        let disabled_name = format!("{}.xclearp_disabled", parts[2]);
        let _ = key.delete_value(&disabled_name);
        Ok(())
    }

    fn scan_startup_folders() -> Vec<StartupItem> {
        let mut items = Vec::new();

        // User startup folder: %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
        if let Some(appdata) = std::env::var_os("APPDATA") {
            let user_startup = std::path::PathBuf::from(&appdata)
                .join(r"Microsoft\Windows\Start Menu\Programs\Startup");
            scan_startup_dir(&user_startup, "startup_folder", "user", &mut items);
        }

        // System startup folder: %ProgramData%\Microsoft\Windows\Start Menu\Programs\Startup
        if let Some(programdata) = std::env::var_os("PROGRAMDATA") {
            let system_startup = std::path::PathBuf::from(&programdata)
                .join(r"Microsoft\Windows\Start Menu\Programs\Startup");
            scan_startup_dir(&system_startup, "startup_folder", "system", &mut items);
        }

        items
    }

    fn scan_startup_dir(
        dir: &std::path::Path,
        item_type: &str,
        user_level: &str,
        items: &mut Vec<StartupItem>,
    ) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else {
                continue;
            };

            items.push(StartupItem {
                name,
                command: path.to_string_lossy().into_owned(),
                source: path.to_string_lossy().into_owned(),
                platform: "windows".into(),
                enabled: true,
                item_type: item_type.to_string(),
                user_level: user_level.to_string(),
            });
        }
    }

    fn scan_registry_key(
        hive: HKEY,
        subkey: &str,
        item_type: &str,
        user_level: &str,
        out: &mut Vec<StartupItem>,
    ) {
        let hive_name = if hive == HKEY_CURRENT_USER {
            "HKCU"
        } else {
            "HKLM"
        };
        let key = match RegKey::predef(hive).open_subkey(subkey) {
            Ok(k) => k,
            Err(_) => return,
        };
        for (name, value) in key.enum_values().flatten() {
            // Skip our own backup entries
            if name.ends_with(".xclearp_disabled") {
                continue;
            }
            let command = value.to_string();
            let source = format!("{}\\{}\\{}", hive_name, subkey, name);

            // Check if disabled backup exists
            let disabled_name = format!("{}.xclearp_disabled", name);
            let enabled = key.get_value::<String, _>(&disabled_name).is_err();

            out.push(StartupItem {
                name: name.clone(),
                command,
                source,
                platform: "windows".into(),
                enabled,
                item_type: item_type.into(),
                user_level: user_level.into(),
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Linux implementation
// ---------------------------------------------------------------------------

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    pub fn list_startup_items() -> Vec<StartupItem> {
        let mut items = Vec::new();

        // ~/.config/autostart/*.desktop
        if let Some(home) = dirs::home_dir() {
            let autostart = home.join(".config/autostart");
            scan_desktop_files(&autostart, &mut items);
        }

        // ~/.config/systemd/user/*.service
        if let Some(home) = dirs::home_dir() {
            let systemd_dir = home.join(".config/systemd/user");
            scan_systemd_user_units(&systemd_dir, &mut items);
        }

        items
    }

    pub fn toggle_startup_item(source: &str, enabled: bool) -> Result<(), String> {
        if source.ends_with(".service") {
            // systemd user unit
            let unit_name = Path::new(source)
                .file_name()
                .and_then(|f| f.to_str())
                .unwrap_or(source);
            if enabled {
                let status = Command::new("systemctl")
                    .args(["--user", "enable", "--now", unit_name])
                    .status()
                    .map_err(|e| format!("systemctl enable failed: {}", e))?;
                if !status.success() {
                    return Err("systemctl enable failed".into());
                }
            } else {
                let status = Command::new("systemctl")
                    .args(["--user", "disable", "--now", unit_name])
                    .status()
                    .map_err(|e| format!("systemctl disable failed: {}", e))?;
                if !status.success() {
                    return Err("systemctl disable failed".into());
                }
            }
        } else if source.ends_with(".desktop") {
            // desktop file: toggle Hidden=true/false
            let content = std::fs::read_to_string(source)
                .map_err(|e| format!("Failed to read {}: {}", source, e))?;
            let new_content = if enabled {
                // Remove Hidden=true
                content
                    .lines()
                    .filter(|l| !l.starts_with("Hidden=true"))
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                // Add Hidden=true to [Desktop Entry] section
                let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
                if let Some(pos) = lines.iter().position(|l| l.trim() == "[Desktop Entry]") {
                    lines.insert(pos + 1, "Hidden=true".to_string());
                } else {
                    lines.push("[Desktop Entry]".to_string());
                    lines.push("Hidden=true".to_string());
                }
                lines.join("\n")
            };
            std::fs::write(source, new_content)
                .map_err(|e| format!("Failed to write {}: {}", source, e))?;
        } else {
            return Err(format!("Unsupported source type: {}", source));
        }
        Ok(())
    }

    pub fn remove_startup_item(source: &str) -> Result<(), String> {
        if source.ends_with(".service") {
            let unit_name = Path::new(source)
                .file_name()
                .and_then(|f| f.to_str())
                .unwrap_or(source);
            let _ = Command::new("systemctl")
                .args(["--user", "disable", "--now", unit_name])
                .status();
        }
        std::fs::remove_file(source).map_err(|e| format!("Failed to remove {}: {}", source, e))
    }

    fn scan_desktop_files(dir: &Path, out: &mut Vec<StartupItem>) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
                continue;
            }
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let name = extract_desktop_key(&content, "Name").unwrap_or_else(|| {
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("unknown")
                    .to_string()
            });
            let exec = extract_desktop_key(&content, "Exec").unwrap_or_default();
            let hidden = content.lines().any(|l| l.trim() == "Hidden=true");

            out.push(StartupItem {
                name,
                command: exec,
                source: path.to_string_lossy().into_owned(),
                platform: "linux".into(),
                enabled: !hidden,
                item_type: "desktop_file".into(),
                user_level: "user".into(),
            });
        }
    }

    fn scan_systemd_user_units(dir: &Path, out: &mut Vec<StartupItem>) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("service") {
                continue;
            }
            let unit_name = match path.file_name().and_then(|f| f.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            let enabled = Command::new("systemctl")
                .args(["--user", "is-enabled", &unit_name])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "enabled")
                .unwrap_or(false);
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            let exec = content
                .lines()
                .find(|l| l.starts_with("ExecStart="))
                .map(|l| l.trim_start_matches("ExecStart=").to_string())
                .unwrap_or_default();
            let desc = content
                .lines()
                .find(|l| l.starts_with("Description="))
                .map(|l| l.trim_start_matches("Description=").to_string())
                .unwrap_or_else(|| unit_name.clone());

            out.push(StartupItem {
                name: desc,
                command: exec,
                source: path.to_string_lossy().into_owned(),
                platform: "linux".into(),
                enabled,
                item_type: "systemd_user".into(),
                user_level: "user".into(),
            });
        }
    }

    fn extract_desktop_key(content: &str, key: &str) -> Option<String> {
        let prefix = format!("{}=", key);
        content
            .lines()
            .find(|l| l.starts_with(&prefix))
            .map(|l| l[prefix.len()..].to_string())
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// List all startup items on the current platform.
pub fn list_startup_items() -> Vec<StartupItem> {
    imp::list_startup_items()
}

/// Enable or disable a startup item identified by its source path/key.
pub fn toggle_startup_item(source: &str, enabled: bool) -> Result<(), String> {
    imp::toggle_startup_item(source, enabled)
}

/// Remove a startup item identified by its source path/key.
pub fn remove_startup_item(source: &str) -> Result<(), String> {
    imp::remove_startup_item(source)
}
