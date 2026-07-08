/** Hook: manages scan event stream and state */

import { useState, useEffect, useRef, useCallback } from "react";
import { listenToEvents, startScan as ipcStartScan, cancelOperation } from "../lib/ipc";
import type {
  NdjsonEnvelope,
  ScanProgress,
  ScanSummary,
  FileDiscovery,
} from "../types/index";

export interface UseScanStreamReturn {
  isScanning: boolean;
  scanProgress: ScanProgress | null;
  discoveredFiles: FileDiscovery[];
  scanSummary: ScanSummary | null;
  startScan: (ruleIds: string[]) => Promise<void>;
  cancelScan: () => Promise<void>;
  error: string | null;
  removeFile: (path: string) => void;
  removeFiles: (paths: string[]) => void;
}

export function useScanStream(): UseScanStreamReturn {
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [discoveredFiles, setDiscoveredFiles] = useState<FileDiscovery[]>([]);
  const [scanSummary, setScanSummary] = useState<ScanSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opIdRef = useRef<string | null>(null);

  // Set up event listener once on mount
  useEffect(() => {
    let active = true;
    let unlistenFn: (() => void) | null = null;

    listenToEvents((evt: NdjsonEnvelope) => {
      if (!active) return;
      // Only handle events for the current scan operation
      if (opIdRef.current && evt.op_id !== opIdRef.current) return;

      switch (evt.type) {
        case "scan_started":
          setIsScanning(true);
          setError(null);
          setScanSummary(null);
          setDiscoveredFiles([]);
          setScanProgress(null);
          break;

        case "file_discovered":
          setDiscoveredFiles((prev) => [
            ...prev,
            {
              path: evt.path as string,
              size: evt.size as number,
              ruleId: evt.rule_id as string,
              group: evt.group as string,
              scanPath: (evt.scan_path || evt.path) as string,
            },
          ]);
          break;

        case "scan_progress":
          setScanProgress({
            scannedFiles: evt.scanned_files as number,
            totalSize: evt.total_size as number,
            currentRule: evt.current_rule as string,
          });
          break;

        case "scan_completed":
          setScanSummary({
            totalFiles: evt.total_files as number,
            totalSize: evt.total_size as number,
            durationMs: evt.duration_ms as number,
            skippedFiles: (evt.skipped_files ?? 0) as number,
            skippedSize: (evt.skipped_size ?? 0) as number,
          });
          setIsScanning(false);
          opIdRef.current = null;
          break;

        case "error":
          setError(evt.message as string);
          if (!(evt.recoverable as boolean)) {
            setIsScanning(false);
            opIdRef.current = null;
          }
          break;

        case "cancelled":
          setIsScanning(false);
          opIdRef.current = null;
          break;
      }
    }).then((fn) => {
      if (!active) {
        fn();
      } else {
        unlistenFn = fn;
      }
    });

    return () => {
      active = false;
      if (unlistenFn) unlistenFn();
    };
  }, []);

  const startScan = useCallback(async (ruleIds: string[]) => {
    setError(null);
    setDiscoveredFiles([]);
    setScanProgress(null);
    setScanSummary(null);
    setIsScanning(true);
    opIdRef.current = null;
    try {
      const { op_id } = await ipcStartScan(ruleIds);
      opIdRef.current = op_id;
    } catch (err) {
      setError(String(err));
      setIsScanning(false);
    }
  }, []);

  const cancelScan = useCallback(async () => {
    if (opIdRef.current) {
      try {
        await cancelOperation(opIdRef.current);
      } catch (err) {
        setError(String(err));
      }
    }
  }, []);

  const removeFile = useCallback((path: string) => {
    let sizeToRemove = 0;
    setDiscoveredFiles((prev) =>
      prev.filter((f) => {
        if (f.path === path) {
          sizeToRemove = f.size;
          return false;
        }
        return true;
      })
    );
    setScanSummary((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        totalFiles: Math.max(0, prev.totalFiles - 1),
        totalSize: Math.max(0, prev.totalSize - sizeToRemove),
      };
    });
  }, []);

  const removeFiles = useCallback((paths: string[]) => {
    const pathsSet = new Set(paths);
    let sizeToRemove = 0;
    let filesRemovedCount = 0;
    setDiscoveredFiles((prev) =>
      prev.filter((f) => {
        if (pathsSet.has(f.path)) {
          sizeToRemove += f.size;
          filesRemovedCount += 1;
          return false;
        }
        return true;
      })
    );
    setScanSummary((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        totalFiles: Math.max(0, prev.totalFiles - filesRemovedCount),
        totalSize: Math.max(0, prev.totalSize - sizeToRemove),
      };
    });
  }, []);

  return {
    isScanning,
    scanProgress,
    discoveredFiles,
    scanSummary,
    startScan,
    cancelScan,
    error,
    removeFile,
    removeFiles,
  };
}
