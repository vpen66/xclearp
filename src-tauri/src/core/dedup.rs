use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Path deduplicator that normalizes paths before comparison.
/// Prevents the same file from being scanned/cleaned multiple times
/// when matched by different rules.
pub struct PathDedup {
    seen: HashSet<PathBuf>,
}

impl PathDedup {
    /// Create a new deduplicator.
    pub fn new() -> Self {
        Self {
            seen: HashSet::new(),
        }
    }

    /// Try to insert a path. Returns `true` if the path was not already present.
    /// The path is normalized before insertion.
    pub fn insert(&mut self, path: &Path) -> bool {
        let normalized = normalize_path(path);
        self.seen.insert(normalized)
    }

    /// Check if a path has already been seen.
    pub fn contains(&self, path: &Path) -> bool {
        let normalized = normalize_path(path);
        self.seen.contains(&normalized)
    }

    /// Returns the number of unique paths tracked.
    pub fn len(&self) -> usize {
        self.seen.len()
    }

    /// Returns true if no paths have been tracked.
    pub fn is_empty(&self) -> bool {
        self.seen.is_empty()
    }

    /// Clear all tracked paths.
    pub fn clear(&mut self) {
        self.seen.clear();
    }
}

impl Default for PathDedup {
    fn default() -> Self {
        Self::new()
    }
}

/// Normalize a path by resolving `.` and `..` components and
/// converting to a canonical form for consistent comparison.
pub fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();

    for component in path.components() {
        match component {
            std::path::Component::CurDir => {
                // Skip `.` components
                continue;
            }
            std::path::Component::ParentDir => {
                // Handle `..` by popping the last component
                normalized.pop();
            }
            _ => {
                normalized.push(component);
            }
        }
    }

    // On case-insensitive file systems (macOS, Windows), normalize to lowercase
    // for consistent deduplication.
    if cfg!(target_os = "macos") || cfg!(target_os = "windows") {
        PathBuf::from(normalized.to_string_lossy().to_lowercase())
    } else {
        normalized
    }
}
