use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use walkdir::WalkDir;

use super::{AppFileCategory, AppFileEntry, AppFileGroup, InstalledApp};
use crate::core::event_bus::UninstallEventBus;
use crate::core::events::UninstallEvent;

/// Build the macOS-specific category -> paths mapping for residual scanning.
pub fn macos_residual_paths(app: &InstalledApp) -> HashMap<AppFileCategory, Vec<PathBuf>> {
    let home = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
    let bundle_id = &app.bundle_id;
    let name = &app.name;

    let mut category_paths: HashMap<AppFileCategory, Vec<PathBuf>> = HashMap::new();

    let mut add = |cat: AppFileCategory, p: PathBuf| {
        category_paths.entry(cat).or_default().push(p);
    };

    // Application Support
    add(
        AppFileCategory::ApplicationSupport,
        home.join(format!("Library/Application Support/{}", name)),
    );
    if !bundle_id.is_empty() {
        add(
            AppFileCategory::ApplicationSupport,
            home.join(format!("Library/Application Support/{}", bundle_id)),
        );
    }

    // Caches
    if !bundle_id.is_empty() {
        add(
            AppFileCategory::Cache,
            home.join(format!("Library/Caches/{}", bundle_id)),
        );
    }
    add(
        AppFileCategory::Cache,
        home.join(format!("Library/Caches/{}", name)),
    );

    // Preferences
    if !bundle_id.is_empty() {
        add(
            AppFileCategory::Preferences,
            home.join(format!("Library/Preferences/{}.plist", bundle_id)),
        );
    }

    // Logs
    add(
        AppFileCategory::Logs,
        home.join(format!("Library/Logs/{}", name)),
    );
    if !bundle_id.is_empty() {
        add(
            AppFileCategory::Logs,
            home.join(format!("Library/Logs/{}", bundle_id)),
        );
    }

    // Saved Application State
    if !bundle_id.is_empty() {
        add(
            AppFileCategory::SavedState,
            home.join(format!(
                "Library/Saved Application State/{}.savedState",
                bundle_id
            )),
        );
    }

    // Containers
    if !bundle_id.is_empty() {
        add(
            AppFileCategory::Containers,
            home.join(format!("Library/Containers/{}", bundle_id)),
        );
    }

    // WebKit
    if !bundle_id.is_empty() {
        add(
            AppFileCategory::WebKit,
            home.join(format!("Library/WebKit/{}", bundle_id)),
        );
    }

    // HTTP Storages
    if !bundle_id.is_empty() {
        add(
            AppFileCategory::HttpStorages,
            home.join(format!("Library/HTTPStorages/{}", bundle_id)),
        );
    }

    // LaunchAgents (user-level)
    scan_launch_items(&home.join("Library/LaunchAgents"), bundle_id, &mut |p| {
        add(AppFileCategory::LaunchAgents, p)
    });

    // LaunchAgents (system-level)
    scan_launch_items(
        &PathBuf::from("/Library/LaunchAgents"),
        bundle_id,
        &mut |p| add(AppFileCategory::LaunchAgents, p),
    );

    // LaunchDaemons
    scan_launch_items(
        &PathBuf::from("/Library/LaunchDaemons"),
        bundle_id,
        &mut |p| add(AppFileCategory::LaunchDaemons, p),
    );

    category_paths
}

/// Generic utility: scan a set of category-keyed paths and build file groups.
/// Emits progress events via the event bus. Used by all platform implementations.
/// `start` is the Instant when the overall scan began (for duration reporting).
pub fn scan_paths_to_groups(
    category_paths: HashMap<AppFileCategory, Vec<PathBuf>>,
    event_bus: &Arc<UninstallEventBus>,
    op_id: &str,
    start: Instant,
) -> Vec<AppFileGroup> {
    let mut groups: Vec<AppFileGroup> = Vec::new();
    let mut scanned_paths: u64 = 0;
    let mut total_files: u64 = 0;
    let mut total_size: u64 = 0;

    for (category, paths) in &category_paths {
        let mut files: Vec<AppFileEntry> = Vec::new();
        let mut group_size: u64 = 0;

        for path in paths {
            if !path.exists() {
                continue;
            }

            if path.is_file() {
                let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                files.push(AppFileEntry {
                    path: path.to_string_lossy().to_string(),
                    size,
                    is_dir: false,
                });
                group_size += size;
            } else if path.is_dir() {
                for entry in WalkDir::new(path).follow_links(false).into_iter() {
                    let entry = match entry {
                        Ok(e) => e,
                        Err(_) => continue,
                    };
                    let entry_path = entry.path();
                    if entry_path.is_dir() {
                        continue;
                    }
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    files.push(AppFileEntry {
                        path: entry_path.to_string_lossy().to_string(),
                        size,
                        is_dir: false,
                    });
                    group_size += size;
                }
                // Add the directory root itself so we can delete the whole dir
                files.insert(
                    0,
                    AppFileEntry {
                        path: path.to_string_lossy().to_string(),
                        size: group_size,
                        is_dir: true,
                    },
                );
            }

            scanned_paths += 1;
            let _ = event_bus.emit(UninstallEvent::AppScanProgress {
                op_id: op_id.to_string(),
                scanned_paths,
                current_path: path.to_string_lossy().to_string(),
            });
        }

        if !files.is_empty() {
            let file_count = files.iter().filter(|f| !f.is_dir).count() as u64;
            total_files += file_count;
            total_size += group_size;

            let _ = event_bus.emit(UninstallEvent::CategoryDiscovered {
                op_id: op_id.to_string(),
                category: category.display_name().to_string(),
                file_count,
                total_size: group_size,
                risk_hint: category.risk_hint().to_string(),
            });

            groups.push(AppFileGroup {
                category: category.clone(),
                category_name: category.display_name().to_string(),
                risk_hint: category.risk_hint().to_string(),
                risk_level: category.risk_level(),
                files,
                total_size: group_size,
                file_count,
            });
        }
    }

    let duration_ms = start.elapsed().as_millis() as u64;

    let _ = event_bus.emit(UninstallEvent::AppScanCompleted {
        op_id: op_id.to_string(),
        total_files,
        total_size,
        categories_count: groups.len() as u64,
        duration_ms,
    });

    groups
}

/// Scan a LaunchAgents/LaunchDaemons directory for plist files matching the bundle_id.
fn scan_launch_items<F: FnMut(PathBuf)>(dir: &Path, bundle_id: &str, mut add: F) {
    if bundle_id.is_empty() || !dir.exists() {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("plist") {
                let file_name = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if file_name.contains(&bundle_id.to_lowercase()) {
                    add(path);
                }
            }
        }
    }
}
