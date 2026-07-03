/** Types for application deep uninstall feature */

/** Risk level for a file category, indicating how safe it is to delete */
export type RiskLevel = "safe" | "medium" | "high" | "critical";

/** An installed application discovered on the system */
export interface InstalledApp {
  name: string;
  bundleId: string;
  version: string;
  appPath: string;
  iconPath?: string;
  appSize: number;
  uninstallString?: string;
  installLocation?: string;
  publisher?: string;
  packageManager?: string;
  packageName?: string;
  riskLevel: RiskLevel;
}

/** A single residual file entry */
export interface AppFileEntry {
  path: string;
  size: number;
  isDir: boolean;
}

/** A tree node for file-level checkbox selection in review phase */
export interface FileTreeNode {
  path: string;
  name: string;
  size: number;
  is_dir: boolean;
  children?: FileTreeNode[];
  checked: boolean;
}

/** A group of residual files belonging to one category */
export interface AppFileGroup {
  category: string;
  categoryName: string;
  riskHint: string;
  riskLevel: RiskLevel;
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

/** Uninstall mode for the confirmation dialog */
export type UninstallMode = "trash_only" | "official_uninstaller" | "residual_only" | "reset";

/** Official uninstaller phase during the uninstalling step */
export type OfficialUninstallerPhase =
  | "idle"
  | "running"
  | "completed"
  | "scanning_residuals";

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

/** A file/directory that failed to be deleted during uninstall */
export interface FailedItem {
  path: string;
  error: string;
}

/** Uninstall completion summary */
export interface UninstallSummary {
  totalDeleted: number;
  totalFreed: number;
  durationMs: number;
  failedItems?: FailedItem[];
}

/** Configuration for a single app within a batch uninstall operation */
export interface BatchAppConfig {
  app: InstalledApp;
  mode: UninstallMode;
  residualPaths: string[];
  excludePaths: string[];
}

/** Per-app result from a batch uninstall */
export interface BatchAppResult {
  appName: string;
  totalDeleted: number;
  totalFreed: number;
  failedCount: number;
  failedItems: Array<{ path: string; error: string }>;
  durationMs: number;
}

/** Persisted record of a failed uninstall operation */
export interface FailedUninstall {
  app_name: string;
  app_path: string;
  failed_paths: string[];
  error: string;
  timestamp: number;
}

