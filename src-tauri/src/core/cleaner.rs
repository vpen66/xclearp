use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use super::event_bus::EventBus;
use super::events::CleanEvent;
use super::scanner::ScanTarget;
use crate::platform::PlatformProvider;

/// Summary of a clean operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanSummary {
    pub total_deleted: u64,
    pub total_freed: u64,
    pub duration_ms: u64,
    pub errors: Vec<String>,
}

/// Errors that can occur during cleaning.
#[derive(Debug, Clone)]
pub struct CleanError {
    pub message: String,
}

impl std::fmt::Display for CleanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "CleanError: {}", self.message)
    }
}

impl std::error::Error for CleanError {}

/// Cleaner engine that safely removes scanned files.
pub struct Cleaner {
    event_bus: Arc<EventBus>,
}

impl Cleaner {
    pub fn new(event_bus: Arc<EventBus>) -> Self {
        Self { event_bus }
    }

    /// Clean the given scan targets, returning a summary.
    /// When `safe_mode` is true, files are moved to trash instead of being permanently deleted.
    pub async fn clean_targets(
        &self,
        targets: &[ScanTarget],
        platform: &dyn PlatformProvider,
        op_id: &str,
        cancel_token: CancellationToken,
        safe_mode: bool,
    ) -> Result<CleanSummary, CleanError> {
        let start = Instant::now();
        let mut total_deleted: u64 = 0;
        let mut total_freed: u64 = 0;
        let mut errors: Vec<String> = Vec::new();

        // 1. Group targets and map sizes
        let mut target_sizes = HashMap::new();
        let mut targets_to_delete = HashSet::new();
        for target in targets {
            target_sizes.insert(target.path.clone(), target.size);
            targets_to_delete.insert(target.path.clone());
        }

        // 2. Find highest parent directories for all target files
        let mut top_level_dirs = HashSet::new();
        for target in targets {
            if let Some(parent) = target.path.parent() {
                top_level_dirs.insert(parent.to_path_buf());
            }
        }
        let mut roots: Vec<PathBuf> = top_level_dirs.into_iter().collect();
        roots.sort_by_key(|p| p.as_os_str().len()); // shortest path first

        let mut final_roots = Vec::new();
        for r in roots {
            if !final_roots
                .iter()
                .any(|existing: &PathBuf| r.starts_with(existing))
            {
                final_roots.push(r);
            }
        }

        // 3. Optimize deletions using recursive directory collapse
        let mut dirs_to_delete = Vec::new();
        let mut files_to_delete = Vec::new();
        for root in final_roots {
            optimize_deletions(
                &root,
                &targets_to_delete,
                &mut dirs_to_delete,
                &mut files_to_delete,
            );
        }

        // 4. Separate optimized directories into trash vs direct remove
        let mut dirs_to_trash = Vec::new();
        let mut dirs_to_remove = Vec::new();
        for dir in dirs_to_delete {
            if should_trash_dir(&dir, targets, safe_mode) {
                dirs_to_trash.push(dir);
            } else {
                dirs_to_remove.push(dir);
            }
        }

        // 5. Separate remaining files into trash vs direct remove
        let target_map: HashMap<PathBuf, &ScanTarget> =
            targets.iter().map(|t| (t.path.clone(), t)).collect();
        let mut files_to_trash = Vec::new();
        let mut files_to_remove = Vec::new();
        for path in files_to_delete {
            if let Some(target) = target_map.get(&path) {
                if safe_mode && target.group != "trash" {
                    files_to_trash.push(path);
                } else {
                    files_to_remove.push(path);
                }
            }
        }

        let mut last_emit = Instant::now();

        // --- STEP 1: Execute directory trashing ---
        if !dirs_to_trash.is_empty() {
            if cancel_token.is_cancelled() {
                let _ = self.event_bus.emit(CleanEvent::Cancelled {
                    op_id: op_id.to_string(),
                });
                return Ok(CleanSummary {
                    total_deleted,
                    total_freed,
                    duration_ms: start.elapsed().as_millis() as u64,
                    errors,
                });
            }

            let batch_freed: u64 = dirs_to_trash
                .iter()
                .map(|dir| get_directory_freed_size(dir, &target_sizes))
                .sum();

            match platform.move_all_to_trash(&dirs_to_trash) {
                Ok(()) => {
                    for dir in &dirs_to_trash {
                        let file_count = targets.iter().filter(|t| t.path.starts_with(dir)).count();
                        total_deleted += file_count as u64;
                        let _ = std::fs::create_dir_all(dir); // Recreate the empty directory
                    }
                    total_freed += batch_freed;
                }
                Err(e) => {
                    eprintln!(
                        "[xclearp] Batched directory trash failed: {}, falling back to individual directory trash",
                        e
                    );
                    for dir in &dirs_to_trash {
                        let dir_size = get_directory_freed_size(dir, &target_sizes);
                        let file_count =
                            targets.iter().filter(|t| t.path.starts_with(dir)).count() as u64;
                        match platform.move_to_trash(dir) {
                            Ok(()) => {
                                total_deleted += file_count;
                                total_freed += dir_size;
                                let _ = std::fs::create_dir_all(dir);
                            }
                            Err(pe) => {
                                let error_msg = format!(
                                    "Failed to move directory to trash {}: {}",
                                    dir.display(),
                                    pe
                                );
                                let _ = self.event_bus.emit(CleanEvent::Error {
                                    op_id: op_id.to_string(),
                                    message: error_msg.clone(),
                                    recoverable: true,
                                });
                                errors.push(error_msg);
                            }
                        }
                    }
                }
            }

            if let Some(last_dir) = dirs_to_trash.last() {
                let _ = self.event_bus.emit(CleanEvent::CleanProgress {
                    op_id: op_id.to_string(),
                    deleted_files: total_deleted,
                    freed_bytes: total_freed,
                    current_path: last_dir.to_string_lossy().to_string(),
                });
                last_emit = Instant::now();
            }
        }

        // --- STEP 2: Execute directory direct deletes ---
        if !dirs_to_remove.is_empty() {
            if cancel_token.is_cancelled() {
                let _ = self.event_bus.emit(CleanEvent::Cancelled {
                    op_id: op_id.to_string(),
                });
                return Ok(CleanSummary {
                    total_deleted,
                    total_freed,
                    duration_ms: start.elapsed().as_millis() as u64,
                    errors,
                });
            }

            for dir in &dirs_to_remove {
                let dir_size = get_directory_freed_size(dir, &target_sizes);
                let file_count = targets.iter().filter(|t| t.path.starts_with(dir)).count() as u64;

                let path_clone = dir.clone();
                let remove_res =
                    tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&path_clone)).await;

                match remove_res {
                    Ok(Ok(())) => {
                        total_deleted += file_count;
                        total_freed += dir_size;
                        let _ = std::fs::create_dir_all(dir);
                    }
                    Ok(Err(e)) => {
                        let error_msg =
                            format!("Failed to remove directory {}: {}", dir.display(), e);
                        let _ = self.event_bus.emit(CleanEvent::Error {
                            op_id: op_id.to_string(),
                            message: error_msg.clone(),
                            recoverable: true,
                        });
                        errors.push(error_msg);
                    }
                    Err(join_err) => {
                        let error_msg = format!(
                            "Task join error removing directory {}: {}",
                            dir.display(),
                            join_err
                        );
                        let _ = self.event_bus.emit(CleanEvent::Error {
                            op_id: op_id.to_string(),
                            message: error_msg.clone(),
                            recoverable: true,
                        });
                        errors.push(error_msg);
                    }
                }
            }

