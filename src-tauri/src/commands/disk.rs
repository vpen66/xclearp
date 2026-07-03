use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::{command, Emitter};
use tokio_util::sync::CancellationToken;
use walkdir::WalkDir;

#[cfg(unix)]
fn get_file_size(metadata: &std::fs::Metadata) -> u64 {
    metadata.blocks() * 512
}

#[cfg(not(unix))]
fn get_file_size(metadata: &std::fs::Metadata) -> u64 {
    metadata.len()
}

use crate::core::events::DiskEvent;
use crate::core::whitelist::Whitelist;

/// State container for managing active disk analysis cancellation and caching.
pub struct DiskAnalysisState {
    pub cancel_token: std::sync::Mutex<Option<CancellationToken>>,
    pub size_cache: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, u64>>>,
}

impl Default for DiskAnalysisState {
    fn default() -> Self {
        Self {
            cancel_token: std::sync::Mutex::new(None),
            size_cache: std::sync::Arc::new(
                std::sync::Mutex::new(std::collections::HashMap::new()),
            ),
        }
    }
}

/// Helper function to match path against pre-compiled exclude patterns.
fn check_exclude_optimized(
    path: &Path,
    compiled_excludes: &[(glob::Pattern, bool)],
) -> Option<bool> {
    let path_str = path.to_string_lossy().replace('\\', "/");
    for (pattern, eye_open) in compiled_excludes {
        if pattern.matches(&path_str)
            || pattern.matches(&format!("{}/", path_str))
            || pattern.matches(&format!("{}/dummy", path_str))
        {
            return Some(*eye_open);
        }
    }
    None
}

/// 文件/目录条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_symlink: Option<bool>,
    pub modified: Option<String>,    // ISO 8601 时间戳
    pub children_count: Option<u64>, // 目录的直接子条目数量
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calculating: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_whitelisted: Option<bool>,
}

/// 磁盘使用概况
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub total: u64,
    pub used: u64,
    pub available: u64,
    pub mount_point: String,
}

#[cfg(windows)]
pub fn get_windows_drives() -> Vec<String> {
    use std::os::windows::ffi::OsStringExt;
    extern "system" {
        fn GetLogicalDriveStringsW(nBufferLength: u32, lpBuffer: *mut u16) -> u32;
    }

    let mut buffer = vec![0u16; 256];
    let len = unsafe { GetLogicalDriveStringsW(buffer.len() as u32, buffer.as_mut_ptr()) };
    if len == 0 {
        return vec!["C:\\".to_string()];
    }

    let mut drives = Vec::new();
    let mut start = 0;
    for i in 0..(len as usize) {
        if buffer[i] == 0 {
            if start < i {
                if let Ok(drive_os) = std::ffi::OsString::from_wide(&buffer[start..i]).into_string()
                {
                    drives.push(drive_os);
                }
            }
            start = i + 1;
        }
    }
    if drives.is_empty() {
        drives.push("C:\\".to_string());
    }
    drives
}

#[cfg(windows)]
fn get_disk_usage_for_path(path: &str) -> Result<DiskUsage, String> {
    use std::os::windows::ffi::OsStrExt;

    extern "system" {
        fn GetDiskFreeSpaceExW(
            lpDirectoryName: *const u16,
            lpFreeBytesAvailableToCaller: *mut u64,
            lpTotalNumberOfBytes: *mut u64,
            lpTotalNumberOfFreeBytes: *mut u64,
        ) -> i32;
    }

    let p = PathBuf::from(path);
    let mut path_utf16: Vec<u16> = p.as_os_str().encode_wide().collect();
    path_utf16.push(0);

    let mut free_bytes_available: u64 = 0;
    let mut total_bytes: u64 = 0;
    let mut total_free_bytes: u64 = 0;

    let res = unsafe {
        GetDiskFreeSpaceExW(
            path_utf16.as_ptr(),
            &mut free_bytes_available,
            &mut total_bytes,
            &mut total_free_bytes,
        )
    };

    if res != 0 {
        let total = total_bytes;
        let available = free_bytes_available;
        let used = total.saturating_sub(available);
        return Ok(DiskUsage {
            total,
            used,
            available,
            mount_point: path.to_string(),
        });
    }
    Err("Failed to get disk usage".to_string())
}

