use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use glob::Pattern;
use glob;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use walkdir::WalkDir;

use super::dedup::PathDedup;
use super::event_bus::EventBus;
use super::events::CleanEvent;
use super::rules::CleanRule;
use super::whitelist::Whitelist;
use crate::platform::PlatformProvider;

/// A file matched by the scanner for cleaning.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanTarget {
    pub path: PathBuf,
    pub size: u64,
    pub rule_id: String,
    pub group: String,
}

/// Summary of a scan operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanSummary {
    pub total_files: u64,
    pub total_size: u64,
    pub duration_ms: u64,
    pub errors: Vec<String>,
    pub skipped_files: u64,
    pub skipped_size: u64,
}

/// Errors that can occur during scanning.
#[derive(Debug, Clone)]
pub struct ScanError {
    pub message: String,
}

impl std::fmt::Display for ScanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ScanError: {}", self.message)
    }
}

impl std::error::Error for ScanError {}

/// Scanner engine that walks directories and matches files against cleaning rules.
pub struct Scanner {
    event_bus: Arc<EventBus>,
    whitelist: Arc<RwLock<Whitelist>>,
    dedup: Arc<Mutex<PathDedup>>,
}

struct ScanDirResult {
    targets: Vec<ScanTarget>,
    skipped_count: u64,
    skipped_size: u64,
}

impl Scanner {
    pub fn new(event_bus: Arc<EventBus>, whitelist: Arc<RwLock<Whitelist>>) -> Self {
        Self {
            event_bus,
            whitelist,
            dedup: Arc::new(Mutex::new(PathDedup::new())),
        }
    }

    /// Scan multiple rules in parallel, returning targets and aggregated summary.
    pub async fn scan_rules(
        &self,
        rules: &[CleanRule],
        platform: &dyn PlatformProvider,
        op_id: &str,
        cancel_token: CancellationToken,
    ) -> Result<(Vec<ScanTarget>, ScanSummary), ScanError> {
        let start = Instant::now();

        // Emit scan_started event
        let _ = self.event_bus.emit(CleanEvent::ScanStarted {
            op_id: op_id.to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
        });

        // Clear dedup seen paths for the new scan operation
        {
            let mut dedup_guard = self.dedup.lock().unwrap();
            dedup_guard.clear();
        }

        let mut join_set = JoinSet::new();
        let mut all_errors: Vec<String> = Vec::new();

        // Spawn a task per rule for parallel scanning
        for rule in rules {
            if !rule.enabled {
                continue;
            }

            let event_bus = Arc::clone(&self.event_bus);
            let whitelist = Arc::clone(&self.whitelist);
            let dedup = Arc::clone(&self.dedup);
            let rule = rule.clone();
            let op_id = op_id.to_string();
            let cancel_token = cancel_token.clone();

            // Resolve paths using platform provider (with glob expansion)
            let resolved_paths: Vec<PathBuf> = rule
                .paths
                .iter()
                .flat_map(|p| resolve_path_with_glob(p, platform))
                .collect();

            join_set.spawn(async move {
                let mut targets = Vec::new();
                let mut skipped_count = 0;
                let mut skipped_size = 0;
                for dir_path in &resolved_paths {
                    if cancel_token.is_cancelled() {
                        break;
                    }
                    match scan_directory_impl(
                        dir_path,
                        &rule,
                        &op_id,
                        &event_bus,
                        &whitelist,
                        &dedup,
                        &cancel_token,
                    )
                    .await
                    {
                        Ok(res) => {
                            targets.extend(res.targets);
                            skipped_count += res.skipped_count;
                            skipped_size += res.skipped_size;
                        }
                        Err(e) => {
                            let _ = event_bus.emit(CleanEvent::Error {
                                op_id: op_id.clone(),
                                message: e.clone(),
                                recoverable: true,
                            });
                            // Continue with other directories
                        }
                    }
                }
                (targets, skipped_count, skipped_size)
            });
        }

        // Collect results from all spawned tasks
        let mut all_targets: Vec<ScanTarget> = Vec::new();
        let mut total_skipped_files = 0;
        let mut total_skipped_size = 0;
        while let Some(result) = join_set.join_next().await {
            match result {
                Ok((targets, skipped_count, skipped_size)) => {
                    all_targets.extend(targets);
                    total_skipped_files += skipped_count;
                    total_skipped_size += skipped_size;
                }
                Err(e) => {
                    all_errors.push(format!("Task join error: {}", e));
                }
            }
        }

        // Check if cancelled
        if cancel_token.is_cancelled() {
            let _ = self.event_bus.emit(CleanEvent::Cancelled {
                op_id: op_id.to_string(),
            });
        }

        let total_files = all_targets.len() as u64;
        let total_size = all_targets.iter().map(|t| t.size).sum();
        let duration_ms = start.elapsed().as_millis() as u64;

        // Emit scan_completed
        let _ = self.event_bus.emit(CleanEvent::ScanCompleted {
            op_id: op_id.to_string(),
            total_files,
            total_size,
            duration_ms,
            skipped_files: total_skipped_files,
            skipped_size: total_skipped_size,
        });

        Ok((
            all_targets,
            ScanSummary {
                total_files,
                total_size,
                duration_ms,
                errors: all_errors,
                skipped_files: total_skipped_files,
                skipped_size: total_skipped_size,
            },
        ))
    }
}

