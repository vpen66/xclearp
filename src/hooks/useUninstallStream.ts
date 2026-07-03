/** Hook: manages uninstall event stream and state machine */

import { useState, useEffect, useRef, useCallback } from "react";
import {
  listenToUninstallEvents,
  listApps as ipcListApps,
  scanApp as ipcScanApp,
  uninstallApp as ipcUninstallApp,
  cancelUninstall as ipcCancelUninstall,
} from "../lib/ipc";
import type {
  InstalledApp,
  AppFileGroup,
  UninstallPhase,
  UninstallMode,
  UninstallDeleteProgress,
  UninstallSummary,
  OfficialUninstallerPhase,
} from "../types/uninstall";

export interface UseUninstallStreamReturn {
  phase: UninstallPhase;
  apps: InstalledApp[];
  appsLoading: boolean;
  selectedApp: InstalledApp | null;
  fileGroups: AppFileGroup[];
  isScanning: boolean;
  deleteProgress: UninstallDeleteProgress | null;
  uninstallSummary: UninstallSummary | null;
  officialUninstallerPhase: OfficialUninstallerPhase;
  error: string | null;
  loadApps: () => Promise<void>;
  refreshApps: () => Promise<void>;
  selectAndScan: (app: InstalledApp) => Promise<void>;
  startUninstall: (
    app: InstalledApp,
    mode: UninstallMode,
    residualPaths: string[],
    safeMode?: boolean,
  ) => Promise<void>;
  cancelOperation: () => Promise<void>;
  resetToSelect: () => void;
  goBackToSelect: () => void;
  setFileGroups: (groups: AppFileGroup[]) => void;
}

export function useUninstallStream(): UseUninstallStreamReturn {
  const [phase, setPhase] = useState<UninstallPhase>("select");
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [appsLoading, setAppsLoading] = useState(false);
  const [selectedApp, setSelectedApp] = useState<InstalledApp | null>(null);
  const [fileGroups, setFileGroups] = useState<AppFileGroup[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [deleteProgress, setDeleteProgress] =
    useState<UninstallDeleteProgress | null>(null);
  const [uninstallSummary, setUninstallSummary] =
    useState<UninstallSummary | null>(null);
  const [officialUninstallerPhase, setOfficialUninstallerPhase] =
    useState<OfficialUninstallerPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const opIdRef = useRef<string | null>(null);
  const appsLoadedRef = useRef(false);
  const loadingRef = useRef(false);

  // Deduplicate apps by composite key (name + appPath)
  const deduplicateApps = (apps: InstalledApp[]): InstalledApp[] => {
    const seen = new Set<string>();
    return apps.filter((app) => {
      const key = `${app.name.toLowerCase()}::${app.appPath.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  // Listen to uninstall events (for delete progress)
  useEffect(() => {
    let active = true;
    let unlistenFn: (() => void) | null = null;

    listenToUninstallEvents((evt) => {
      if (!active) return;
      if (opIdRef.current && evt.op_id !== opIdRef.current) return;

      switch (evt.type) {
        case "official_uninstaller_started":
          setOfficialUninstallerPhase("running");
          break;

        case "official_uninstaller_completed":
          setOfficialUninstallerPhase("completed");
          break;

        case "residual_scan_started":
          setOfficialUninstallerPhase("scanning_residuals");
          break;

        case "delete_progress":
          setDeleteProgress({
            deletedFiles: (evt.deleted_files as number) ?? 0,
            freedBytes: (evt.freed_bytes as number) ?? 0,
            currentPath: (evt.current_path as string) ?? "",
          });
          break;

        case "uninstall_completed":
          setUninstallSummary({
            totalDeleted: (evt.total_deleted as number) ?? 0,
            totalFreed: (evt.total_freed as number) ?? 0,
            durationMs: (evt.duration_ms as number) ?? 0,
          });
          setPhase("done");
          opIdRef.current = null;
          setOfficialUninstallerPhase("idle");
          // Refresh app list after uninstall
          refreshApps();
          break;

        case "uninstall_error":
          setError(evt.message as string);
          break;

        case "uninstall_cancelled":
          setPhase("review");
          opIdRef.current = null;
          setOfficialUninstallerPhase("idle");
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

  const loadApps = useCallback(async () => {
    if (appsLoadedRef.current || loadingRef.current) return;
    appsLoadedRef.current = true;
    loadingRef.current = true;
    setAppsLoading(true);
    setError(null);
    try {
      const result = await ipcListApps();
      setApps(deduplicateApps(result));
    } catch (err) {
      setError(String(err));
    } finally {
      setAppsLoading(false);
      loadingRef.current = false;
    }
  }, []);

  const refreshApps = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    appsLoadedRef.current = true;
    setAppsLoading(true);
    setError(null);
    try {
      const result = await ipcListApps();
      setApps(deduplicateApps(result));
    } catch (err) {
      setError(String(err));
    } finally {
      setAppsLoading(false);
      loadingRef.current = false;
    }
  }, []);

  const selectAndScan = useCallback(async (app: InstalledApp) => {
    setSelectedApp(app);
    setFileGroups([]);
    setDeleteProgress(null);
    setUninstallSummary(null);
    setError(null);
    setPhase("scanning");
    setIsScanning(true);
    await new Promise((r) => setTimeout(r, 0));
    try {
      const groups = await ipcScanApp(app);
      setFileGroups(groups);
      setPhase("review");
    } catch (err) {
      setError(String(err));
      setPhase("select");
    } finally {
      setIsScanning(false);
    }
  }, []);

  const startUninstall = useCallback(
    async (
      app: InstalledApp,
      mode: UninstallMode,
      residualPaths: string[],
      safeMode?: boolean,
    ) => {
      setPhase("uninstalling");
      setError(null);
      setDeleteProgress(null);
      setOfficialUninstallerPhase(
        mode === "official_uninstaller" ? "running" : "idle",
      );
      opIdRef.current = null;
      try {
        const { op_id } = await ipcUninstallApp(app, mode, residualPaths, safeMode);
        opIdRef.current = op_id;
      } catch (err) {
        setError(String(err));
        setPhase("review");
        setOfficialUninstallerPhase("idle");
      }
    },
    [],
  );

  const cancelOperation = useCallback(async () => {
    if (opIdRef.current) {
      try {
        await ipcCancelUninstall(opIdRef.current);
      } catch (err) {
        setError(String(err));
      }
    }
  }, []);

  const resetToSelect = useCallback(() => {
    setPhase("select");
    setSelectedApp(null);
    setFileGroups([]);
    setDeleteProgress(null);
    setUninstallSummary(null);
    setError(null);
    setOfficialUninstallerPhase("idle");
    opIdRef.current = null;
  }, []);

  const goBackToSelect = useCallback(() => {
    setPhase("select");
    setSelectedApp(null);
    setFileGroups([]);
    setError(null);
  }, []);

  return {
    phase,
    apps,
    appsLoading,
    selectedApp,
    fileGroups,
    isScanning,
    deleteProgress,
    uninstallSummary,
    officialUninstallerPhase,
    error,
    loadApps,
    refreshApps,
    selectAndScan,
    startUninstall,
    cancelOperation,
    resetToSelect,
    goBackToSelect,
    setFileGroups,
  };
}

