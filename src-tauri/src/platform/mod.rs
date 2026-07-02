pub mod common;
pub mod linux;
pub mod macos;
pub mod windows;

use std::path::{Path, PathBuf};

use crate::core::rules::CleanRule;

/// Error type for platform-specific operations.
#[derive(Debug, Clone)]
pub struct PlatformError {
    pub message: String,
    pub path: Option<PathBuf>,
}

impl std::fmt::Display for PlatformError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(ref path) = self.path {
            write!(f, "{}: {}", path.display(), self.message)
        } else {
            write!(f, "{}", self.message)
        }
    }
}

impl std::error::Error for PlatformError {}

/// Permission status for a given path.
#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
pub enum PermissionStatus {
    /// Full read/write access.
    Granted,
    /// Read-only access.
    ReadOnly,
    /// No access at all.
    Denied,
    /// Access requires elevated privileges.
    NeedsElevation,
}

/// Platform abstraction trait (strategy pattern).
/// Each OS implements this trait to provide platform-specific behavior.
#[allow(dead_code)]
pub trait PlatformProvider: Send + Sync {
    /// Return the default cleaning rules for this platform.
    fn default_rules(&self) -> Vec<CleanRule>;

    /// Resolve a path pattern (e.g. "~/Library/Caches") to an absolute path.
    fn resolve_path(&self, pattern: &str) -> Option<PathBuf>;

    /// Check permissions for a given path.
    fn check_permission(&self, path: &Path) -> PermissionStatus;

    /// Safely remove a file or directory (move to trash if possible).
    fn safe_remove(&self, path: &Path) -> Result<(), PlatformError>;

    /// Empty the system trash/recycle bin.
    fn empty_trash(&self) -> Result<(), PlatformError>;

    /// Return a list of known cache directories on this platform.
    fn cache_dirs(&self) -> Vec<PathBuf>;

    /// Return a list of known temp directories on this platform.
    fn temp_dirs(&self) -> Vec<PathBuf>;

    /// Return the platform name.
    fn name(&self) -> &str;
}

/// Factory function to create the appropriate platform provider.
pub fn create_platform_provider() -> Box<dyn PlatformProvider + Send + Sync> {
    if cfg!(target_os = "macos") {
        Box::new(macos::MacOSProvider::new())
    } else if cfg!(target_os = "windows") {
        Box::new(windows::WindowsProvider::new())
    } else if cfg!(target_os = "linux") {
        Box::new(linux::LinuxProvider::new())
    } else {
        // Fallback to Linux implementation
        Box::new(linux::LinuxProvider::new())
    }
}
