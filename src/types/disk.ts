/** Disk analysis types matching Rust backend structs */

export interface FileEntry {
  name: string;
  path: string;
  size: number;
  isDir: boolean;
  isSymlink?: boolean;
  modified: string | null; // ISO 8601
  childrenCount: number | null; // directory child count
  calculating?: boolean;
  isWhitelisted?: boolean;
  sizeDiff?: number;
}

export interface DiskUsage {
  total: number;
  used: number;
  available: number;
  mountPoint: string;
}

export type SortField = "size" | "name" | "modified" | "sizeDiff";
export type SortOrder = "asc" | "desc" | "none";

// ─── Disk analysis streaming event types ─────────────────────────────────────

export interface DiskEntryEvent {
  type: "entryDiscovered";
  scanPath: string;
  entry: FileEntry;
}

export interface DiskEntryUpdatedEvent {
  type: "entryUpdated";
  scanPath: string;
  path: string;
  size: number;
  sizeDiff?: number;
}

export interface DiskProgressEvent {
  type: "progress";
  currentPath: string;
  entriesCount: number;
}

export interface DiskCompletedEvent {
  type: "completed";
  path: string;
  totalEntries: number;
  durationMs: number;
}

export interface DiskErrorEvent {
  type: "error";
  path: string;
  message: string;
}

export type DiskEvent =
  | DiskEntryEvent
  | DiskEntryUpdatedEvent
  | DiskProgressEvent
  | DiskCompletedEvent
  | DiskErrorEvent;