/// 列出目录内容
#[command]
pub async fn list_directory(
    engine: tauri::State<'_, crate::core::engine::CleanEngine>,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    #[cfg(windows)]
    let dir_path = {
        let mut p = path.replace('/', "\\");
        if p.len() == 2 && p.ends_with(':') {
            p.push('\\');
        }
        PathBuf::from(p)
    };
    #[cfg(not(windows))]
    let dir_path = PathBuf::from(&path);

    #[cfg(windows)]
    if path.is_empty() || path == "/" {
        let drives = get_windows_drives();
        let mut entries = Vec::new();
        for drive in drives {
            let mut used = 0;
            if let Ok(usage) = get_disk_usage_for_path(&drive) {
                used = usage.used;
            }
            entries.push(FileEntry {
                name: drive.clone(),
                path: drive,
                size: used,
                is_dir: true,
                is_symlink: Some(false),
                modified: None,
                children_count: None,
                calculating: Some(false),
                is_whitelisted: None,
            });
        }
        return Ok(entries);
    }

    if !dir_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !dir_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let wl = engine.whitelist().read().unwrap();
    let mut entries = Vec::new();

    // Pre-compile global excludes once
    let compiled_excludes: Vec<(glob::Pattern, bool)> = wl
        .global_excludes
        .iter()
        .filter(|pat| !wl.disabled_patterns.contains(*pat))
        .filter_map(|pat| {
            glob::Pattern::new(&pat.replace('\\', "/")).ok().map(|p| {
                let eye_open = wl.show_in_disk_analysis.contains(pat);
                (p, eye_open)
            })
        })
        .collect();

    let read_dir = match std::fs::read_dir(&dir_path) {
        Ok(rd) => rd,
        Err(e) => return Err(format!("Cannot read directory: {}", e)),
    };

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue, // 跳过权限错误
        };

        // Check whitelist exclusion for disk analysis
        if let Some(show) = check_exclude_optimized(&entry.path(), &compiled_excludes) {
            if !show {
                // Eye is closed, skip completely
                continue;
            }
        }

        // Use std::fs::symlink_metadata to avoid following symlinks
        let metadata = match std::fs::symlink_metadata(entry.path()) {
            Ok(m) => m,
            Err(_) => continue,
        };

        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path().to_string_lossy().to_string();
        let is_symlink = metadata.file_type().is_symlink();
        let mut is_dir = metadata.is_dir();
        if is_symlink {
            if let Ok(target_metadata) = std::fs::metadata(entry.path()) {
                is_dir = target_metadata.is_dir();
            }
        }

        // Only calculate directory size for non-root directories to avoid performance issues
        let size = if is_symlink {
            // Symlinks themselves take minimal space (just the link target path)
            metadata.len()
        } else if is_dir {
            // For user directories, calculate size (but with a limit)
            calculate_dir_size_limited(&entry.path(), 1_000_000_000, &wl) // 1GB limit
        } else {
            // For regular files, use actual disk usage (blocks * 512) to handle sparse files correctly
            // On macOS/Linux, blocks represents 512-byte sectors actually allocated
            get_file_size(&metadata)
        };

        let modified = metadata.modified().ok().map(|t| {
            let datetime: chrono::DateTime<chrono::Utc> = t.into();
            datetime.to_rfc3339()
        });

        let children_count = if is_dir {
            Some(count_children(&entry.path()))
        } else {
            None
        };

        let is_whitelisted = match check_exclude_optimized(&entry.path(), &compiled_excludes) {
            Some(true) => Some(true),
            _ => None,
        };

        entries.push(FileEntry {
            name,
            path,
            size,
            is_dir,
            is_symlink: Some(is_symlink),
            modified,
            children_count,
            calculating: Some(false),
            is_whitelisted,
        });
    }

    // 按大小降序排序
    entries.sort_by_key(|b| std::cmp::Reverse(b.size));

    Ok(entries)
}

