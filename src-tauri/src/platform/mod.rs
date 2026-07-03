pub mod common;
pub mod linux;
pub mod macos;
pub mod windows;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::core::event_bus::UninstallEventBus;
use crate::core::rules::CleanRule;
use crate::core::uninstall::{AppFileGroup, InstalledApp};

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

    /// Move a file or directory to the system trash.
    fn move_to_trash(&self, path: &Path) -> Result<(), PlatformError>;

    /// Empty the system trash/recycle bin.
    fn empty_trash(&self) -> Result<(), PlatformError>;

    /// Return a list of known cache directories on this platform.
    fn cache_dirs(&self) -> Vec<PathBuf>;

    /// Return a list of known temp directories on this platform.
    fn temp_dirs(&self) -> Vec<PathBuf>;

    /// Return the platform name.
    fn name(&self) -> &str;

    /// List all installed applications on this platform.
    fn list_installed_apps(&self) -> Vec<InstalledApp>;

    /// Scan residual files for a given installed application.
    fn scan_app_residuals(
        &self,
        app: &InstalledApp,
        event_bus: &Arc<UninstallEventBus>,
        op_id: &str,
    ) -> Vec<AppFileGroup>;

    /// Invoke the platform-native uninstall mechanism (e.g. UninstallString on Windows,
    /// package manager on Linux). Returns Err on platforms that do not support it.
    fn uninstall_app_native(&self, app: &InstalledApp) -> Result<(), PlatformError>;

    /// Whether the given app has an official uninstaller available.
    fn supports_official_uninstall(&self, app: &InstalledApp) -> bool;
}

/// Factory function to create the appropriate platform provider.
#[cfg(target_os = "macos")]
pub fn create_platform_provider() -> Box<dyn PlatformProvider + Send + Sync> {
    Box::new(macos::MacOSProvider::new())
}

#[cfg(target_os = "windows")]
pub fn create_platform_provider() -> Box<dyn PlatformProvider + Send + Sync> {
    Box::new(windows::WindowsProvider::new())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn create_platform_provider() -> Box<dyn PlatformProvider + Send + Sync> {
    Box::new(linux::LinuxProvider::new())
}
