use std::path::Path;
use std::thread;
use std::time::Duration;

use super::PlatformError;

/// Format a file size in bytes to a human-readable string.
#[allow(dead_code)]
pub fn format_file_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;
    const TB: u64 = GB * 1024;

    if bytes >= TB {
        format!("{:.2} TB", bytes as f64 / TB as f64)
    } else if bytes >= GB {
        format!("{:.2} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.2} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.2} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} B", bytes)
    }
}

/// Normalize a path string by resolving `~` and environment variables.
#[allow(dead_code)]
pub fn normalize_path_string(pattern: &str, home: &Path) -> String {
    let mut result = pattern.to_string();

    // Replace ~ with home directory
    if result.starts_with("~/") {
        result = format!("{}{}", home.display(), &result[1..]);
    } else if result == "~" {
        result = home.to_string_lossy().to_string();
    }

    // Replace environment variables like $VAR or ${VAR}
    while let Some(start) = result.find("${") {
        if let Some(end) = result[start..].find('}') {
            let var_name = &result[start + 2..start + end];
            if let Ok(value) = std::env::var(var_name) {
                result = format!(
                    "{}{}{}",
                    &result[..start],
                    value,
                    &result[start + end + 1..]
                );
            } else {
                break;
            }
        } else {
            break;
        }
    }

    result
}

/// Check if a path matches a glob pattern.
#[allow(dead_code)]
pub fn matches_glob(path: &str, pattern: &str) -> bool {
    if let Ok(pat) = glob::Pattern::new(pattern) {
        pat.matches(path)
    } else {
        false
    }
}

/// Safe remove implementation shared across platforms.
/// Attempts to remove a file or directory, handling errors gracefully.
pub fn safe_remove_impl(path: &Path, error_template: &PlatformError) -> Result<(), PlatformError> {
    if !path.exists() {
        return Ok(());
    }

    if path.is_dir() {
        std::fs::remove_dir_all(path).map_err(|e| PlatformError {
            message: format!("Failed to remove directory: {}", e),
            path: Some(path.to_path_buf()),
        })?;
    } else {
        std::fs::remove_file(path).map_err(|e| PlatformError {
            message: format!("Failed to remove file: {}", e),
            path: Some(path.to_path_buf()),
        })?;
    }

    let _ = error_template; // suppress unused warning
    Ok(())
}

/// Robust remove that walks directories and deletes files individually.
/// For directories: tries to delete as many entries as possible, skipping
/// locked/in-use files. Returns Ok with the count of skipped entries.
/// Includes a single retry with a short delay for transient file locks.
pub fn robust_remove_impl(path: &Path) -> Result<u64, PlatformError> {
    if !path.exists() {
        return Ok(0);
    }

    if !path.is_dir() {
        // Single file: try delete, retry once after short delay
        if std::fs::remove_file(path).is_err() {
            thread::sleep(Duration::from_millis(200));
            std::fs::remove_file(path).map_err(|e| PlatformError {
                message: format!("Failed to remove file after retry: {}", e),
                path: Some(path.to_path_buf()),
            })?;
        }
        return Ok(0);
    }

    // Directory: walk and delete entries individually
    let mut skipped: u64 = 0;
    robust_remove_dir(path, &mut skipped)?;

    // Try to remove the now-empty (or partially empty) directory
    if path.exists() {
        let _ = std::fs::remove_dir(path);
    }

    Ok(skipped)
}

fn robust_remove_dir(dir: &Path, skipped: &mut u64) -> Result<(), PlatformError> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => {
            *skipped += 1;
            return Ok(());
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                *skipped += 1;
                continue;
            }
        };

        let path = entry.path();

        if path.is_dir() {
            // Recurse into subdirectory
            if robust_remove_dir(&path, skipped).is_err() {
                *skipped += 1;
            } else {
                // Try to remove the now-empty subdirectory
                if path.exists() && std::fs::remove_dir(&path).is_err() {
                    // Retry once after delay
                    thread::sleep(Duration::from_millis(100));
                    let _ = std::fs::remove_dir(&path);
                }
            }
        } else {
            // Try to delete file, retry once on failure
            if std::fs::remove_file(&path).is_err() {
                thread::sleep(Duration::from_millis(100));
                if std::fs::remove_file(&path).is_err() {
                    *skipped += 1;
                }
            }
        }
    }

    Ok(())
}

/// Get the file size of a path, returning 0 if it cannot be determined.
pub fn get_file_size(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// Check if a file is older than the given number of hours.
pub fn is_file_older_than(path: &Path, hours: u64) -> bool {
    if let Ok(metadata) = std::fs::metadata(path) {
        if let Ok(modified) = metadata.modified() {
            let age = std::time::SystemTime::now()
                .duration_since(modified)
                .unwrap_or_default();
            return age.as_secs() > hours * 3600;
        }
    }
    false
}