/// 流式磁盘分析：逐个推送目录条目
#[command]
pub async fn start_disk_analysis(
    engine: tauri::State<'_, crate::core::engine::CleanEngine>,
    state: tauri::State<'_, DiskAnalysisState>,
    app: tauri::AppHandle,
    path: String,
) -> Result<(), String> {
    #[cfg(windows)]
    if path.is_empty() || path == "/" {
        // Cancel the previous active analysis scan
        {
            let mut token_guard = state.cancel_token.lock().unwrap();
            if let Some(old_token) = token_guard.take() {
                old_token.cancel();
            }
            let new_token = CancellationToken::new();
            *token_guard = Some(new_token);
        }
        let app_clone = app.clone();
        let path_clone = path.clone();
        tauri::async_runtime::spawn(async move {
            let drives = get_windows_drives();
            let mut entries_count = 0;
            let start_time = std::time::Instant::now();
            for drive in drives {
                let mut used = 0;
                if let Ok(usage) = get_disk_usage_for_path(&drive) {
                    used = usage.used;
                }
                let entry = FileEntry {
                    name: drive.clone(),
                    path: drive.clone(),
                    size: used,
                    is_dir: true,
                    is_symlink: Some(false),
                    modified: None,
                    children_count: None,
                    calculating: Some(false),
                    is_whitelisted: None,
                };
                let event = DiskEvent::EntryDiscovered {
                    scan_path: path_clone.clone(),
                    entry,
                };
                app_clone.emit("disk-event", &event).ok();
                entries_count += 1;
            }
            let duration_ms = start_time.elapsed().as_millis() as u64;
            let completed_event = DiskEvent::Completed {
                path: path_clone,
                total_entries: entries_count,
                duration_ms,
            };
            app_clone.emit("disk-event", &completed_event).ok();
        });
        return Ok(());
    }

    #[cfg(windows)]
    let dir_path = {
        let mut p = path.replace('/', "\\");
        if p.len() == 2 && p.ends_with(':') {
            p.push('\\');
        }
        PathBuf::from(p)
    };
    #[cfg(not(windows))]
    let dir_path = PathBuf::from(&path);

    if !dir_path.exists() {
        let event = DiskEvent::Error {
            path: path.clone(),
            message: format!("Path does not exist: {}", path),
        };
        app.emit("disk-event", &event).ok();
        return Err(format!("Path does not exist: {}", path));
    }
    if !dir_path.is_dir() {
        let event = DiskEvent::Error {
            path: path.clone(),
            message: format!("Not a directory: {}", path),
        };
        app.emit("disk-event", &event).ok();
        return Err(format!("Not a directory: {}", path));
    }

    // Cancel the previous active analysis scan
    {
        let mut token_guard = state.cancel_token.lock().unwrap();
        if let Some(old_token) = token_guard.take() {
            old_token.cancel();
        }
        // Store a new token for this scan
        let new_token = CancellationToken::new();
        *token_guard = Some(new_token);
    }

    // Clone the token for the tasks
    let cancel_token = {
        let token_guard = state.cancel_token.lock().unwrap();
        token_guard.as_ref().unwrap().clone()
    };

    let wl = engine.whitelist().read().unwrap().clone();
    let app_clone = app.clone();
    let path_for_task = path.clone();
    let cancel_token_task = cancel_token.clone();
    let cache_task = state.size_cache.clone();

    tauri::async_runtime::spawn(async move {
        // Wrap in catch_unwind to prevent silent failures
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let start_time = Instant::now();
            let mut entries_count: u64 = 0;

            let read_dir = match std::fs::read_dir(&dir_path) {
                Ok(rd) => rd,
                Err(e) => {
                    let event = DiskEvent::Error {
                        path: path_for_task.clone(),
                        message: format!("Cannot read directory: {}", e),
                    };
                    app_clone.emit("disk-event", &event).ok();
                    return;
                }
            };

            let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
            let wl_task = wl.clone();

            // Pre-compile global excludes once
            let compiled_excludes: Vec<(glob::Pattern, bool)> = wl_task
                .global_excludes
                .iter()
                .filter(|pat| !wl_task.disabled_patterns.contains(*pat))
                .filter_map(|pat| {
                    glob::Pattern::new(&pat.replace('\\', "/")).ok().map(|p| {
                        let eye_open = wl_task.show_in_disk_analysis.contains(pat);
                        (p, eye_open)
                    })
                })
                .collect();

            for entry in read_dir {
                if cancel_token_task.is_cancelled() {
                    return;
                }

                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => continue,
                };

                // Check whitelist exclusion for disk analysis using pre-compiled patterns
                if let Some(show) = check_exclude_optimized(&entry.path(), &compiled_excludes) {
                    if !show {
                        // Eye is closed, skip completely
                        continue;
                    }
                }

                let metadata = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };

                let name = entry.file_name().to_string_lossy().to_string();
                let entry_path = entry.path().to_string_lossy().to_string();
                let is_symlink = metadata.file_type().is_symlink();
                let mut is_dir = metadata.is_dir();
                if is_symlink {
                    if let Ok(target_metadata) = std::fs::metadata(entry.path()) {
                        is_dir = target_metadata.is_dir();
                    }
                }

                let is_async_dir = is_dir && !is_symlink;

                // Check cache first!
                let mut cached_size = None;
                if is_async_dir {
                    let cache = cache_task.lock().unwrap();
                    if let Some(&sz) = cache.get(&entry_path) {
                        cached_size = Some(sz);
                    }
                }

                let size = if let Some(sz) = cached_size {
                    sz
                } else if is_symlink {
                    metadata.len()
                } else if is_async_dir {
                    0
                } else {
                    metadata.len()
                };

                let modified = metadata.modified().ok().map(|t| {
                    let datetime: chrono::DateTime<chrono::Utc> = t.into();
                    datetime.to_rfc3339()
                });

                let children_count = if is_dir {
                    Some(count_children(&entry.path()))
                } else {
                    None
                };

                let is_whitelisted =
                    match check_exclude_optimized(&entry.path(), &compiled_excludes) {
                        Some(true) => Some(true),
                        _ => None,
                    };

                let is_calculating = is_async_dir && cached_size.is_none();

                let file_entry = FileEntry {
                    name,
                    path: entry_path.clone(),
                    size,
                    is_dir,
                    is_symlink: Some(is_symlink),
                    modified,
                    children_count,
                    calculating: Some(is_calculating),
                    is_whitelisted,
                };

                let event = DiskEvent::EntryDiscovered {
                    scan_path: path_for_task.clone(),
                    entry: file_entry,
                };
                app_clone.emit("disk-event", &event).ok();

                if is_async_dir && cached_size.is_none() {
                    let app_inner = app_clone.clone();
                    let scan_path_inner = path_for_task.clone();
                    let dir_path_inner = entry.path();
                    let entry_path_inner = entry_path.clone();
                    let sem_inner = semaphore.clone();
                    let wl_inner = wl_task.clone();
                    let cancel_token_inner = cancel_token_task.clone();
                    let cache_inner = cache_task.clone();

                    tauri::async_runtime::spawn(async move {
                        if cancel_token_inner.is_cancelled() {
                            return;
                        }

                        let _permit = tokio::select! {
                            res = sem_inner.acquire() => res.ok(),
                            _ = cancel_token_inner.cancelled() => None,
                        };

                        if _permit.is_none() {
                            return;
                        }

                        let cancel_token_blocking = cancel_token_inner.clone();
                        let size = tauri::async_runtime::spawn_blocking(move || {
                            calculate_dir_size(&dir_path_inner, &wl_inner, &cancel_token_blocking)
                        })
                        .await
                        .unwrap_or(0);

                        if cancel_token_inner.is_cancelled() {
                            return;
                        }

                        // Save size to cache
                        {
                            let mut cache = cache_inner.lock().unwrap();
                            cache.insert(entry_path_inner.clone(), size);
                        }

                        let update_event = DiskEvent::EntryUpdated {
                            scan_path: scan_path_inner,
                            path: entry_path_inner,
                            size,
                        };
                        app_inner.emit("disk-event", &update_event).ok();
                    });
                }

                entries_count += 1;
                if entries_count.is_multiple_of(10) {
                    let progress_event = DiskEvent::Progress {
                        current_path: path_for_task.clone(),
                        entries_count,
                    };
                    app_clone.emit("disk-event", &progress_event).ok();
                }
            }

            let duration_ms = start_time.elapsed().as_millis() as u64;
            let completed_event = DiskEvent::Completed {
                path: path_for_task.clone(),
                total_entries: entries_count,
                duration_ms,
            };
            app_clone.emit("disk-event", &completed_event).ok();
        }));

        // If the task panicked, emit an error event
        if result.is_err() {
            let event = DiskEvent::Error {
                path: path_for_task.clone(),
                message: "Disk analysis task panicked internally".to_string(),
            };
            app_clone.emit("disk-event", &event).ok();
        }
    });

    Ok(())
}

