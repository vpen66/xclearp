use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::platform::PlatformProvider;

/// A group of orphan files that appear to belong to the same (uninstalled) application.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrphanGroup {
    /// Inferred application name (from directory name).
    pub app_name: String,
    /// Path to the residual directory.
    pub base_path: PathBuf,
    /// Total size in bytes.
    pub total_size: u64,
    /// Number of files (not directories).
    pub file_count: u32,
    /// Category of the residual location.
    pub category: String,
    /// Last modification timestamp (unix seconds).
    pub last_modified: Option<u64>,
    /// Sub-paths within the residual directory.
    pub paths: Vec<PathBuf>,
    /// Whether size has been fully calculated (false = quick scan, true = full stats).
    #[serde(default)]
    pub size_calculated: bool,
}

/// Result of deleting orphan files.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrphanDeleteResult {
    pub deleted_count: u32,
    pub failed_count: u32,
    pub freed_bytes: u64,
    pub errors: Vec<String>,
}

/// Quick scan: identify orphan directories without walking their contents.
/// Returns orphans with total_size=0 and file_count=0 for directories,
/// but accurate metadata for single files. This is very fast.
pub fn quick_scan_orphan_files(
    platform: &Arc<dyn PlatformProvider + Send + Sync>,
) -> Vec<OrphanGroup> {
    let installed_apps = platform.list_installed_apps();
    let app_keywords = build_app_keywords(&installed_apps);
    let scan_dirs = get_orphan_scan_dirs();

    let mut orphans: Vec<OrphanGroup> = Vec::new();

    for (base_dir, category, skip_prefixes) in &scan_dirs {
        if !base_dir.exists() {
            continue;
        }
        let entries = match std::fs::read_dir(base_dir) {
            Ok(e) => e,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            let name = match entry.file_name().to_str() {
                Some(n) => n.to_string(),
                None => continue,
            };

            if skip_prefixes.iter().any(|p| name.starts_with(p)) {
                continue;
            }

            if *category == "preferences" && !name.ends_with(".plist") {
                continue;
            }

            let check_name = if *category == "preferences" {
                name.strip_suffix(".plist").unwrap_or(&name).to_string()
            } else if *category == "saved_state" {
                name.strip_suffix(".savedState")
                    .unwrap_or(&name)
                    .to_string()
            } else {
                name.clone()
            };

            if is_orphan(&check_name, &app_keywords) {
                // Quick metadata only — no directory walking
                let (quick_size, quick_count, quick_modified, size_calculated) =
                    quick_metadata(&path);

                let display_name = if *category == "preferences" {
                    extract_app_hint(&check_name)
                } else {
                    name.clone()
                };

                orphans.push(OrphanGroup {
                    app_name: display_name,
                    base_path: path.clone(),
                    total_size: quick_size,
                    file_count: quick_count,
                    category: category.to_string(),
                    last_modified: quick_modified,
                    paths: vec![path],
                    size_calculated,
                });
            }
        }
    }

    // Sort by name for quick scan (sizes not yet known)
    orphans.sort_by_key(|a| a.app_name.to_lowercase());
    orphans
}

/// Calculate full stats (size, file_count, last_modified) for the given orphan paths.
/// Uses multiple threads to parallelise directory walking.
pub fn calculate_orphan_group_stats(paths: Vec<String>) -> Vec<OrphanGroup> {
    use std::sync::Mutex;

    let results: Arc<Mutex<Vec<OrphanGroup>>> = Arc::new(Mutex::new(Vec::new()));
    let mut handles = Vec::new();

    for path_str in paths {
        let path = PathBuf::from(&path_str);
        let results = Arc::clone(&results);
        let handle = std::thread::spawn(move || {
            if !path.exists() {
                return;
            }
            let (total_size, file_count, last_modified) = calculate_dir_stats(&path);
            if file_count == 0 && total_size == 0 {
                return;
            }
            let group = OrphanGroup {
                app_name: String::new(), // caller will merge by base_path
                base_path: path,
                total_size,
                file_count,
                category: String::new(),
                last_modified,
                paths: vec![],
                size_calculated: true,
            };
            results.lock().unwrap().push(group);
        });
        handles.push(handle);
    }

    for h in handles {
        let _ = h.join();
    }

    Arc::try_unwrap(results).unwrap().into_inner().unwrap()
}

