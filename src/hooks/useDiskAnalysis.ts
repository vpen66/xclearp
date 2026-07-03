/** Hook: manages disk analysis state — streaming event-driven directory analysis */

import { useState, useEffect, useCallback, useRef } from "react";
import { startDiskAnalysis, listenToDiskEvents, getDiskUsage, getHomeDir, clearDiskAnalysisCache, getPlatform } from "../lib/ipc";
import type { FileEntry, DiskUsage, SortField, SortOrder, DiskEvent } from "../types/disk";

export interface UseDiskAnalysisReturn {
  currentPath: string;
  entries: FileEntry[];
  diskUsage: DiskUsage | null;
  loading: boolean;
  error: string | null;
  progress: { currentPath: string; entriesCount: number } | null;
  scanStatus: "idle" | "scanning" | "complete";
  navigateTo: (path: string) => Promise<void>;
  navigateUp: () => void;
  pathHistory: string[];
  refresh: () => Promise<void>;
  sortBy: SortField;
  sortOrder: SortOrder;
  toggleSort: (field: SortField) => void;
  removeEntryLocally: (path: string) => void;
  parentPathSize: number;
}

function sortEntries(entries: FileEntry[], sortBy: SortField, sortOrder: SortOrder): FileEntry[] {
  // "none" → 保持原始顺序，不排序
  if (sortOrder === "none") return [...entries];

  const dir = sortOrder === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    // Directories always first
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;

    switch (sortBy) {
      case "size":
        return (a.size - b.size) * dir;
      case "name":
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) * dir;
      case "modified": {
        const am = a.modified ?? "";
        const bm = b.modified ?? "";
        return am.localeCompare(bm) * dir;
      }
      default:
        return 0;
    }
  });
}

const BUFFER_FLUSH_INTERVAL_MS = 100;
const BUFFER_FLUSH_THRESHOLD = 50;

function normalizePath(p: string): string {
  if (!p) return "";
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// Global cache for directory sizes computed during the session
const directorySizeCache: Record<string, number> = {};

function isWindowsDrivePath(p: string): boolean {
  return /^[a-zA-Z]:/.test(p);
}

function getParentPath(path: string): string {
  if (!path || path === "/" || path === "") return "";
  
  const normalized = path.replace(/\\/g, "/");
  
  if (/^[a-zA-Z]:\/?$/.test(normalized)) {
    return "/";
  }
  
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return isWindowsDrivePath(normalized) ? "/" : "/";
  }
  
  if (isWindowsDrivePath(normalized)) {
    return parts.slice(0, -1).join("/");
  } else {
    return "/" + parts.slice(0, -1).join("/");
  }
}