/// 获取磁盘使用概况
#[command]
pub async fn get_disk_usage(path: Option<String>) -> Result<DiskUsage, String> {
    let target_path = if let Some(ref p) = path {
        if p.is_empty() || p == "/" {
            #[cfg(windows)]
            {
                PathBuf::from("/")
            }
            #[cfg(not(windows))]
            dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
        } else {
            #[cfg(windows)]
            {
                let mut win_p = p.replace('/', "\\");
                if win_p.len() == 2 && win_p.ends_with(':') {
                    win_p.push('\\');
                }
                PathBuf::from(win_p)
            }
            #[cfg(not(windows))]
            PathBuf::from(p)
        }
    } else {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
    };

    #[cfg(windows)]
    {
        if path.as_deref().unwrap_or("").is_empty() || path.as_deref().unwrap_or("") == "/" {
            let drives = get_windows_drives();
            let mut total = 0;
            let mut used = 0;
            let mut available = 0;
            for drive in drives {
                if let Ok(usage) = get_disk_usage_for_path(&drive) {
                    total += usage.total;
                    used += usage.used;
                    available += usage.available;
                }
            }
            return Ok(DiskUsage {
                total,
                used,
                available,
                mount_point: "此电脑".to_string(),
            });
        }

        use std::os::windows::ffi::OsStrExt;

        extern "system" {
            fn GetDiskFreeSpaceExW(
                lpDirectoryName: *const u16,
                lpFreeBytesAvailableToCaller: *mut u64,
                lpTotalNumberOfBytes: *mut u64,
                lpTotalNumberOfFreeBytes: *mut u64,
            ) -> i32;
        }

        let mut path_utf16: Vec<u16> = target_path.as_os_str().encode_wide().collect();
        path_utf16.push(0);

        let mut free_bytes_available: u64 = 0;
        let mut total_bytes: u64 = 0;
        let mut total_free_bytes: u64 = 0;

        let res = unsafe {
            GetDiskFreeSpaceExW(
                path_utf16.as_ptr(),
                &mut free_bytes_available,
                &mut total_bytes,
                &mut total_free_bytes,
            )
        };

        if res != 0 {
            let total = total_bytes;
            let available = free_bytes_available;
            let used = total.saturating_sub(available);
            return Ok(DiskUsage {
                total,
                used,
                available,
                mount_point: target_path.to_string_lossy().to_string(),
            });
        }
    }

    #[cfg(target_os = "macos")]
    {
        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        use objc2::{msg_send, ClassType, Message};
        use objc2_foundation::{ns_string, NSArray, NSString, NSURL};

        let path_str = target_path.to_string_lossy().to_string();
        let result = unsafe {
            || -> Option<DiskUsage> {
                let url_path = NSString::from_str(&path_str);
                let url: Retained<NSURL> = msg_send![NSURL::class(), fileURLWithPath: &*url_path];
                let keys = NSArray::from_retained_slice(&[
                    ns_string!("NSURLVolumeTotalCapacityKey").retain(),
                    ns_string!("NSURLVolumeAvailableCapacityForImportantUsageKey").retain(),
                ]);
                let mut error: *mut objc2_foundation::NSError = std::ptr::null_mut();
                let values: Option<Retained<AnyObject>> =
                    msg_send![&url, resourceValuesForKeys: &*keys, error: &mut error];

                let dict = values?;
                let total_obj: Option<Retained<AnyObject>> =
                    msg_send![&dict, objectForKey: ns_string!("NSURLVolumeTotalCapacityKey")];
                let avail_obj: Option<Retained<AnyObject>> = msg_send![&dict, objectForKey: ns_string!("NSURLVolumeAvailableCapacityForImportantUsageKey")];

                let total_obj = total_obj?;
                let avail_obj = avail_obj?;

                let total: i64 = msg_send![&total_obj, longLongValue];
                let available: i64 = msg_send![&avail_obj, longLongValue];

                let total = total as u64;
                let available = available as u64;
                let used = total.saturating_sub(available);

                Some(DiskUsage {
                    total,
                    used,
                    available,
                    mount_point: path_str.clone(),
                })
            }()
        };

        if let Some(usage) = result {
            return Ok(usage);
        }
    }

    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::mem;

        let path_cstr = match CString::new(target_path.to_string_lossy().as_ref()) {
            Ok(c) => c,
            Err(_) => return Err("Target path contains null byte".to_string()),
        };
        unsafe {
            let mut stat: libc::statfs = mem::zeroed();
            if libc::statfs(path_cstr.as_ptr(), &mut stat) == 0 {
                let block_size = stat.f_bsize as u64;
                let total = stat.f_blocks as u64 * block_size;
                let available = stat.f_bavail as u64 * block_size;
                let used = total - available;

                return Ok(DiskUsage {
                    total,
                    used,
                    available,
                    mount_point: target_path.to_string_lossy().to_string(),
                });
            }
        }
    }

    Err("Failed to get disk usage".to_string())
}