/// Scan for orphan files across all platform-specific directories (full scan with sizes).
///
/// An "orphan" is a directory or file inside a well-known application data location
/// whose name does not match any currently installed application.
pub fn scan_orphan_files(platform: &Arc<dyn PlatformProvider + Send + Sync>) -> Vec<OrphanGroup> {
    let mut orphans = quick_scan_orphan_files(platform);

    // Calculate sizes for directories that need it
    let paths_needing_size: Vec<String> = orphans
        .iter()
        .filter(|o| !o.size_calculated)
        .map(|o| o.base_path.to_string_lossy().to_string())
        .collect();

    if !paths_needing_size.is_empty() {
        let stats = calculate_orphan_group_stats(paths_needing_size);
        for stat in &stats {
            if let Some(orphan) = orphans.iter_mut().find(|o| o.base_path == stat.base_path) {
                orphan.total_size = stat.total_size;
                orphan.file_count = stat.file_count;
                orphan.last_modified = stat.last_modified;
                orphan.size_calculated = true;
            }
        }
        // Remove entries that turned out to be empty
        orphans.retain(|o| o.file_count > 0 || o.total_size > 0);
    }

    // Sort by size descending
    orphans.sort_by_key(|b| std::cmp::Reverse(b.total_size));
    orphans
}

