use std::path::Path;

use super::PlatformError;

/// Format a file size in bytes to a human-readable string.
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