/// 递归计算目录大小（带字节上限，超过限制后提前返回）
fn calculate_dir_size_limited(path: &Path, limit: u64, wl: &Whitelist) -> u64 {
    let mut total: u64 = 0;

    // Pre-compile global excludes once
    let compiled_excludes: Vec<(glob::Pattern, bool)> = wl
        .global_excludes
        .iter()
        .filter(|pat| !wl.disabled_patterns.contains(*pat))
        .filter_map(|pat| {
            glob::Pattern::new(&pat.replace('\\', "/")).ok().map(|p| {
                let eye_open = wl.show_in_disk_analysis.contains(pat);
                (p, eye_open)
            })
        })
        .collect();

    let mut walker = WalkDir::new(path).follow_links(false).into_iter();
    while let Some(entry) = walker.next() {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let p = entry.path();

        if let Some(show) = check_exclude_optimized(p, &compiled_excludes) {
            if !show {
                if p.is_dir() {
                    walker.skip_current_dir();
                }
                continue;
            }
        }

        // Use std::fs::symlink_metadata to avoid following symlinks and get accurate file type
        if let Ok(metadata) = std::fs::symlink_metadata(p) {
            // Skip symlinks - they don't consume significant disk space
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_file() {
                // Use actual disk usage (blocks * 512) to handle sparse files correctly
                total += get_file_size(&metadata);
                if total >= limit {
                    return total;
                }
            }
        }
    }
    total
}