/// Resolve a path pattern, expanding glob patterns (e.g., ~/projects/*/target)
/// into concrete directory paths. Falls back to normal resolve_path for non-glob paths.
fn resolve_path_with_glob(pattern: &str, platform: &dyn PlatformProvider) -> Vec<PathBuf> {
    // Check if the pattern contains glob characters
    let has_glob = pattern.contains('*') || pattern.contains('?') || pattern.contains('[');

    if !has_glob {
        // No glob – use standard resolution
        return platform.resolve_path(pattern).into_iter().collect();
    }

    // First expand ~ to home directory
    let expanded = if pattern.starts_with('~') {
        if let Some(home) = dirs::home_dir() {
            let home_str = home.to_string_lossy();
            if pattern.starts_with("~/") {
                format!("{}{}", home_str, &pattern[1..])
            } else if pattern == "~" {
                home_str.to_string()
            } else {
                format!("{}/{}", home_str, &pattern[1..])
            }
        } else {
            pattern.to_string()
        }
    } else {
        pattern.to_string()
    };

    // If it's a relative path, resolve it relative to the home directory for safety and consistency
    let expanded_path = PathBuf::from(&expanded);
    let final_pattern = if !expanded_path.is_absolute() {
        if let Some(home) = dirs::home_dir() {
            home.join(&expanded).to_string_lossy().to_string()
        } else {
            expanded
        }
    } else {
        expanded
    };

    // Use glob to expand the pattern, collecting only existing directories
    match glob::glob(&final_pattern) {
        Ok(paths) => paths
            .filter_map(|entry| entry.ok())
            .filter(|p| p.is_dir())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Implementation of directory scanning (called per rule per directory).
async fn scan_directory_impl(
    path: &Path,
    rule: &CleanRule,
    op_id: &str,
    event_bus: &Arc<EventBus>,
    whitelist: &Arc<RwLock<Whitelist>>,
    dedup: &Arc<Mutex<PathDedup>>,
    cancel_token: &CancellationToken,
) -> Result<ScanDirResult, String> {
    if !path.exists() {
        return Ok(ScanDirResult {
            targets: Vec::new(),
            skipped_count: 0,
            skipped_size: 0,
        });
    }

    let path = path.to_path_buf();
    let rule = rule.clone();
    let op_id = op_id.to_string();
    let event_bus = Arc::clone(event_bus);
    let whitelist = Arc::clone(whitelist);
    let dedup = Arc::clone(dedup);
    let cancel_token = cancel_token.clone();

    // Compile file patterns and exclude patterns
    let file_patterns: Vec<Pattern> = rule
        .file_patterns
        .iter()
        .filter_map(|p| Pattern::new(p).ok())
        .collect();
    let exclude_patterns: Vec<Pattern> = rule
        .exclude_patterns
        .iter()
        .filter_map(|p| Pattern::new(p).ok())
        .collect();

    // Use spawn_blocking because walkdir is synchronous I/O
    let result = tokio::task::spawn_blocking(move || {
        let mut targets = Vec::new();
        let mut scanned_count: u64 = 0;
        let mut scanned_size: u64 = 0;
        let mut skipped_count: u64 = 0;
        let mut skipped_size: u64 = 0;

        let walker = WalkDir::new(&path).follow_links(false).into_iter();

        for entry in walker {
            // Check cancellation at each directory boundary
            if cancel_token.is_cancelled() {
                break;
            }

            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    // Silently skip permission errors
                    if e.io_error()
                        .map(|io| io.raw_os_error() == Some(1) || io.raw_os_error() == Some(13))
                        .unwrap_or(false)
                    {
                        continue;
                    }
                    let _ = event_bus.emit(CleanEvent::Error {
                        op_id: op_id.clone(),
                        message: format!("Walk error: {}", e),
                        recoverable: true,
                    });
                    continue;
                }
            };

            let entry_path = entry.path();

            // Skip directories themselves, we only care about files
            if entry_path.is_dir() {
                continue;
            }

            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let file_size = metadata.len();

            // Whitelist check
            if whitelist.read().unwrap().is_excluded(entry_path, &rule.id, &rule.group) {
                skipped_count += 1;
                skipped_size += file_size;
                continue;
            }

            // Dedup check
            {
                let mut dedup_guard = dedup.lock().unwrap();
                if !dedup_guard.insert(entry_path) {
                    continue; // Already seen this path
                }
            }

            // File pattern matching
            let file_name = entry_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            if !file_patterns.is_empty() {
                let matches = file_patterns.iter().any(|p| p.matches(file_name));
                if !matches {
                    continue;
                }
            }

            // Exclude pattern matching
            if !exclude_patterns.is_empty() {
                let excluded = exclude_patterns.iter().any(|p| p.matches(file_name));
                if excluded {
                    continue;
                }
            }

            // File age check
            if let Some(min_age_hours) = rule.min_age_hours {
                if !crate::platform::common::is_file_older_than(entry_path, min_age_hours) {
                    continue;
                }
            }

            // Max size check
            if let Some(max_size_mb) = rule.max_size_mb {
                let max_bytes = max_size_mb * 1024 * 1024;
                if file_size > max_bytes {
                    continue;
                }
            }

            scanned_count += 1;
            scanned_size += file_size;

            // Emit file_discovered event
            let _ = event_bus.emit(CleanEvent::FileDiscovered {
                op_id: op_id.clone(),
                path: entry_path.to_string_lossy().to_string(),
                size: file_size,
                rule_id: rule.id.clone(),
                group: rule.group.clone(),
                scan_path: path.to_string_lossy().to_string(),
            });

            // Emit scan_progress every 100 files
            if scanned_count % 100 == 0 {
                let _ = event_bus.emit(CleanEvent::ScanProgress {
                    op_id: op_id.clone(),
                    scanned_files: scanned_count,
                    total_size: scanned_size,
                    current_rule: rule.name.clone(),
                });
            }

            targets.push(ScanTarget {
                path: entry_path.to_path_buf(),
                size: file_size,
                rule_id: rule.id.clone(),
                group: rule.group.clone(),
            });
        }

        ScanDirResult {
            targets,
            skipped_count,
            skipped_size,
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {}", e))?;

    Ok(result)
}
