/** NDJSON event types matching Rust CleanEvent enum */

export interface ScanStartedEvent {
  type: "scan_started";
  op_id: string;
  timestamp: string;
}

export interface FileDiscoveredEvent {
  type: "file_discovered";
  op_id: string;
  path: string;
  size: number;
  rule_id: string;
  group: string;
  scan_path: string;
}

export interface ScanProgressEvent {
  type: "scan_progress";
  op_id: string;
  scanned_files: number;
  total_size: number;
  current_rule: string;
}

export interface ScanCompletedEvent {
  type: "scan_completed";
  op_id: string;
  total_files: number;
  total_size: number;
  duration_ms: number;
}

export interface CleanProgressEvent {
  type: "clean_progress";
  op_id: string;
  deleted_files: number;
  freed_bytes: number;
  current_path: string;
}

export interface CleanCompletedEvent {
  type: "clean_completed";
  op_id: string;
  total_deleted: number;
  total_freed: number;
  duration_ms: number;
}

export interface ErrorEvent {
  type: "error";
  op_id: string;
  message: string;
  recoverable: boolean;
}

export interface CancelledEvent {
  type: "cancelled";
  op_id: string;
}

export type CleanEvent =
  | ScanStartedEvent
  | FileDiscoveredEvent
  | ScanProgressEvent
  | ScanCompletedEvent
  | CleanProgressEvent
  | CleanCompletedEvent
  | ErrorEvent
  | CancelledEvent;