/// 递归计算目录大小（无限制，完整准确）
fn calculate_dir_size(path: &Path, wl: &Whitelist, cancel_token: &CancellationToken) -> u64 {
    let mut total: u64 = 0;

    // Pre-compile global excludes once
    let compiled_excludes: Vec<(glob::Pattern, bool)> = wl
        .global_excludes
        .iter()
        .filter(|pat| !wl.disabled_patterns.contains(*pat))
        .filter_map(|pat| {
            glob::Pattern::new(&pat.replace('\\', "/")).ok().map(|p| {
                let eye_open = wl.show_in_disk_analysis.contains(pat);
                (p, eye_open)
            })
        })
        .collect();

    let mut walker = WalkDir::new(path).follow_links(false).into_iter();
    while let Some(entry) = walker.next() {
        if cancel_token.is_cancelled() {
            return 0;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let p = entry.path();

        if let Some(show) = check_exclude_optimized(p, &compiled_excludes) {
            if !show {
                if p.is_dir() {
                    walker.skip_current_dir();
                }
                continue;
            }
        }

        if let Ok(metadata) = std::fs::symlink_metadata(p) {
            if !metadata.file_type().is_symlink() && metadata.is_file() {
                total += get_file_size(&metadata);
            }
        }
    }
    total
}

/// 计算目录的直接子条目数量
fn count_children(path: &Path) -> u64 {
    std::fs::read_dir(path)
        .map(|rd| rd.count() as u64)
        .unwrap_or(0)
}

/// 删除指定的文件或目录
/// When `safe_mode` is true, files are moved to trash instead of being permanently deleted.
#[command]
pub async fn delete_path(
    state: tauri::State<'_, DiskAnalysisState>,
    path: String,
    safe_mode: Option<bool>,
) -> Result<bool, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    let use_safe_mode = safe_mode.unwrap_or(true);

    // Invalidate the deleted path and all its ancestor directories in the size cache
    {
        let mut cache = state.size_cache.lock().unwrap();
        let mut current = Some(p.as_path());
        while let Some(ancestor) = current {
            let ancestor_str = ancestor.to_string_lossy().to_string();
            cache.remove(&ancestor_str);
            current = ancestor.parent();
        }
    }

    if use_safe_mode {
        // Safe mode: move to trash using platform provider
        let platform = crate::platform::create_platform_provider();
        tokio::task::spawn_blocking(move || platform.move_to_trash(&p).map_err(|e| e.to_string()))
            .await
            .map_err(|e| format!("Spawn blocking error: {}", e))?
            .map(|_| true)
    } else {
        tokio::task::spawn_blocking(move || {
            // If it's a symlink, delete the symlink itself, not the target directory contents
            if let Ok(metadata) = std::fs::symlink_metadata(&p) {
                if metadata.file_type().is_symlink() {
                    return std::fs::remove_file(&p).map_err(|e| e.to_string());
                }
            }
            if p.is_dir() {
                std::fs::remove_dir_all(&p).map_err(|e| e.to_string())
            } else {
                std::fs::remove_file(&p).map_err(|e| e.to_string())
            }
        })
        .await
        .map_err(|e| format!("Spawn blocking error: {}", e))?
        .map(|_| true)
    }
}

