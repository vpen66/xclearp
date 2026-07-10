/** Tauri IPC wrapper — all backend communication */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { NdjsonEnvelope, ScanTarget, RuleGroup, CleanRule, FileEntry, DiskUsage } from "../types/index";
import type { DiskEvent } from "../types/disk";
import type { InstalledApp, UninstallEvent, UninstallMode, AppFileGroup, BatchAppConfig, FailedUninstall } from "../types/uninstall";
import type { StartupItem } from "../types/startup";
import type { OrphanGroup, OrphanDeleteResult } from "../types/orphan";

/** Start a scan with the given rule IDs. Returns the operation ID. */
export async function startScan(ruleIds: string[]): Promise<{ op_id: string }> {
  return invoke<{ op_id: string }>("start_scan", { ruleIds: ruleIds });
}

/** Start cleaning the given targets. Returns the operation ID.
 *  When safeMode is true, files are moved to trash instead of being permanently deleted.
 */
export async function startClean(targets: ScanTarget[], safeMode?: boolean): Promise<{ op_id: string }> {
  return invoke<{ op_id: string }>("start_clean", { targets, safeMode: safeMode ?? true });
}

/** Cancel an ongoing operation by its ID. */
export async function cancelOperation(opId: string): Promise<boolean> {
  return invoke<boolean>("cancel_operation", { opId });
}

/** Fetch all rule groups (with nested rules). */
export async function getGroups(): Promise<RuleGroup[]> {
  return invoke<RuleGroup[]>("get_groups");
}

/** Fetch all rules. */
export async function getRules(): Promise<CleanRule[]> {
  return invoke<CleanRule[]>("get_rules");
}

/** Update an existing rule. */
export async function updateRule(rule: CleanRule): Promise<boolean> {
  return invoke<boolean>("update_rule", { rule });
}

/** Add a new custom rule. */
export async function addCustomRule(rule: CleanRule): Promise<boolean> {
  return invoke<boolean>("add_custom_rule", { rule });
}

/** Delete a custom rule. */
export async function deleteRule(id: string): Promise<boolean> {
  return invoke<boolean>("delete_rule", { id });
}

/** Import custom rules from JSON. */
export async function importRules(rules: CleanRule[]): Promise<boolean> {
  return invoke<boolean>("import_rules", { rules });
}

/** Add a new custom rule group. */
export async function addGroup(name: string, description: string, icon: string): Promise<boolean> {
  return invoke<boolean>("add_group", { name, description, icon });
}

/** Delete a rule group and its custom rules. */
export async function deleteGroup(id: string): Promise<boolean> {
  return invoke<boolean>("delete_group", { id });
}

export interface Whitelist {
  global_excludes: string[];
  group_excludes: Record<string, string[]>;
  rule_excludes: Record<string, string[]>;
  disabled_patterns: string[];
  show_in_disk_analysis: string[];
}

/** Get the active whitelist from backend. */
export async function getWhitelist(): Promise<Whitelist> {
  return invoke<Whitelist>("get_whitelist");
}

/** Save and update the active whitelist on backend. */
export async function updateWhitelist(whitelist: Whitelist): Promise<boolean> {
  return invoke<boolean>("update_whitelist", { whitelist });
}

/** Delete a file or directory at the specified path.
 *  When safeMode is true, files are moved to trash instead of being permanently deleted.
 */
export async function deletePath(path: string, safeMode?: boolean): Promise<boolean> {
  return invoke<boolean>("delete_path", { path, safeMode: safeMode ?? true });
}

/** List directory contents. */
export async function listDirectory(path: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("list_directory", { path });
}

/** Get disk usage for the specified path (or default mount if omitted). */
export async function getDiskUsage(path?: string): Promise<DiskUsage> {
  return invoke<DiskUsage>("get_disk_usage", { path });
}

/** Get user's home directory path. */
export async function getHomeDir(): Promise<string> {
  // Use the mountPoint from getDiskUsage as a reasonable default
  try {
    console.log("[getHomeDir] Calling getDiskUsage...");
    const usage = await getDiskUsage();
    console.log("[getHomeDir] Got disk usage:", usage, "mountPoint:", usage?.mountPoint);
    if (usage && usage.mountPoint) {
      if (usage.mountPoint === "此电脑") {
        return "/";
      }
      return usage.mountPoint;
    }
    console.warn("[getHomeDir] mountPoint is missing, using fallback");
    return "/";
  } catch (err) {
    console.error("[getHomeDir] getDiskUsage failed:", err);
    // Fallback to root if disk usage fails
    return "/";
  }
}

/** Start disk analysis for the given path (streaming via disk-event). */
export async function startDiskAnalysis(path: string): Promise<void> {
  return invoke("start_disk_analysis", { path });
}

/** Get disk snapshot for a path (used for instant preview). */
export async function getDiskSnapshot(path: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("get_disk_snapshot", { path });
}

/** Clear the disk analysis folder size cache. */
export async function clearDiskAnalysisCache(): Promise<void> {
  return invoke("clear_disk_analysis_cache");
}

/** Clear all physical disk snapshot files. */
export async function clearDiskSnapshots(): Promise<void> {
  return invoke("clear_disk_snapshots");
}

/**
 * Listen to disk analysis streaming events from the backend.
 * The backend emits a Tauri event "disk-event" with DiskEvent payloads.
 */
export async function listenToDiskEvents(
  callback: (event: DiskEvent) => void,
): Promise<UnlistenFn> {
  return listen<DiskEvent>("disk-event", (e) => {
    callback(e.payload);
  });
}