/// Delete the specified orphan paths.
pub fn delete_orphan_files(
    platform: &Arc<dyn PlatformProvider + Send + Sync>,
    paths: Vec<String>,
    safe_mode: bool,
) -> OrphanDeleteResult {
    let mut deleted_count = 0u32;
    let mut failed_count = 0u32;
    let mut freed_bytes = 0u64;
    let mut errors: Vec<String> = Vec::new();

    for path_str in &paths {
        let path = PathBuf::from(path_str);
        if !path.exists() {
            continue;
        }

        let size = if path.is_dir() {
            calculate_dir_size_only(&path)
        } else {
            std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
        };

        let result = if safe_mode {
            platform.move_to_trash(&path)
        } else {
            platform.safe_remove(&path)
        };

        match result {
            Ok(()) => {
                deleted_count += 1;
                freed_bytes += size;
            }
            Err(e) => {
                failed_count += 1;
                errors.push(format!("{}: {}", path_str, e));
            }
        }
    }

    OrphanDeleteResult {
        deleted_count,
        failed_count,
        freed_bytes,
        errors,
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Build a set of lowercase keywords from installed apps for matching.
fn build_app_keywords(apps: &[crate::core::uninstall::InstalledApp]) -> Vec<String> {
    let mut keywords = Vec::new();
    for app in apps {
        let name_lower = app.name.to_lowercase().replace(' ', "");
        if !name_lower.is_empty() {
            keywords.push(name_lower.clone());
        }
        // Also add individual words from the app name
        for word in app.name.split_whitespace() {
            let w = word.to_lowercase();
            if w.len() >= 3 {
                keywords.push(w);
            }
        }
        // Add bundle_id components
        if !app.bundle_id.is_empty() {
            keywords.push(app.bundle_id.to_lowercase());
            // Last component of bundle id
            if let Some(last) = app.bundle_id.rsplit('.').next() {
                let last_lower = last.to_lowercase();
                if last_lower.len() >= 3 {
                    keywords.push(last_lower);
                }
            }
        }
    }
    keywords
}

/// Check whether a directory/file name is an orphan (not matching any installed app).
fn is_orphan(name: &str, app_keywords: &[String]) -> bool {
    let name_lower = name.to_lowercase().replace(' ', "");

    // Skip very short names or hidden files
    if name_lower.len() < 2 || name_lower.starts_with('.') {
        return false;
    }

    // Check if any keyword is contained in the name or vice versa
    for kw in app_keywords {
        if kw.is_empty() {
            continue;
        }
        if name_lower.contains(kw) || kw.contains(&name_lower) {
            return false;
        }
    }

    true
}

/// Extract a human-readable hint from a plist-style name (e.g. "com.company.AppName" -> "AppName").
fn extract_app_hint(name: &str) -> String {
    if let Some(last) = name.rsplit('.').next() {
        if !last.is_empty() {
            return last.to_string();
        }
    }
    name.to_string()
}

/// Get platform-specific directories to scan for orphans.
/// Returns (base_dir, category, prefixes_to_skip).
fn get_orphan_scan_dirs() -> Vec<(PathBuf, &'static str, Vec<&'static str>)> {
    let mut dirs = Vec::new();

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            let lib = home.join("Library");
            dirs.push((
                lib.join("Caches"),
                "cache",
                vec!["com.apple.", "CloudKit", "com.apple."],
            ));
            dirs.push((
                lib.join("Application Support"),
                "app_support",
                vec![
                    "com.apple.",
                    "Apple",
                    "iCloud",
                    "AddressBook",
                    "CallHistory",
                ],
            ));
            dirs.push((
                lib.join("Preferences"),
                "preferences",
                vec!["com.apple.", "loginwindow", "NSGlobalDomain"],
            ));
            dirs.push((lib.join("Logs"), "logs", vec!["com.apple."]));
            dirs.push((
                lib.join("Saved Application State"),
                "saved_state",
                vec!["com.apple."],
            ));
            dirs.push((lib.join("Containers"), "containers", vec!["com.apple."]));
            dirs.push((
                lib.join("HTTPStorages"),
                "http_storages",
                vec!["com.apple."],
            ));
            dirs.push((lib.join("WebKit"), "webkit", vec!["com.apple."]));
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(appdata) = dirs::data_dir() {
            dirs.push((
                appdata.clone(),
                "app_data",
                vec![
                    "Microsoft",
                    "Windows",
                    "Packages",
                    "Temp",
                    "Comms",
                    "ConnectedDevicesPlatform",
                    "Publishers",
                ],
            ));
        }
        if let Some(local) = dirs::cache_dir() {
            dirs.push((
                local.clone(),
                "local_app_data",
                vec![
                    "Microsoft",
                    "Windows",
                    "Packages",
                    "Temp",
                    "Comms",
                    "ConnectedDevicesPlatform",
                    "Publishers",
                ],
            ));
        }
        if let Some(program_data) = std::env::var_os("PROGRAMDATA") {
            dirs.push((
                PathBuf::from(program_data),
                "program_data",
                vec![
                    "Microsoft",
                    "Windows",
                    "Packages",
                    "Temp",
                    "Comms",
                    "ConnectedDevicesPlatform",
                    "Publishers",
                ],
            ));
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Some(home) = dirs::home_dir() {
            dirs.push((
                home.join(".config"),
                "config",
                vec![
                    "dconf",
                    "gtk-2.0",
                    "gtk-3.0",
                    "gtk-4.0",
                    "pulse",
                    "fontconfig",
                    "mimeapps.list",
                    "user-dirs.dirs",
                    "monitors.xml",
                    "gnome-",
                    "kde",
                    "xfce",
                    "plasma",
                    "systemd",
                    "dbus-1",
                    "pipewire",
                    "xorg",
                    "wayland",
                ],
            ));
            dirs.push((
                home.join(".local/share"),
                "local_share",
                vec![
                    "dconf",
                    "gtk-2.0",
                    "gtk-3.0",
                    "gtk-4.0",
                    "pulse",
                    "fontconfig",
                    "mimeapps.list",
                    "user-dirs.dirs",
                    "monitors.xml",
                    "gnome-",
                    "kde",
                    "xfce",
                    "plasma",
                    "systemd",
                    "dbus-1",
                    "pipewire",
                    "xorg",
                    "wayland",
                ],
            ));
            dirs.push((
                home.join(".cache"),
                "cache",
                vec![
                    "dconf",
                    "gtk-2.0",
                    "gtk-3.0",
                    "gtk-4.0",
                    "pulse",
                    "fontconfig",
                    "mimeapps.list",
                    "user-dirs.dirs",
                    "monitors.xml",
                    "gnome-",
                    "kde",
                    "xfce",
                    "plasma",
                    "systemd",
                    "dbus-1",
                    "pipewire",
                    "xorg",
                    "wayland",
                ],
            ));
        }
    }

    dirs
}

/// Quick metadata: get size/count without walking directory contents.
/// For single files: returns accurate stats immediately.
/// For directories: returns (0, 0, None, false) to signal that full calculation is needed.
fn quick_metadata(path: &Path) -> (u64, u32, Option<u64>, bool) {
    if path.is_file() {
        if let Ok(meta) = std::fs::metadata(path) {
            let size = meta.len();
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs());
            return (size, 1, modified, true);
        }
    }
    // Directory: defer full calculation
    (0, 0, None, false)
}

/// Calculate total size, file count, and latest modification time for a directory.
fn calculate_dir_stats(path: &Path) -> (u64, u32, Option<u64>) {
    let mut total_size: u64 = 0;
    let mut file_count: u32 = 0;
    let mut latest_modified: Option<u64> = None;

    if path.is_file() {
        if let Ok(meta) = std::fs::metadata(path) {
            total_size = meta.len();
            file_count = 1;
            latest_modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs());
        }
        return (total_size, file_count, latest_modified);
    }

    for entry in WalkDir::new(path).follow_links(false).into_iter().flatten() {
        if entry.file_type().is_file() {
            if let Ok(meta) = entry.metadata() {
                total_size += meta.len();
                file_count += 1;
                if let Ok(modified) = meta.modified() {
                    if let Ok(duration) = modified.duration_since(SystemTime::UNIX_EPOCH) {
                        let secs = duration.as_secs();
                        latest_modified = Some(match latest_modified {
                            Some(current) => current.max(secs),
                            None => secs,
                        });
                    }
                }
            }
        }
    }

    (total_size, file_count, latest_modified)
}

/// Calculate only the directory size (no file count or modification time).
fn calculate_dir_size_only(path: &Path) -> u64 {
    let mut total: u64 = 0;
    for entry in WalkDir::new(path).follow_links(false).into_iter().flatten() {
        if entry.file_type().is_file() {
            total += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    total
}