            if let Some(last_dir) = dirs_to_remove.last() {
                let _ = self.event_bus.emit(CleanEvent::CleanProgress {
                    op_id: op_id.to_string(),
                    deleted_files: total_deleted,
                    freed_bytes: total_freed,
                    current_path: last_dir.to_string_lossy().to_string(),
                });
                last_emit = Instant::now();
            }
        }

        // --- STEP 3: Execute file trashing in chunks of 1000 ---
        const BATCH_SIZE: usize = 1000;
        const MAX_CONCURRENT_DELETES: usize = 64;

        for chunk in files_to_trash.chunks(BATCH_SIZE) {
            if cancel_token.is_cancelled() {
                let _ = self.event_bus.emit(CleanEvent::Cancelled {
                    op_id: op_id.to_string(),
                });
                break;
            }

            let mut paths = Vec::new();
            let mut sizes = Vec::new();
            let mut batch_freed = 0;
            let mut fallback_delete = Vec::new();

            for path in chunk {
                if path.exists() {
                    let file_size = target_sizes.get(path).cloned().unwrap_or(0);
                    paths.push(path.clone());
                    sizes.push((path.clone(), file_size));
                    batch_freed += file_size;
                } else {
                    total_deleted += 1;
                }
            }

            if !paths.is_empty() {
                match platform.move_all_to_trash(&paths) {
                    Ok(()) => {
                        total_deleted += paths.len() as u64;
                        total_freed += batch_freed;
                    }
                    Err(e) => {
                        eprintln!(
                            "[xclearp] Batched file trash failed: {}, falling back to parallel direct delete",
                            e
                        );
                        for (path, file_size) in sizes {
                            fallback_delete.push((path, file_size));
                        }
                    }
                }
            }

            if !fallback_delete.is_empty() {
                #[allow(clippy::type_complexity)]
                let mut join_set: tokio::task::JoinSet<
                    Result<(PathBuf, u64), (PathBuf, u64, String)>,
                > = tokio::task::JoinSet::new();

                for (path, file_size) in fallback_delete {
                    while join_set.len() >= MAX_CONCURRENT_DELETES {
                        if let Some(res) = join_set.join_next().await {
                            match res {
                                Ok(Ok((path, file_size))) => {
                                    total_deleted += 1;
                                    total_freed += file_size;
                                    if last_emit.elapsed() >= Duration::from_millis(100) {
                                        let _ = self.event_bus.emit(CleanEvent::CleanProgress {
                                            op_id: op_id.to_string(),
                                            deleted_files: total_deleted,
                                            freed_bytes: total_freed,
                                            current_path: path.to_string_lossy().to_string(),
                                        });
                                        last_emit = Instant::now();
                                    }
                                }
                                Ok(Err((path, file_size, e))) => {
                                    match platform.safe_remove(&path) {
                                        Ok(()) => {
                                            total_deleted += 1;
                                            total_freed += file_size;
                                        }
                                        Err(pe) => {
                                            let error_msg = format!(
                                                "Failed to remove {}: {} (fallback: {})",
                                                path.display(),
                                                e,
                                                pe
                                            );
                                            let _ = self.event_bus.emit(CleanEvent::Error {
                                                op_id: op_id.to_string(),
                                                message: error_msg.clone(),
                                                recoverable: true,
                                            });
                                            errors.push(error_msg);
                                        }
                                    }
                                }
                                Err(join_err) => {
                                    let error_msg = format!("Task join error: {}", join_err);
                                    let _ = self.event_bus.emit(CleanEvent::Error {
                                        op_id: op_id.to_string(),
                                        message: error_msg.clone(),
                                        recoverable: true,
                                    });
                                    errors.push(error_msg);
                                }
                            }
                        }
                    }

                    join_set.spawn_blocking(move || {
                        let res = std::fs::remove_file(&path).map_err(|e| e.to_string());
                        match res {
                            Ok(()) => Ok((path, file_size)),
                            Err(e) => Err((path, file_size, e)),
                        }
                    });
                }

                while let Some(res) = join_set.join_next().await {
                    match res {
                        Ok(Ok((path, file_size))) => {
                            total_deleted += 1;
                            total_freed += file_size;
                            if last_emit.elapsed() >= Duration::from_millis(100) {
                                let _ = self.event_bus.emit(CleanEvent::CleanProgress {
                                    op_id: op_id.to_string(),
                                    deleted_files: total_deleted,
                                    freed_bytes: total_freed,
                                    current_path: path.to_string_lossy().to_string(),
                                });
                                last_emit = Instant::now();
                            }
                        }
                        Ok(Err((path, file_size, e))) => match platform.safe_remove(&path) {
                            Ok(()) => {
                                total_deleted += 1;
                                total_freed += file_size;
                            }
                            Err(pe) => {
                                let error_msg = format!(
                                    "Failed to remove {}: {} (fallback: {})",
                                    path.display(),
                                    e,
                                    pe
                                );
                                let _ = self.event_bus.emit(CleanEvent::Error {
                                    op_id: op_id.to_string(),
                                    message: error_msg.clone(),
                                    recoverable: true,
                                });
                                errors.push(error_msg);
                            }
                        },
                        Err(join_err) => {
                            let error_msg = format!("Task join error: {}", join_err);
                            let _ = self.event_bus.emit(CleanEvent::Error {
                                op_id: op_id.to_string(),
                                message: error_msg.clone(),
                                recoverable: true,
                            });
                            errors.push(error_msg);
                        }
                    }
                }
            }

            if let Some(last_file) = chunk.last() {
                let _ = self.event_bus.emit(CleanEvent::CleanProgress {
                    op_id: op_id.to_string(),
                    deleted_files: total_deleted,
                    freed_bytes: total_freed,
                    current_path: last_file.to_string_lossy().to_string(),
                });
                last_emit = Instant::now();
            }
        }

        // --- STEP 4: Execute file direct deletes in chunks of 1000 ---
        for chunk in files_to_remove.chunks(BATCH_SIZE) {
            if cancel_token.is_cancelled() {
                let _ = self.event_bus.emit(CleanEvent::Cancelled {
                    op_id: op_id.to_string(),
                });
                break;
            }

            let mut delete_targets = Vec::new();
            for path in chunk {
                if path.exists() {
                    let file_size = target_sizes.get(path).cloned().unwrap_or(0);
                    delete_targets.push((path.clone(), file_size));
                } else {
                    total_deleted += 1;
                }
            }

            if !delete_targets.is_empty() {
                #[allow(clippy::type_complexity)]
                let mut join_set: tokio::task::JoinSet<
                    Result<(PathBuf, u64), (PathBuf, u64, String)>,
                > = tokio::task::JoinSet::new();

                for (path, file_size) in delete_targets {
                    while join_set.len() >= MAX_CONCURRENT_DELETES {
                        if let Some(res) = join_set.join_next().await {
                            match res {
                                Ok(Ok((path, file_size))) => {
                                    total_deleted += 1;
                                    total_freed += file_size;
                                    if last_emit.elapsed() >= Duration::from_millis(100) {
                                        let _ = self.event_bus.emit(CleanEvent::CleanProgress {
                                            op_id: op_id.to_string(),
                                            deleted_files: total_deleted,
                                            freed_bytes: total_freed,
                                            current_path: path.to_string_lossy().to_string(),
                                        });
                                        last_emit = Instant::now();
                                    }
                                }
                                Ok(Err((path, file_size, e))) => {
                                    match platform.safe_remove(&path) {
                                        Ok(()) => {
                                            total_deleted += 1;
                                            total_freed += file_size;
                                        }
                                        Err(pe) => {
                                            let error_msg = format!(
                                                "Failed to remove {}: {} (fallback: {})",
                                                path.display(),
                                                e,
                                                pe
                                            );
                                            let _ = self.event_bus.emit(CleanEvent::Error {
                                                op_id: op_id.to_string(),
                                                message: error_msg.clone(),
                                                recoverable: true,
                                            });
                                            errors.push(error_msg);
                                        }
                                    }
                                }
                                Err(join_err) => {
                                    let error_msg = format!("Task join error: {}", join_err);
                                    let _ = self.event_bus.emit(CleanEvent::Error {
                                        op_id: op_id.to_string(),
                                        message: error_msg.clone(),
                                        recoverable: true,
                                    });
                                    errors.push(error_msg);
                                }
                            }
                        }
                    }

                    join_set.spawn_blocking(move || {
                        let res = std::fs::remove_file(&path).map_err(|e| e.to_string());
                        match res {
                            Ok(()) => Ok((path, file_size)),
                            Err(e) => Err((path, file_size, e)),
                        }
                    });
                }

                while let Some(res) = join_set.join_next().await {
                    match res {
                        Ok(Ok((path, file_size))) => {
                            total_deleted += 1;
                            total_freed += file_size;
                            if last_emit.elapsed() >= Duration::from_millis(100) {
                                let _ = self.event_bus.emit(CleanEvent::CleanProgress {
                                    op_id: op_id.to_string(),
                                    deleted_files: total_deleted,
                                    freed_bytes: total_freed,
                                    current_path: path.to_string_lossy().to_string(),
                                });
                                last_emit = Instant::now();
                            }
                        }
                        Ok(Err((path, file_size, e))) => match platform.safe_remove(&path) {
                            Ok(()) => {
                                total_deleted += 1;
                                total_freed += file_size;
                            }
                            Err(pe) => {
                                let error_msg = format!(
                                    "Failed to remove {}: {} (fallback: {})",
                                    path.display(),
                                    e,
                                    pe
                                );
                                let _ = self.event_bus.emit(CleanEvent::Error {
                                    op_id: op_id.to_string(),
                                    message: error_msg.clone(),
                                    recoverable: true,
                                });
                                errors.push(error_msg);
                            }
                        },
                        Err(join_err) => {
                            let error_msg = format!("Task join error: {}", join_err);
                            let _ = self.event_bus.emit(CleanEvent::Error {
                                op_id: op_id.to_string(),
                                message: error_msg.clone(),
                                recoverable: true,
                            });
                            errors.push(error_msg);
                        }
                    }
                }
            }

            if let Some(last_file) = chunk.last() {
                let _ = self.event_bus.emit(CleanEvent::CleanProgress {
                    op_id: op_id.to_string(),
                    deleted_files: total_deleted,
                    freed_bytes: total_freed,
                    current_path: last_file.to_string_lossy().to_string(),
                });
                last_emit = Instant::now();
            }
        }

        let duration_ms = start.elapsed().as_millis() as u64;

        // Emit clean_completed
        let _ = self.event_bus.emit(CleanEvent::CleanCompleted {
            op_id: op_id.to_string(),
            total_deleted,
            total_freed,
            duration_ms,
        });

        Ok(CleanSummary {
            total_deleted,
            total_freed,
            duration_ms,
            errors,
        })
    }
}