/**
 * Listen to NDJSON events from the backend.
 * The backend emits a single Tauri event "clean-event" whose payload
 * is the parsed NdjsonEnvelope.
 */
export async function listenToEvents(
  callback: (event: NdjsonEnvelope) => void,
): Promise<UnlistenFn> {
  return listen<NdjsonEnvelope>("clean-event", (e) => {
    callback(e.payload);
  });
}

/** Open path in system file manager (Finder / File Explorer / default Linux manager). */
export async function openPath(path: string): Promise<void> {
  return invoke("open_path", { path });
}

/** Get current platform name. */
export async function getPlatform(): Promise<string> {
  return invoke<string>("get_platform");
}

export interface PermissionStatus {
  hasPermission: boolean;
  isAdmin: boolean;
  platform: string;
}

/** Check current disk permissions status (FDA on macOS, Admin on Windows) */
export async function checkDiskPermissions(): Promise<PermissionStatus> {
  return invoke<PermissionStatus>("check_disk_permissions");
}

/** Open system settings privacy pane or UAC settings */
export async function openSystemSettingsPane(): Promise<void> {
  return invoke("open_system_settings_pane");
}

// --- Uninstall commands ---

/** List all installed applications. */
export async function listApps(): Promise<InstalledApp[]> {
  return invoke<InstalledApp[]>("list_apps");
}

/** Start scanning residual files for a given app. Returns file groups directly. */
export async function scanApp(app: InstalledApp): Promise<AppFileGroup[]> {
  return invoke<AppFileGroup[]>("scan_app", { app });
}

/** Uninstall an application with the specified mode.
 *  When safeMode is true, residual files are moved to trash instead of being permanently deleted.
 *  excludePaths are paths to skip during deletion (user unchecked them in the review UI).
 */
export async function uninstallApp(
  app: InstalledApp,
  mode: UninstallMode,
  residualPaths: string[],
  safeMode?: boolean,
  excludePaths?: string[],
): Promise<{ op_id: string }> {
  return invoke<{ op_id: string }>("uninstall_app", {
    app,
    mode,
    residualPaths,
    safeMode: safeMode ?? true,
    excludePaths: excludePaths ?? [],
  });
}

/** Cancel an active uninstall operation. */
export async function cancelUninstall(opId: string): Promise<boolean> {
  return invoke<boolean>("cancel_uninstall", { opId });
}

/** Retry deleting a list of failed paths. Returns the operation ID. */
export async function retryFailedItems(
  paths: string[],
  safeMode?: boolean,
): Promise<{ op_id: string }> {
  return invoke<{ op_id: string }>("retry_failed_items", {
    paths,
    safeMode: safeMode ?? true,
  });
}

/** Listen to uninstall streaming events from the backend. */
export async function listenToUninstallEvents(
  callback: (event: UninstallEvent) => void,
): Promise<UnlistenFn> {
  return listen<UninstallEvent>("uninstall-event", (e) => {
    callback(e.payload);
  });
}

/** Batch uninstall multiple applications sequentially. */
export async function batchUninstall(
  configs: BatchAppConfig[],
  safeMode?: boolean,
): Promise<{ op_id: string }> {
  return invoke<{ op_id: string }>("batch_uninstall", {
    configs,
    safeMode: safeMode ?? true,
  });
}

/** Get persisted failed uninstall records. */
export async function getFailedUninstalls(): Promise<FailedUninstall[]> {
  return invoke<FailedUninstall[]>("get_failed_uninstalls");
}

/** Clear all persisted failed uninstall records. */
export async function clearFailedUninstalls(): Promise<void> {
  return invoke("clear_failed_uninstalls");
}

/** Get the current global uninstall state. */
export async function getUninstallState(): Promise<string> {
  return invoke<string>("get_uninstall_state");
}

/** Read icon PNG files and return base64 data URLs for browser display. */
export async function getIconDataUrls(
  paths: string[],
): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("get_icon_data_urls", { paths });
}

// --- Startup Manager commands ---

/** List all startup items on the current platform. */
export async function listStartupItems(): Promise<StartupItem[]> {
  return invoke<StartupItem[]>("list_startup_items");
}

/** Enable or disable a startup item. */
export async function toggleStartupItem(source: string, enabled: boolean): Promise<void> {
  return invoke("toggle_startup_item", { source, enabled });
}

/** Remove a startup item. */
export async function removeStartupItem(source: string): Promise<void> {
  return invoke("remove_startup_item", { source });
}

// --- Orphan file commands ---

/** Scan for orphan files left behind by uninstalled applications. */
export async function scanOrphanFiles(): Promise<OrphanGroup[]> {
  return invoke<OrphanGroup[]>("scan_orphan_files");
}

/** Quick scan: returns orphan entries immediately without computing directory sizes. */
export async function quickScanOrphanFiles(): Promise<OrphanGroup[]> {
  return invoke<OrphanGroup[]>("quick_scan_orphan_files");
}

/** Calculate full stats (size, file_count, last_modified) for the given orphan paths. */
export async function calculateOrphanStats(paths: string[]): Promise<OrphanGroup[]> {
  return invoke<OrphanGroup[]>("calculate_orphan_stats", { paths });
}

/** Delete selected orphan file paths.
 *  When safeMode is true, files are moved to trash instead of being permanently deleted.
 */
export async function deleteOrphanFiles(
  paths: string[],
  safeMode?: boolean,
): Promise<OrphanDeleteResult> {
  return invoke<OrphanDeleteResult>("delete_orphan_files", {
    paths,
    safeMode: safeMode ?? true,
  });
}

