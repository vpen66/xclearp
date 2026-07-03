/** Types for application deep uninstall feature */

/** An installed application discovered on the system */
export interface InstalledApp {
  name: string;
  bundleId: string;
  version: string;
  appPath: string;
  iconPath?: string;
  appSize: number;
}

/** A single residual file entry */
export interface AppFileEntry {
  path: string;
  size: number;
  isDir: boolean;
}

/** A group of residual files belonging to one category */
export interface AppFileGroup {
  category: string;
  categoryName: string;
  riskHint: string;
  files: AppFileEntry[];
  totalSize: number;
  fileCount: number;
}

/** Uninstall phase state machine */
export type UninstallPhase =
  | "select"
  | "scanning"
  | "review"
  | "uninstalling"
  | "done";

/** Uninstall event from backend */
export interface UninstallEvent {
  type: string;
  op_id: string;
  [key: string]: unknown;
}

/** Uninstall scan progress */
export interface UninstallScanProgress {
  scannedPaths: number;
  currentPath: string;
}

/** Uninstall scan summary */
export interface UninstallScanSummary {
  totalFiles: number;
  totalSize: number;
  categoriesCount: number;
  durationMs: number;
}

/** Uninstall delete progress */
export interface UninstallDeleteProgress {
  deletedFiles: number;
  freedBytes: number;
  currentPath: string;
}

/** Uninstall completion summary */
export interface UninstallSummary {
  totalDeleted: number;
  totalFreed: number;
  durationMs: number;
}