fn can_delete_dir_completely(dir: &Path, targets_to_delete: &HashSet<PathBuf>) -> bool {
    let walker = walkdir::WalkDir::new(dir).follow_links(false);
    for entry in walker {
        match entry {
            Ok(e) => {
                if e.file_type().is_file() && !targets_to_delete.contains(e.path()) {
                    return false;
                }
            }
            Err(_) => {
                return false;
            }
        }
    }
    true
}

fn optimize_deletions(
    dir: &Path,
    targets_to_delete: &HashSet<PathBuf>,
    dirs_to_delete: &mut Vec<PathBuf>,
    files_to_delete: &mut Vec<PathBuf>,
) {
    if can_delete_dir_completely(dir, targets_to_delete) {
        dirs_to_delete.push(dir.to_path_buf());
        return;
    }

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                optimize_deletions(&path, targets_to_delete, dirs_to_delete, files_to_delete);
            } else if targets_to_delete.contains(&path) {
                files_to_delete.push(path);
            }
        }
    }
}

fn get_directory_freed_size(dir: &Path, target_sizes: &HashMap<PathBuf, u64>) -> u64 {
    let mut size = 0;
    for (path, s) in target_sizes {
        if path.starts_with(dir) {
            size += s;
        }
    }
    size
}

fn should_trash_dir(dir: &Path, targets: &[ScanTarget], safe_mode: bool) -> bool {
    if !safe_mode {
        return false;
    }
    for target in targets {
        if target.path.starts_with(dir) && target.group == "trash" {
            return false;
        }
    }
    true
}
