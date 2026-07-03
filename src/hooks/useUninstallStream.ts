/** Hook: manages uninstall event stream and state machine */

import { useState, useEffect, useRef, useCallback } from "react";
import {
  listenToUninstallEvents,
  listApps as ipcListApps,
  scanApp as ipcScanApp,
  uninstallApp as ipcUninstallApp,
  batchUninstall as ipcBatchUninstall,
  cancelUninstall as ipcCancelUninstall,
  retryFailedItems as ipcRetryFailedItems,
} from "../lib/ipc";
import type {
  InstalledApp,
  AppFileGroup,
  UninstallPhase,
  UninstallMode,
  UninstallDeleteProgress,
  UninstallSummary,
  OfficialUninstallerPhase,
  FailedItem,
  BatchAppConfig,
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
  // Batch mode
  isBatch: boolean;
  selectedApps: InstalledApp[];
  batchScanIndex: number;
  batchScanTotal: number;
  batchScanResults: Map<string, AppFileGroup[]>;
  batchUninstallIndex: number;
  batchUninstallTotal: number;
  batchUninstallAppName: string;
  // Actions
  loadApps: () => Promise<void>;
  refreshApps: () => Promise<void>;
  selectAndScan: (app: InstalledApp) => Promise<void>;
  batchScanApps: (apps: InstalledApp[]) => Promise<void>;
  startUninstall: (
    app: InstalledApp,
    mode: UninstallMode,
    residualPaths: string[],
    safeMode?: boolean,
    excludePaths?: string[],
  ) => Promise<void>;
  startBatchUninstall: (
    configs: BatchAppConfig[],
    safeMode?: boolean,
  ) => Promise<void>;
  cancelOperation: () => Promise<void>;
  retryFailedItems: (safeMode?: boolean) => Promise<void>;
  resetToSelect: () => void;
  goBackToSelect: () => void;
  setFileGroups: (groups: AppFileGroup[]) => void;
  setIsBatch: (v: boolean) => void;
  setSelectedApps: (apps: InstalledApp[]) => void;
}