/// 清空磁盘分析大小缓存
#[command]
pub async fn clear_disk_analysis_cache(
    state: tauri::State<'_, DiskAnalysisState>,
) -> Result<(), String> {
    let mut cache = state.size_cache.lock().unwrap();
    cache.clear();
    Ok(())
}

/// 在系统文件管理器中打开指定路径
#[command]
pub async fn open_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    #[cfg(target_os = "macos")]
    {
        let status = if p.is_dir() {
            std::process::Command::new("open").arg(&p).status()
        } else {
            std::process::Command::new("open")
                .arg("-R")
                .arg(&p)
                .status()
        };
        match status {
            Ok(s) if s.success() => Ok(()),
            Ok(s) => Err(format!("Command 'open' failed with exit status: {}", s)),
            Err(e) => Err(format!("Failed to execute 'open': {}", e)),
        }
    }

    #[cfg(target_os = "windows")]
    {
        let status = if p.is_dir() {
            std::process::Command::new("explorer").arg(&p).status()
        } else {
            std::process::Command::new("explorer")
                .arg(format!("/select,{}", p.display()))
                .status()
        };
        match status {
            Ok(_) => Ok(()),
            Err(e) => Err(format!("Failed to execute 'explorer': {}", e)),
        }
    }

    #[cfg(target_os = "linux")]
    {
        let target = if p.is_dir() {
            p.clone()
        } else {
            p.parent().unwrap_or(&p).to_path_buf()
        };
        let status = std::process::Command::new("xdg-open").arg(&target).status();
        match status {
            Ok(s) if s.success() => Ok(()),
            Ok(s) => Err(format!("Command 'xdg-open' failed with exit status: {}", s)),
            Err(e) => Err(format!("Failed to execute 'xdg-open': {}", e)),
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("Unsupported platform".to_string())
    }
}

/// 获取当前操作系统平台名称
#[command]
pub fn get_platform() -> &'static str {
    crate::core::rules::current_platform()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    pub has_permission: bool,
    pub is_admin: bool,
    pub platform: String,
}

/// 检查当前的系统磁盘访问与管理员权限状态
#[command]
pub async fn check_disk_permissions() -> Result<PermissionStatus, String> {
    let platform = std::env::consts::OS.to_string();

    #[cfg(target_os = "macos")]
    {
        // On macOS, try to read the restricted /Library/SystemMigration directory
        // to detect whether we have Full Disk Access.
        let has_fda = std::path::Path::new("/Library/SystemMigration")
            .read_dir()
            .is_ok();
        Ok(PermissionStatus {
            has_permission: has_fda,
            is_admin: false,
            platform,
        })
    }

    #[cfg(target_os = "windows")]
    {
        extern "system" {
            fn IsUserAnAdmin() -> i32;
        }
        let is_admin = unsafe { IsUserAnAdmin() != 0 };
        Ok(PermissionStatus {
            has_permission: is_admin,
            is_admin,
            platform,
        })
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(PermissionStatus {
            has_permission: true,
            is_admin: true,
            platform,
        })
    }
}

/// 打开系统对应的权限设置页面或向导
#[command]
pub async fn open_system_settings_pane() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
            .status();
        match status {
            Ok(s) if s.success() => Ok(()),
            Ok(s) => Err(format!("Command 'open' failed with exit status: {}", s)),
            Err(e) => Err(format!("Failed to execute 'open': {}", e)),
        }
    }

    #[cfg(target_os = "windows")]
    {
        let status = std::process::Command::new("cmd")
            .args(["/C", "start", "useraccountcontrolsettings"])
            .status();
        match status {
            Ok(_) => Ok(()),
            Err(e) => Err(format!("Failed to launch UAC settings: {}", e)),
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(())
    }
}