export function useDiskAnalysis(): UseDiskAnalysisReturn {
  const [currentPath, setCurrentPath] = useState<string>("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [diskUsage, setDiskUsage] = useState<DiskUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pathHistory, setPathHistory] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<SortField>("size");
  const [sortOrder, setSortOrder] = useState<SortOrder>("none");
  const [progress, setProgress] = useState<{ currentPath: string; entriesCount: number } | null>(null);
  const [scanStatus, setScanStatus] = useState<"idle" | "scanning" | "complete">("idle");

  // Track the current scan path to ignore stale events
  const currentScanPathRef = useRef<string>("");

  // Buffer for batch entry updates
  const bufferRef = useRef<FileEntry[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sizeUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rawEntriesRef = useRef<FileEntry[]>([]);
  const sortByRef = useRef<SortField>(sortBy);
  const sortOrderRef = useRef<SortOrder>(sortOrder);

  // Keep refs in sync
  useEffect(() => {
    sortByRef.current = sortBy;
  }, [sortBy]);
  useEffect(() => {
    sortOrderRef.current = sortOrder;
  }, [sortOrder]);

  // Flush buffer to state
  const flushBuffer = useCallback(() => {
    if (bufferRef.current.length === 0) return;
    const batch = bufferRef.current;
    console.log(`[DiskAnalysis] Flushing ${batch.length} entries, current raw count: ${rawEntriesRef.current.length}`);
    
    // Check for duplicates in batch by path
    const seenPaths = new Set<string>();
    const uniqueBatch = batch.filter((e) => {
      if (seenPaths.has(e.path)) {
        console.warn(`[DiskAnalysis] Duplicate entry in batch: ${e.path}`);
        return false;
      }
      seenPaths.add(e.path);
      return true;
    });
    
    // Check for duplicates when merging with existing
    const existingPaths = new Set(rawEntriesRef.current.map(e => e.path));
    const trulyNew = uniqueBatch.filter(e => !existingPaths.has(e.path));
    
    if (trulyNew.length < uniqueBatch.length) {
      console.warn(`[DiskAnalysis] ${uniqueBatch.length - trulyNew.length} entries already exist in state`);
    }
    
    bufferRef.current = [];
    rawEntriesRef.current = [...rawEntriesRef.current, ...trulyNew];
    setEntries(sortEntries(rawEntriesRef.current, sortByRef.current, sortOrderRef.current));
  }, []);

  // Start periodic flush timer
  const startFlushTimer = useCallback(() => {
    if (flushTimerRef.current) clearInterval(flushTimerRef.current);
    flushTimerRef.current = setInterval(() => {
      flushBuffer();
    }, BUFFER_FLUSH_INTERVAL_MS);
  }, [flushBuffer]);

  // Stop flush timer
  const stopFlushTimer = useCallback(() => {
    if (flushTimerRef.current) {
      clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  // Set up disk event listener once on mount
  useEffect(() => {
    let active = true;
    let unlistenFn: (() => void) | null = null;

    const setup = async () => {
      const fn = await listenToDiskEvents((event: DiskEvent) => {
        if (!active) return;
        console.log("[useDiskAnalysis] RECEIVED:", event.type, "event:", event, "currentScanPathRef:", currentScanPathRef.current);
        const currentNorm = normalizePath(currentScanPathRef.current);
        switch (event.type) {
          case "entryDiscovered":
            if (normalizePath(event.scanPath) !== currentNorm) {
              console.log("[useDiskAnalysis] Ignored entryDiscovered due to mismatch:", event.scanPath, "vs", currentScanPathRef.current);
              break;
            }
            bufferRef.current.push(event.entry);
            // Flush immediately if threshold reached
            if (bufferRef.current.length >= BUFFER_FLUSH_THRESHOLD) {
              flushBuffer();
            }
            break;

          case "entryUpdated":
            if (normalizePath(event.scanPath) !== currentNorm) {
              console.log("[useDiskAnalysis] Ignored entryUpdated due to mismatch:", event.scanPath, "vs", currentScanPathRef.current);
              break;
            }
            // Also cache the sub-directory size
            directorySizeCache[normalizePath(event.path)] = event.size;
            // Update in buffer if still there
            bufferRef.current = bufferRef.current.map((e) => {
              if (e.path === event.path) {
                return { ...e, size: event.size, calculating: false };
              }
              return e;
            });
            // Update in rawEntriesRef
            let foundInRaw = false;
            rawEntriesRef.current = rawEntriesRef.current.map((e) => {
              if (e.path === event.path) {
                foundInRaw = true;
                return { ...e, size: event.size, calculating: false };
              }
              return e;
            });
            if (foundInRaw) {
              if (!sizeUpdateTimerRef.current) {
                sizeUpdateTimerRef.current = setTimeout(() => {
                  setEntries(sortEntries(rawEntriesRef.current, sortByRef.current, sortOrderRef.current));
                  sizeUpdateTimerRef.current = null;
                }, 300);
              }
            }
            break;

          case "progress":
            if (normalizePath(event.currentPath) !== currentNorm) {
              console.log("[useDiskAnalysis] Ignored progress due to mismatch:", event.currentPath, "vs", currentScanPathRef.current);
              break;
            }
            setProgress({ currentPath: event.currentPath, entriesCount: event.entriesCount });
            break;

          case "completed":
            // Only process if this is the current scan
            if (normalizePath(event.path) !== currentNorm) {
              console.log("[useDiskAnalysis] Ignored completed due to mismatch:", event.path, "vs", currentScanPathRef.current);
              break;
            }
            // Flush remaining buffer entries
            flushBuffer();
            stopFlushTimer();
            setScanStatus("complete");
            setLoading(false);
            break;

          case "error":
            // Only process if this is the current scan
            if (normalizePath(event.path) !== currentNorm) {
              console.log("[useDiskAnalysis] Ignored error due to mismatch:", event.path, "vs", currentScanPathRef.current);
              break;
            }
            flushBuffer();
            stopFlushTimer();
            setError(event.message);
            setLoading(false);
            setScanStatus("complete");
            break;
        }
      });

      if (!active) {
        fn();
      } else {
        unlistenFn = fn;
      }
    };

    setup();

    return () => {
      active = false;
      if (unlistenFn) {
        unlistenFn();
      }
      stopFlushTimer();
      if (sizeUpdateTimerRef.current) {
        clearTimeout(sizeUpdateTimerRef.current);
        sizeUpdateTimerRef.current = null;
      }
    };
  }, []); // Empty deps - only run once on mount

  // Initialize currentPath on mount
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const platform = await getPlatform();
        const isWin = platform === "win32" || platform === "windows";
        if (isWin) {
          if (mounted) {
            setCurrentPath("/");
          }
          return;
        }

        const homeDir = await getHomeDir();
        if (mounted && homeDir) {
          setCurrentPath(homeDir);
        } else if (mounted) {
          setCurrentPath("/");
        }
      } catch (err) {
        console.warn("Failed to get home dir:", err);
        if (mounted) {
          setCurrentPath("/");
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const fetchEntries = useCallback(async (path: string) => {
    console.log("[useDiskAnalysis] fetchEntries RUNNING with path:", path);
    // Update current scan path to track which scan we're processing
    currentScanPathRef.current = path;
    
    setLoading(true);
    setError(null);
    setProgress(null);
    setScanStatus("scanning");
    setEntries([]);
    rawEntriesRef.current = [];
    bufferRef.current = [];
    startFlushTimer();
    try {
      await startDiskAnalysis(path);
    } catch (err) {
      console.error("[DiskAnalysis] Error starting analysis:", err);
      setError(String(err));
      setLoading(false);
      setScanStatus("complete");
      stopFlushTimer();
    }
  }, [startFlushTimer, stopFlushTimer]);

  const fetchDiskUsage = useCallback(async (path?: string) => {
    try {
      const data = await getDiskUsage(path);
      setDiskUsage(data);
    } catch (err) {
      console.warn("getDiskUsage failed:", err);
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchDiskUsage();
  }, [fetchDiskUsage]);

  // Load entries when currentPath changes
  useEffect(() => {
    console.log("[useDiskAnalysis] useEffect for currentPath triggered:", currentPath);
    fetchEntries(currentPath);
    fetchDiskUsage(currentPath);
  }, [currentPath, fetchEntries, fetchDiskUsage]);

  // Update directory size cache with the current directory's total size
  useEffect(() => {
    if (currentPath && entries.length > 0) {
      const totalSize = entries.reduce((s, e) => s + e.size, 0);
      directorySizeCache[normalizePath(currentPath)] = totalSize;
    }
  }, [currentPath, entries]);

  const parentPath = getParentPath(currentPath);
  const parentPathSize = parentPath ? (directorySizeCache[normalizePath(parentPath)] ?? 0) : 0;

  // Re-sort when sortBy or sortOrder changes (without refetching)
  useEffect(() => {
    setEntries(sortEntries(rawEntriesRef.current, sortBy, sortOrder));
  }, [sortBy, sortOrder]);

  const toggleSort = useCallback((field: SortField) => {
    setSortBy((prevField) => {
      if (prevField === field) {
        // 同字段：none → asc → desc → none 循环
        setSortOrder((o) => {
          if (o === "none") return "asc";
          if (o === "asc") return "desc";
          return "none";
        });
      } else {
        // 新字段：默认正序
        setSortOrder("asc");
      }
      return field;
    });
  }, []);

  const navigateTo = useCallback(async (path: string) => {
    setPathHistory((prev) => [...prev, currentPath]);
    setCurrentPath(path);
  }, [currentPath]);

  const navigateUp = useCallback(() => {
    setPathHistory((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      const parent = next.pop()!;
      setCurrentPath(parent);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    if (currentPath) {
      try {
        await clearDiskAnalysisCache();
        // Clear frontend directory size cache
        for (const key in directorySizeCache) {
          delete directorySizeCache[key];
        }
      } catch (err) {
        console.warn("clearDiskAnalysisCache failed:", err);
      }
      await fetchEntries(currentPath);
    }
    await fetchDiskUsage();
  }, [currentPath, fetchEntries, fetchDiskUsage]);

  const removeEntryLocally = useCallback((path: string) => {
    rawEntriesRef.current = rawEntriesRef.current.filter((e) => e.path !== path);
    setEntries(sortEntries(rawEntriesRef.current, sortByRef.current, sortOrderRef.current));
  }, []);

  return {
    currentPath,
    entries,
    diskUsage,
    loading,
    error,
    progress,
    scanStatus,
    navigateTo,
    navigateUp,
    pathHistory,
    refresh,
    sortBy,
    sortOrder,
    toggleSort,
    removeEntryLocally,
    parentPathSize,
  };
}
