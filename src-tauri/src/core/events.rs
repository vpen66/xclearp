use serde::Serialize;

use crate::commands::disk::FileEntry;

/// Events emitted during disk analysis operations.
/// Serialized with `#[serde(tag = "type")]` and emitted via Tauri event "disk-event".
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DiskEvent {
    #[serde(rename_all = "camelCase")]
    EntryDiscovered { scan_path: String, entry: FileEntry },
    #[serde(rename_all = "camelCase")]
    EntryUpdated {
        scan_path: String,
        path: String,
        size: u64,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        current_path: String,
        entries_count: u64,
    },
    #[serde(rename_all = "camelCase")]
    Completed {
        path: String,
        total_entries: u64,
        duration_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    Error { path: String, message: String },
}

/// Events emitted during scan and clean operations.
/// These are serialized as NDJSON and streamed to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum CleanEvent {
    #[serde(rename = "scan_started")]
    ScanStarted { op_id: String, timestamp: String },
    #[serde(rename = "file_discovered")]
    FileDiscovered {
        op_id: String,
        path: String,
        size: u64,
        rule_id: String,
        group: String,
        scan_path: String,
    },
    #[serde(rename = "scan_progress")]
    ScanProgress {
        op_id: String,
        scanned_files: u64,
        total_size: u64,
        current_rule: String,
    },
    #[serde(rename = "scan_completed")]
    ScanCompleted {
        op_id: String,
        total_files: u64,
        total_size: u64,
        duration_ms: u64,
        skipped_files: u64,
        skipped_size: u64,
    },
    #[serde(rename = "clean_progress")]
    CleanProgress {
        op_id: String,
        deleted_files: u64,
        freed_bytes: u64,
        current_path: String,
    },
    #[serde(rename = "clean_completed")]
    CleanCompleted {
        op_id: String,
        total_deleted: u64,
        total_freed: u64,
        duration_ms: u64,
    },
    #[serde(rename = "error")]
    Error {
        op_id: String,
        message: String,
        recoverable: bool,
    },
    #[serde(rename = "cancelled")]
    Cancelled { op_id: String },
}

#[allow(dead_code)]
impl CleanEvent {
    /// Returns the operation ID associated with this event.
    pub fn op_id(&self) -> &str {
        match self {
            CleanEvent::ScanStarted { op_id, .. }
            | CleanEvent::FileDiscovered { op_id, .. }
            | CleanEvent::ScanProgress { op_id, .. }
            | CleanEvent::ScanCompleted { op_id, .. }
            | CleanEvent::CleanProgress { op_id, .. }
            | CleanEvent::CleanCompleted { op_id, .. }
            | CleanEvent::Error { op_id, .. }
            | CleanEvent::Cancelled { op_id } => op_id,
        }
    }

    /// Serialize this event to a JSON line (NDJSON format).
    pub fn to_ndjson_line(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }
}

/// Events emitted during application uninstall operations.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum UninstallEvent {
    #[serde(rename = "app_scan_started")]
    AppScanStarted { op_id: String, app_name: String },
    #[serde(rename = "category_discovered")]
    CategoryDiscovered {
        op_id: String,
        category: String,
        file_count: u64,
        total_size: u64,
        risk_hint: String,
    },
    #[serde(rename = "app_scan_progress")]
    AppScanProgress {
        op_id: String,
        scanned_paths: u64,
        current_path: String,
    },
    #[serde(rename = "app_scan_completed")]
    AppScanCompleted {
        op_id: String,
        total_files: u64,
        total_size: u64,
        categories_count: u64,
        duration_ms: u64,
    },
    #[serde(rename = "app_move_started")]
    AppMoveStarted { op_id: String, app_path: String },
    #[serde(rename = "official_uninstaller_started")]
    OfficialUninstallerStarted { op_id: String, command: String },
    #[serde(rename = "official_uninstaller_completed")]
    OfficialUninstallerCompleted {
        op_id: String,
        exit_code: i32,
        duration_ms: u64,
    },
    #[serde(rename = "residual_scan_started")]
    ResidualScanStarted { op_id: String },
    #[serde(rename = "delete_progress")]
    DeleteProgress {
        op_id: String,
        deleted_files: u64,
        freed_bytes: u64,
        current_path: String,
    },
    #[serde(rename = "uninstall_completed")]
    UninstallCompleted {
        op_id: String,
        total_deleted: u64,
        total_freed: u64,
        duration_ms: u64,
    },
    #[serde(rename = "uninstall_error")]
    UninstallError {
        op_id: String,
        message: String,
        recoverable: bool,
    },
    #[serde(rename = "uninstall_cancelled")]
    UninstallCancelled { op_id: String },
}

#[allow(dead_code)]
impl UninstallEvent {
    pub fn op_id(&self) -> &str {
        match self {
            UninstallEvent::AppScanStarted { op_id, .. }
            | UninstallEvent::CategoryDiscovered { op_id, .. }
            | UninstallEvent::AppScanProgress { op_id, .. }
            | UninstallEvent::AppScanCompleted { op_id, .. }
            | UninstallEvent::AppMoveStarted { op_id, .. }
            | UninstallEvent::OfficialUninstallerStarted { op_id, .. }
            | UninstallEvent::OfficialUninstallerCompleted { op_id, .. }
            | UninstallEvent::ResidualScanStarted { op_id, .. }
            | UninstallEvent::DeleteProgress { op_id, .. }
            | UninstallEvent::UninstallCompleted { op_id, .. }
            | UninstallEvent::UninstallError { op_id, .. }
            | UninstallEvent::UninstallCancelled { op_id } => op_id,
        }
    }
}
