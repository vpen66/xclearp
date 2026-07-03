/** Hook: manages clean event stream and state */

import { useState, useEffect, useRef, useCallback } from "react";
import { listenToEvents, startClean as ipcStartClean, cancelOperation } from "../lib/ipc";
import type {
  NdjsonEnvelope,
  CleanProgress,
  CleanSummary,
  ScanTarget,
} from "../types/index";

export interface UseCleanStreamReturn {
  isCleaning: boolean;
  cleanProgress: CleanProgress | null;
  cleanSummary: CleanSummary | null;
  startClean: (targets: ScanTarget[], safeMode?: boolean) => Promise<void>;
  cancelClean: () => Promise<void>;
  error: string | null;
  totalTargets: number;
  resetCleanState: () => void;
}

export function useCleanStream(onFileDeleted?: (path: string) => void): UseCleanStreamReturn {
  const [isCleaning, setIsCleaning] = useState(false);
  const [cleanProgress, setCleanProgress] = useState<CleanProgress | null>(null);
  const [cleanSummary, setCleanSummary] = useState<CleanSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [totalTargets, setTotalTargets] = useState(0);
  const opIdRef = useRef<string | null>(null);
  const totalFilesRef = useRef<number>(0);
  const onFileDeletedRef = useRef(onFileDeleted);

  useEffect(() => {
    onFileDeletedRef.current = onFileDeleted;
  }, [onFileDeleted]);

  useEffect(() => {
    let active = true;
    let unlistenFn: (() => void) | null = null;

    listenToEvents((evt: NdjsonEnvelope) => {
      if (!active) return;
      console.log("[useCleanStream listener] received event:", evt, "opIdRef.current:", opIdRef.current);
      if (opIdRef.current && evt.op_id !== opIdRef.current) {
        console.warn("[useCleanStream listener] ignoring event due to opId mismatch");
        return;
      }

      switch (evt.type) {
        case "clean_progress":
          const currentPath = evt.current_path as string;
          setCleanProgress({
            deletedFiles: evt.deleted_files as number,
            freedBytes: evt.freed_bytes as number,
            currentPath,
          });
          if (onFileDeletedRef.current) {
            onFileDeletedRef.current(currentPath);
          }
          break;

        case "clean_completed":
          setCleanSummary({
            totalDeleted: evt.total_deleted as number,
            totalFreed: evt.total_freed as number,
            durationMs: evt.duration_ms as number,
          });
          setIsCleaning(false);
          opIdRef.current = null;
          break;

        case "error":
          setError(evt.message as string);
          if (!(evt.recoverable as boolean)) {
            setIsCleaning(false);
            opIdRef.current = null;
          }
          break;

        case "cancelled":
          setIsCleaning(false);
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

  const startClean = useCallback(async (targets: ScanTarget[], safeMode?: boolean) => {
    console.log("[useCleanStream hook] startClean called with targets:", targets, "safeMode:", safeMode);
    setError(null);
    setCleanProgress(null);
    setCleanSummary(null);
    setTotalTargets(targets.length);
    totalFilesRef.current = targets.length;
    setIsCleaning(true);
    opIdRef.current = null;
    try {
      console.log("[useCleanStream hook] calling ipcStartClean...");
      const { op_id } = await ipcStartClean(targets, safeMode);
      console.log("[useCleanStream hook] ipcStartClean resolved with op_id:", op_id);
      opIdRef.current = op_id;
    } catch (err) {
      console.error("[useCleanStream hook] ipcStartClean rejected with error:", err);
      setError(String(err));
      setIsCleaning(false);
    }
  }, []);

  const cancelClean = useCallback(async () => {
    if (opIdRef.current) {
      try {
        await cancelOperation(opIdRef.current);
      } catch (err) {
        setError(String(err));
      }
    }
  }, []);

  const resetCleanState = useCallback(() => {
    setError(null);
    setCleanProgress(null);
    setCleanSummary(null);
    setTotalTargets(0);
  }, []);

  return {
    isCleaning,
    cleanProgress,
    cleanSummary,
    startClean,
    cancelClean,
    error,
    totalTargets,
    resetCleanState,
  };
}