/** Compute max risk level from a set of file groups */
const riskOrder: Record<string, number> = { safe: 0, medium: 1, high: 2, critical: 3 };
const riskReverseMap: Record<number, InstalledApp["riskLevel"]> = { 0: "safe", 1: "medium", 2: "high", 3: "critical" };
function computeMaxRisk(groups: AppFileGroup[]): InstalledApp["riskLevel"] {
  const maxVal = groups.reduce((max, g) => Math.max(max, riskOrder[g.riskLevel] ?? 0), 0);
  return riskReverseMap[maxVal] ?? "safe";
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

  // Batch mode state
  const [isBatch, setIsBatch] = useState(false);
  const isBatchRef = useRef(false);
  const [selectedApps, setSelectedApps] = useState<InstalledApp[]>([]);
  const [batchScanIndex, setBatchScanIndex] = useState(0);
  const [batchScanTotal, setBatchScanTotal] = useState(0);
  const [batchScanResults, setBatchScanResults] = useState<Map<string, AppFileGroup[]>>(new Map());
  const [batchUninstallIndex, setBatchUninstallIndex] = useState(0);
  const [batchUninstallTotal, setBatchUninstallTotal] = useState(0);
  const [batchUninstallAppName, setBatchUninstallAppName] = useState("");

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
          // In batch mode, repurpose: deletedFiles=appIndex, freedBytes=totalApps, currentPath=appName
          if (isBatchRef.current) {
            setBatchUninstallIndex(((evt.deleted_files as number) ?? 0) + 1);
            setBatchUninstallAppName((evt.current_path as string) ?? "");
          }
          break;

        case "uninstall_completed":
          setUninstallSummary({
            totalDeleted: (evt.total_deleted as number) ?? 0,
            totalFreed: (evt.total_freed as number) ?? 0,
            durationMs: (evt.duration_ms as number) ?? 0,
            failedItems: (evt.failed_items as FailedItem[]) ?? undefined,
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

  // Compute max risk level from file groups
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
      // Update app risk level based on scanned file groups
      const maxRisk = computeMaxRisk(groups);
      setSelectedApp({ ...app, riskLevel: maxRisk });
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
      excludePaths?: string[],
    ) => {
      setPhase("uninstalling");
      setError(null);
      setDeleteProgress(null);
      setOfficialUninstallerPhase(
        mode === "official_uninstaller" ? "running" : "idle",
      );
      opIdRef.current = null;
      try {
        const { op_id } = await ipcUninstallApp(app, mode, residualPaths, safeMode, excludePaths);
        opIdRef.current = op_id;
      } catch (err) {
        setError(String(err));
        setPhase("review");
        setOfficialUninstallerPhase("idle");
      }
    },
    [],
  );

  const setBatchMode = useCallback((v: boolean) => {
    setIsBatch(v);
    isBatchRef.current = v;
  }, []);

  const batchScanApps = useCallback(async (apps: InstalledApp[]) => {
    setBatchMode(true);
    setBatchScanTotal(apps.length);
    setBatchScanIndex(0);
    setBatchScanResults(new Map());
    setSelectedApps(apps);
    setFileGroups([]);
    setDeleteProgress(null);
    setUninstallSummary(null);
    setError(null);
    setPhase("scanning");
    setIsScanning(true);

    const results = new Map<string, AppFileGroup[]>();
    const updatedApps: InstalledApp[] = [];
    try {
      for (let i = 0; i < apps.length; i++) {
        setBatchScanIndex(i + 1);
        setSelectedApp(apps[i]);
        const groups = await ipcScanApp(apps[i]);
        const key = `${apps[i].appPath}::${apps[i].bundleId}::${apps[i].name}`;
        results.set(key, groups);
        setBatchScanResults(new Map(results));
        // Update app risk level based on scanned file groups
        const maxRisk = computeMaxRisk(groups);
        updatedApps.push({ ...apps[i], riskLevel: maxRisk });
      }
      setSelectedApps(updatedApps);
      // After all scans complete, aggregate for review phase
      // Use the last app's groups as the "current" fileGroups for single-app compat
      const lastKey = `${apps[apps.length - 1].appPath}::${apps[apps.length - 1].bundleId}::${apps[apps.length - 1].name}`;
      setFileGroups(results.get(lastKey) || []);
      setPhase("review");
    } catch (err) {
      setError(String(err));
      setPhase("select");
    } finally {
      setIsScanning(false);
    }
  }, [setBatchMode]);

  const startBatchUninstall = useCallback(
    async (configs: BatchAppConfig[], safeMode?: boolean) => {
      setBatchMode(true);
      setPhase("uninstalling");
      setError(null);
      setDeleteProgress(null);
      setOfficialUninstallerPhase("idle");
      setBatchUninstallIndex(1);
      setBatchUninstallTotal(configs.length);
      setBatchUninstallAppName(configs[0]?.app.name || "");
      opIdRef.current = null;
      try {
        const { op_id } = await ipcBatchUninstall(configs, safeMode);
        opIdRef.current = op_id;
      } catch (err) {
        setError(String(err));
        setPhase("review");
      }
    },
    [setBatchMode],
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

  const retryFailedItems = useCallback(
    async (safeMode?: boolean) => {
      const failedItems = uninstallSummary?.failedItems;
      if (!failedItems || failedItems.length === 0) return;

      const paths = failedItems.map((item) => item.path);
      setPhase("uninstalling");
      setError(null);
      setDeleteProgress(null);
      setUninstallSummary(null);
      setOfficialUninstallerPhase("idle");
      opIdRef.current = null;
      try {
        const { op_id } = await ipcRetryFailedItems(paths, safeMode);
        opIdRef.current = op_id;
      } catch (err) {
        setError(String(err));
        setPhase("done");
        // Restore summary so user can see what failed
        setUninstallSummary({
          totalDeleted: 0,
          totalFreed: 0,
          durationMs: 0,
          failedItems,
        });
      }
    },
    [uninstallSummary],
  );

  const resetToSelect = useCallback(() => {
    setPhase("select");
    setSelectedApp(null);
    setFileGroups([]);
    setDeleteProgress(null);
    setUninstallSummary(null);
    setError(null);
    setOfficialUninstallerPhase("idle");
    opIdRef.current = null;
    setBatchMode(false);
    setSelectedApps([]);
    setBatchScanResults(new Map());
    setBatchScanIndex(0);
    setBatchScanTotal(0);
    setBatchUninstallIndex(0);
    setBatchUninstallTotal(0);
    setBatchUninstallAppName("");
  }, [setBatchMode]);

  const goBackToSelect = useCallback(() => {
    setPhase("select");
    setSelectedApp(null);
    setFileGroups([]);
    setError(null);
    setBatchMode(false);
    setSelectedApps([]);
    setBatchScanResults(new Map());
  }, [setBatchMode]);

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
    // Batch mode
    isBatch,
    selectedApps,
    batchScanIndex,
    batchScanTotal,
    batchScanResults,
    batchUninstallIndex,
    batchUninstallTotal,
    batchUninstallAppName,
    // Actions
    loadApps,
    refreshApps,
    selectAndScan,
    batchScanApps,
    startUninstall,
    startBatchUninstall,
    cancelOperation,
    retryFailedItems,
    resetToSelect,
    goBackToSelect,
    setFileGroups,
    setIsBatch: setBatchMode,
    setSelectedApps,
  };
}

