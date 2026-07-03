/** Unified type exports and derived types */

export type { CleanEvent } from "./events";
export type {
  ScanStartedEvent,
  FileDiscoveredEvent,
  ScanProgressEvent,
  ScanCompletedEvent,
  CleanProgressEvent,
  CleanCompletedEvent,
  ErrorEvent,
  CancelledEvent,
} from "./events";
export type { CleanRule, RiskLevel } from "./rules";
export type { RuleGroup } from "./groups";
export type { FileEntry, DiskUsage, SortField } from "./disk";

/** NDJSON envelope — raw payload from Tauri event */
export interface NdjsonEnvelope {
  type: string;
  op_id: string;
  timestamp?: string;
  [key: string]: unknown;
}

/** Target selected for cleaning */
export interface ScanTarget {
  path: string;
  size: number;
  rule_id: string;
  group: string;
}

/** Aggregated scan progress */
export interface ScanProgress {
  scannedFiles: number;
  totalSize: number;
  currentRule: string;
}

/** Scan completion summary */
export interface ScanSummary {
  totalFiles: number;
  totalSize: number;
  durationMs: number;
  skippedFiles: number;
  skippedSize: number;
}

/** File discovered during scan */
export interface FileDiscovery {
  path: string;
  size: number;
  ruleId: string;
  group: string;
  scanPath: string;
}

/** Aggregated clean progress */
export interface CleanProgress {
  deletedFiles: number;
  freedBytes: number;
  currentPath: string;
}

/** Clean completion summary */
export interface CleanSummary {
  totalDeleted: number;
  totalFreed: number;
  durationMs: number;
}

/** Navigation page identifiers */
export type Page = "scan" | "disk" | "uninstall" | "settings";

