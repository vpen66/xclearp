/** UninstallView -- application deep uninstall UI with 5 phases */

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useUninstallStream } from "../hooks/useUninstallStream";
import { IconLoader, IconAlert, IconTrash, IconRefresh } from "./Icons";
import { getIconDataUrls, getFailedUninstalls, clearFailedUninstalls } from "../lib/ipc";
import { Folder, FileText, ChevronDown, ChevronRight } from "lucide-react";
import type { AppFileEntry, RiskLevel, BatchAppConfig, InstalledApp } from "../types/uninstall";
import { useI18n } from "../lib/i18n";
import { useToast } from "./Toast";

function formatSize(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

/** Tree node for directory-based display */
interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
  children: TreeNode[];
}

/** Build a directory tree from flat file entries */
function buildUninstallTree(files: AppFileEntry[]): TreeNode[] {
  // Find common path prefix
  const paths = files.filter((f) => !f.isDir).map((f) => f.path);
  if (paths.length === 0) return [];

  const splitPaths = paths.map((p) => p.split("/").filter(Boolean));
  let commonLen = 0;
  if (splitPaths.length > 0) {
    const first = splitPaths[0];
    for (let i = 0; i < first.length - 1; i++) {
      if (splitPaths.every((parts) => parts[i] === first[i])) {
        commonLen = i + 1;
      } else break;
    }
  }

  const root: TreeNode = { name: "", path: "", type: "dir", size: 0, children: [] };

  for (const f of files) {
    if (f.isDir) continue;
    const parts = f.path.split("/").filter(Boolean);
    const relative = parts.slice(commonLen);
    if (relative.length === 0) continue;

    let current = root;
    for (let i = 0; i < relative.length; i++) {
      const part = relative[i];
      const isLast = i === relative.length - 1;
      if (isLast) {
        current.children.push({
          name: part,
          path: f.path,
          type: "file",
          size: f.size,
          children: [],
        });
      } else {
        let dir = current.children.find((c) => c.name === part && c.type === "dir");
        if (!dir) {
          dir = { name: part, path: "", type: "dir", size: 0, children: [] };
          current.children.push(dir);
        }
        dir.size += f.size;
        current = dir;
      }
    }
    root.size += f.size;
  }

  // Sort: dirs first, then by size descending
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return b.size - a.size;
    });
    for (const n of nodes) {
      if (n.type === "dir") sortNodes(n.children);
    }
  };
  sortNodes(root.children);

  return root.children;
}

/** Helper: read safeMode from localStorage settings, default to true */
function getSafeMode(): boolean {
  try {
    const saved = localStorage.getItem("xclearp_settings");
    if (saved) {
      const parsed = JSON.parse(saved);
      return parsed.safeMode !== false;
    }
  } catch (e) {}
  return true;
}

/** Risk level badge styling: [textColor, bgColor] */

/** Checkbox that supports indeterminate state via ref + useEffect */
function IndeterminateCheckbox({
  checked,
  indeterminate,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 shrink-0 cursor-pointer"
    />
  );
}

/** Collect all leaf file paths from a tree node */
function collectLeafPaths(node: TreeNode): string[] {
  if (node.type === "file") return [node.path];
  return node.children.flatMap(collectLeafPaths);
}

/** Risk level badge styling: [textColor, bgColor] */
function riskBadgeClasses(level: RiskLevel): string {
  switch (level) {
    case "safe":
      return "text-green-600 bg-green-50 dark:text-green-400 dark:bg-green-900/20";
    case "medium":
      return "text-yellow-600 bg-yellow-50 dark:text-yellow-400 dark:bg-yellow-900/20";
    case "high":
      return "text-orange-600 bg-orange-50 dark:text-orange-400 dark:bg-orange-900/20";
    case "critical":
      return "text-red-600 bg-red-50 dark:text-red-400 dark:bg-red-900/20";
    default:
      return "text-gray-500 bg-gray-100 dark:text-gray-400 dark:bg-gray-800";
  }
}

function riskI18nKey(level: RiskLevel): string {
  switch (level) {
    case "safe": return "risk_safe";
    case "medium": return "risk_medium";
    case "high": return "risk_high";
    case "critical": return "risk_critical";
    default: return "risk_medium";
  }
}

export default function UninstallView({ isActive }: { isActive: boolean }) {
  const { t } = useI18n();
  const { warning } = useToast();
  const {
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
    isBatch,
    selectedApps,
    batchScanIndex,
    batchScanTotal,
    batchScanResults,
    batchUninstallIndex,
    batchUninstallTotal,
    batchUninstallAppName,
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
  } = useUninstallStream();

  const [searchQuery, setSearchQuery] = useState("");
  const [riskFilter, setRiskFilter] = useState<RiskLevel | null>(null);
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(
    new Set(),
  );
  const [uncheckedFiles, setUncheckedFiles] = useState<Set<string>>(new Set());
  const [showConfirm, setShowConfirm] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [resetTargetApp, setResetTargetApp] = useState<InstalledApp | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedTreeNodes, setExpandedTreeNodes] = useState<Set<string>>(new Set());
  const [iconDataUrls, setIconDataUrls] = useState<Record<string, string>>({});
  const [brokenIcons, setBrokenIcons] = useState<Set<string>>(new Set());
  const [checkedApps, setCheckedApps] = useState<Set<string>>(new Set());
  const [expandedBatchApps, setExpandedBatchApps] = useState<Set<string>>(new Set());
  const pendingResetRef = useRef(false);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const savedScrollTopRef = useRef(0);

  // Load apps when tab becomes active for the first time
  useEffect(() => {
    if (isActive && phase === "select") {
      loadApps();
    }
  }, [isActive, phase, loadApps]);

  // Check for persisted failed uninstalls on mount
  useEffect(() => {
    getFailedUninstalls()
      .then((failed) => {
        if (failed && failed.length > 0) {
          warning(
            t("uninstall.hasFailedUninstalls").replace("{count}", String(failed.length)),
            5000,
          );
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore scroll position when returning to select phase
  useEffect(() => {
    if (phase === "select" && listScrollRef.current && savedScrollTopRef.current > 0) {
      // Use requestAnimationFrame to ensure DOM is rendered
      requestAnimationFrame(() => {
        if (listScrollRef.current) {
          listScrollRef.current.scrollTop = savedScrollTopRef.current;
        }
      });
    }
  }, [phase]);

  // Load icon data URLs after apps are loaded
  const loadedIconPathsRef = useRef<string>("");
  useEffect(() => {
    if (apps.length === 0) return;
    const iconPaths = apps
      .map((a) => a.iconPath)
      .filter((p): p is string => !!p);
    if (iconPaths.length === 0) return;

    // Deduplicate: only load if paths changed
    const pathsKey = iconPaths.sort().join("|");
    if (pathsKey === loadedIconPathsRef.current) return;
    loadedIconPathsRef.current = pathsKey;

    getIconDataUrls(iconPaths).then((urls) => {
      setIconDataUrls(urls);
    }).catch(() => {});
  }, [apps]);

  // When file groups arrive, select all by default; auto-trigger reset if pending
  useEffect(() => {
    if (fileGroups.length > 0) {
      setSelectedCategories(new Set(fileGroups.map((g) => g.category)));
      setUncheckedFiles(new Set());
      if (pendingResetRef.current && selectedApp) {
        pendingResetRef.current = false;
        const paths: string[] = [];
        for (const group of fileGroups) {
          for (const file of group.files) {
            paths.push(file.path);
          }
        }
        startUninstall(selectedApp, "reset", paths, getSafeMode());
      }
    }
  }, [fileGroups, selectedApp, startUninstall]);

  const filteredApps = useMemo(() => {
    let result = apps;
    if (riskFilter) {
      result = result.filter((a) => a.riskLevel === riskFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.bundleId.toLowerCase().includes(q) ||
          (a.publisher && a.publisher.toLowerCase().includes(q)) ||
          (a.packageName && a.packageName.toLowerCase().includes(q)),
      );
    }
    return result;
  }, [apps, searchQuery, riskFilter]);

  const selectedPaths = useMemo(() => {
    const paths: string[] = [];
    for (const group of fileGroups) {
      if (selectedCategories.has(group.category)) {
        for (const file of group.files) {
          if (!uncheckedFiles.has(file.path)) {
            paths.push(file.path);
          }
        }
      }
    }
    return paths;
  }, [fileGroups, selectedCategories, uncheckedFiles]);

  const selectedTotalSize = useMemo(() => {
    let total = 0;
    for (const group of fileGroups) {
      if (selectedCategories.has(group.category)) {
        for (const file of group.files) {
          if (!uncheckedFiles.has(file.path)) {
            total += file.size;
          }
        }
      }
    }
    return total;
  }, [fileGroups, selectedCategories, uncheckedFiles]);

  const checkedFilesCount = useMemo(() => {
    let count = 0;
    for (const group of fileGroups) {
      if (selectedCategories.has(group.category)) {
        for (const file of group.files) {
          if (!uncheckedFiles.has(file.path)) count++;
        }
      }
    }
    return count;
  }, [fileGroups, selectedCategories, uncheckedFiles]);

  // Whether the selected app has an official uninstaller
  const hasOfficialUninstaller = useMemo(() => {
    return !!(selectedApp?.uninstallString || selectedApp?.packageManager);
  }, [selectedApp]);

  const toggleCategory = (cat: string) => {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
    // Also cascade to file selections
    const group = fileGroups.find((g) => g.category === cat);
    if (!group) return;
    const allPaths = group.files.map((f) => f.path);
    const allUnchecked = allPaths.every((p) => uncheckedFiles.has(p));
    if (allUnchecked) {
      // Check all
      setUncheckedFiles((prev) => {
        const next = new Set(prev);
        allPaths.forEach((p) => next.delete(p));
        return next;
      });
    } else {
      // Uncheck all
      setUncheckedFiles((prev) => {
        const next = new Set(prev);
        allPaths.forEach((p) => next.add(p));
        return next;
      });
    }
  };

  const selectAllInCategory = useCallback(
    (cat: string) => {
      const group = fileGroups.find((g) => g.category === cat);
      if (!group) return;
      const allPaths = group.files.map((f) => f.path);
      setUncheckedFiles((prev) => {
        const next = new Set(prev);
        allPaths.forEach((p) => next.delete(p));
        return next;
      });
      setSelectedCategories((prev) => new Set(prev).add(cat));
    },
    [fileGroups],
  );

  const invertSelectionInCategory = useCallback(
    (cat: string) => {
      const group = fileGroups.find((g) => g.category === cat);
      if (!group) return;
      const allPaths = new Set(group.files.map((f) => f.path));
      setUncheckedFiles((prev) => {
        const next = new Set<string>();
        // Keep unchecked paths that are NOT in this category
        prev.forEach((p) => {
          if (!allPaths.has(p)) next.add(p);
        });
        // Invert: files currently checked become unchecked
        allPaths.forEach((p) => {
          if (!prev.has(p)) next.add(p);
        });
        return next;
      });
    },
    [fileGroups],
  );

  const toggleFile = useCallback(
    (path: string) => {
      setUncheckedFiles((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
    },
    [],
  );

  const toggleTreeNode = useCallback(
    (node: TreeNode) => {
      const leafPaths = collectLeafPaths(node);
      const allUnchecked = leafPaths.every((p) => uncheckedFiles.has(p));
      setUncheckedFiles((prev) => {
        const next = new Set(prev);
        if (allUnchecked) {
          leafPaths.forEach((p) => next.delete(p));
        } else {
          leafPaths.forEach((p) => next.add(p));
        }
        return next;
      });
    },
    [uncheckedFiles],
  );

  const isNodeChecked = useCallback(
    (node: TreeNode): { checked: boolean; indeterminate: boolean } => {
      const leafPaths = collectLeafPaths(node);
      if (leafPaths.length === 0) return { checked: true, indeterminate: false };
      const uncheckedCount = leafPaths.filter((p) => uncheckedFiles.has(p)).length;
      if (uncheckedCount === 0) return { checked: true, indeterminate: false };
      if (uncheckedCount === leafPaths.length) return { checked: false, indeterminate: false };
      return { checked: false, indeterminate: true };
    },
    [uncheckedFiles],
  );

  const getCategoryCheckState = useCallback(
    (cat: string): { checked: boolean; indeterminate: boolean } => {
      const group = fileGroups.find((g) => g.category === cat);
      if (!group) return { checked: false, indeterminate: false };
      const allPaths = group.files.map((f) => f.path);
      if (allPaths.length === 0) return { checked: true, indeterminate: false };
      const uncheckedCount = allPaths.filter((p) => uncheckedFiles.has(p)).length;
      if (uncheckedCount === 0) return { checked: true, indeterminate: false };
      if (uncheckedCount === allPaths.length) return { checked: false, indeterminate: false };
      return { checked: false, indeterminate: true };
    },
    [fileGroups, uncheckedFiles],
  );

  const toggleExpanded = (cat: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const appKey = (app: InstalledApp) => `${app.appPath}::${app.bundleId}::${app.name}`;

  const toggleCheckApp = useCallback((app: InstalledApp) => {
    setCheckedApps((prev) => {
      const next = new Set(prev);
      const key = appKey(app);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const allFilteredChecked = filteredApps.length > 0 && filteredApps.every((a) => checkedApps.has(appKey(a)));

  const toggleAllFiltered = useCallback(() => {
    if (allFilteredChecked) {
      setCheckedApps(new Set());
    } else {
      setCheckedApps(new Set(filteredApps.map(appKey)));
    }
  }, [allFilteredChecked, filteredApps]);

  const checkedAppsList = useMemo(
    () => filteredApps.filter((a) => checkedApps.has(appKey(a))),
    [filteredApps, checkedApps],
  );

  const handleBatchNext = useCallback(() => {
    if (checkedAppsList.length === 0) return;
    batchScanApps(checkedAppsList);
  }, [checkedAppsList, batchScanApps]);

  // -- Phase: Select --
  if (phase === "select") {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-gray-100">
            {t("nav.uninstall")}
          </h2>
          <button
            onClick={() => refreshApps()}
            disabled={appsLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-700/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={t("uninstall.tooltip.refresh")}
          >
            <IconRefresh
              size={14}
              className={appsLoading ? "animate-spin" : ""}
            />
            <span>{t("uninstall.action.refresh")}</span>
          </button>
        </div>
        <p className="text-sm text-gray-400">
          {t("uninstall.subtitle")}
        </p>

        {error && (
          <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
            {error}
          </div>
        )}

        <div className="relative">
          <input
            type="text"
            placeholder={t("uninstall.search.placeholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {/* Risk level filter */}
        <div className="flex gap-1 flex-wrap">
          <button
            onClick={() => setRiskFilter(null)}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              !riskFilter ? 'bg-blue-500 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            {t('risk_all')}
          </button>
          {(['safe', 'medium', 'high', 'critical'] as const).map(level => (
            <button
              key={level}
              onClick={() => setRiskFilter(riskFilter === level ? null : level)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                riskFilter === level
                  ? riskBadgeClasses(level)
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              {t(riskI18nKey(level))}
            </button>
          ))}
        </div>

        {appsLoading ? (
          <div className="flex items-center justify-center py-12">
            <IconLoader className="animate-spin text-blue-400" />
            <span className="ml-2 text-gray-400 text-sm">
              {t("uninstall.state.scanning_apps")}
            </span>
          </div>
        ) : filteredApps.length === 0 ? (
          <div className="text-center py-12 text-gray-500 text-sm">
            {searchQuery ? t("uninstall.state.no_matching_apps") : t("uninstall.state.no_apps")}
          </div>
        ) : (
          <>
          <div ref={listScrollRef} className="space-y-1 max-h-[60vh] overflow-y-auto custom-scrollbar">
            {filteredApps.map((app) => {
              const key = appKey(app);
              const isChecked = checkedApps.has(key);
              return (
                <div
                  key={`${app.appPath}::${app.bundleId}::${app.name}`}
                  className="flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-gray-800/80 transition-colors group"
                >
                  {/* Checkbox for batch selection */}
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCheckApp(app);
                    }}
                    className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 cursor-pointer transition-colors ${
                      isChecked ? "bg-blue-600 border-blue-600" : "border-gray-600 hover:border-gray-400"
                    }`}
                  >
                    {isChecked && (
                      <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                        <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>
                  {/* App info - clickable for single-select */}
                  <button
                    onClick={() => {
                      if (listScrollRef.current) {
                        savedScrollTopRef.current = listScrollRef.current.scrollTop;
                      }
                      selectAndScan(app);
                    }}
                    className="flex-1 flex items-center gap-3 min-w-0 text-left"
                  >
                    <div className="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center text-lg font-bold text-gray-400 shrink-0 overflow-hidden">
                      {app.iconPath && iconDataUrls[app.iconPath] && !brokenIcons.has(app.iconPath) ? (
                        <img
                          src={iconDataUrls[app.iconPath]}
                          alt={app.name}
                          className="w-full h-full object-contain"
                          onError={() => {
                            setBrokenIcons((prev) => new Set(prev).add(app.iconPath!));
                          }}
                        />
                      ) : (
                        app.name.charAt(0).toUpperCase()
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-200 truncate">
                          {app.name}
                        </span>
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium leading-none shrink-0 ${riskBadgeClasses(app.riskLevel)}`}>
                          {t(riskI18nKey(app.riskLevel))}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 truncate">
                        {app.version && <span>{app.version}</span>}
                        {app.bundleId && (
                          <span className="ml-2 text-gray-600">
                            {app.bundleId}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="text-xs text-gray-500">
                        {formatSize(app.appSize)}
                      </div>
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          setResetTargetApp(app);
                          setShowResetDialog(true);
                        }}
                        className="px-2 py-1 rounded text-xs text-blue-400 border border-blue-500/40 hover:bg-blue-500/10 transition-colors cursor-pointer"
                        title={t("reset_app_desc")}
                      >
                        {t("reset_app")}
                      </span>
                    </div>
                  </button>
                </div>
              );
            })}
          </div>

          {/* Batch action bar */}
          {checkedAppsList.length > 0 && (
            <div className="sticky bottom-0 flex items-center justify-between px-4 py-3 bg-gray-900/95 backdrop-blur border border-gray-700 rounded-lg">
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-300">
                  {t("batch_selected").replace("{count}", String(checkedAppsList.length))}
                </span>
                <button
                  onClick={toggleAllFiltered}
                  className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                >
                  {allFilteredChecked ? t("deselect_all_apps") : t("select_all_apps")}
                </button>
              </div>
              <button
                onClick={handleBatchNext}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors"
              >
                {t("batch_next")}
              </button>
            </div>
          )}
          </>
        )}

        {/* Reset confirmation dialog */}
        {showResetDialog && resetTargetApp && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl">
              <h3 className="text-lg font-semibold text-gray-100 mb-3">
                {t('reset_confirm_title')}
              </h3>
              <p className="text-sm text-gray-400 mb-4">
                {t('reset_confirm_desc').replace('{name}', resetTargetApp.name)}
              </p>

              {/* Files that will be deleted */}
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mb-4">
                <p className="text-xs font-medium text-amber-400 mb-2">
                  {t('reset_will_delete')}
                </p>
                <ul className="text-xs text-amber-300/80 space-y-1">
                  <li className="flex items-start gap-2">
                    <span>•</span>
                    <span><strong>{t('reset_delete_cache')}</strong> — {t('reset_cache_desc')}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span>•</span>
                    <span><strong>{t('reset_delete_logs')}</strong> — {t('reset_logs_desc')}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span>•</span>
                    <span><strong>{t('reset_delete_temp')}</strong> — {t('reset_temp_desc')}</span>
                  </li>
                </ul>
              </div>

              {/* Files that will be kept */}
              <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-3 mb-4">
                <p className="text-xs font-medium text-green-400 mb-2">
                  {t('reset_will_keep')}
                </p>
                <ul className="text-xs text-green-300/80 space-y-1">
                  <li className="flex items-start gap-2">
                    <span>•</span>
                    <span><strong>{t('reset_keep_app')}</strong> — {t('reset_keep_app_desc')}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span>•</span>
                    <span><strong>{t('reset_keep_config')}</strong> — {t('reset_keep_config_desc')}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span>•</span>
                    <span><strong>{t('reset_keep_data')}</strong> — {t('reset_keep_data_desc')}</span>
                  </li>
                </ul>
              </div>

              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => {
                    setShowResetDialog(false);
                    setResetTargetApp(null);
                  }}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-lg transition-colors"
                >
                  {t('modal.cancel')}
                </button>
                <button
                  onClick={() => {
                    setShowResetDialog(false);
                    if (resetTargetApp) {
                      pendingResetRef.current = true;
                      selectAndScan(resetTargetApp);
                    }
                    setResetTargetApp(null);
                  }}
                  className="px-4 py-2 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
                >
                  {t('reset_confirm_btn')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // -- Phase: Scanning --
  if (phase === "scanning" && isScanning) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-gray-100">
          {t("nav.uninstall")}
        </h2>
        <div className="flex flex-col items-center justify-center py-16">
          <IconLoader className="animate-spin text-blue-400 w-8 h-8" />
          <p className="mt-4 text-gray-300 text-sm">
            {isBatch
              ? t("batch_scanning")
                  .replace("{n}", String(batchScanIndex))
                  .replace("{total}", String(batchScanTotal))
                  .replace("{app}", selectedApp?.name || "")
              : t("uninstall.state.scanning_files").replace("{app}", selectedApp?.name || "")}
          </p>
          {isBatch && batchScanTotal > 0 && (
            <div className="mt-4 w-64 h-2 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: `${(batchScanIndex / batchScanTotal) * 100}%` }}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  // -- Phase: Review (Batch) --
  if (phase === "review" && isBatch && batchScanResults.size > 0) {
    const allApps = selectedApps;
    const totalFiles = Array.from(batchScanResults.values())
      .flat()
      .reduce((s, g) => s + g.fileCount, 0);
    const totalSize = Array.from(batchScanResults.values())
      .flat()
      .reduce((s, g) => s + g.totalSize, 0);

    // Initialize all batch apps as expanded
    if (expandedBatchApps.size === 0 && allApps.length > 0) {
      setExpandedBatchApps(new Set(allApps.map((a) => appKey(a))));
    }

    const handleBatchConfirm = () => {
      const configs: BatchAppConfig[] = allApps.map((app) => {
        const key = appKey(app);
        const groups = batchScanResults.get(key) || [];
        const allPaths = groups.flatMap((g) => g.files.map((f) => f.path));
        return {
          app,
          mode: "trash_only" as const,
          residualPaths: allPaths,
          excludePaths: [],
        };
      });
      startBatchUninstall(configs, getSafeMode());
    };

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={goBackToSelect} className="text-gray-400 hover:text-gray-200 text-sm">
              &larr; {t("uninstall.action.back")}
            </button>
            <h2 className="text-xl font-semibold text-gray-100">
              {t("uninstall.review.batch_title")}
            </h2>
          </div>
        </div>

        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-400">
            {t("uninstall.review.batch_summary")
              .replace("{apps}", String(allApps.length))
              .replace("{count}", String(totalFiles))
              .replace("{size}", formatSize(totalSize))}
          </span>
        </div>

        <div className="space-y-2">
          {allApps.map((app) => {
            const key = appKey(app);
            const groups = batchScanResults.get(key) || [];
            const appTotalSize = groups.reduce((s, g) => s + g.totalSize, 0);
            const appFileCount = groups.reduce((s, g) => s + g.fileCount, 0);
            const isExpanded = expandedBatchApps.has(key);

            return (
              <div key={key} className="rounded-lg border border-gray-700/50 bg-gray-900/50 overflow-hidden">
                <div
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-800/30 transition-colors"
                  onClick={() => {
                    setExpandedBatchApps((prev) => {
                      const next = new Set(prev);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    });
                  }}
                >
                  <div className="w-8 h-8 rounded bg-gray-800 flex items-center justify-center text-sm font-bold text-gray-400 shrink-0 overflow-hidden">
                    {app.iconPath && iconDataUrls[app.iconPath] && !brokenIcons.has(app.iconPath) ? (
                      <img src={iconDataUrls[app.iconPath]} alt={app.name} className="w-full h-full object-contain" onError={() => setBrokenIcons((p) => new Set(p).add(app.iconPath!))} />
                    ) : app.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium text-gray-200 truncate block">{app.name}</span>
                  </div>
                  <span className="text-xs text-gray-400 shrink-0">
                    {appFileCount} {t("orphan.items")} · {formatSize(appTotalSize)}
                  </span>
                  <span className="text-gray-500 shrink-0">
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </span>
                </div>

                {isExpanded && groups.length > 0 && (
                  <div className="border-t border-gray-700/30 px-4 py-2 space-y-1">
                    {groups.map((g) => (
                      <div key={g.category} className="flex items-center gap-2 py-1.5 text-xs">
                        <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${riskBadgeClasses(g.riskLevel)}`}>
                          {t(riskI18nKey(g.riskLevel))}
                        </span>
                        <span className="text-gray-300">
                          {(() => {
                            const k = `uninstall.category.${g.category}`;
                            const v = t(k);
                            return v === k ? g.categoryName : v;
                          })()}
                        </span>
                        <span className="text-gray-500 ml-auto">
                          {g.fileCount} {t("orphan.items")} · {formatSize(g.totalSize)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {isExpanded && groups.length === 0 && (
                  <div className="border-t border-gray-700/30 px-4 py-2 text-xs text-gray-500">
                    {t("uninstall.state.no_residuals")}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            onClick={goBackToSelect}
            className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
          >
            {t("modal.cancel")}
          </button>
          <button
            onClick={handleBatchConfirm}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-500 transition-colors flex items-center gap-2"
          >
            <IconTrash />
            {t("uninstall.action.uninstall")} ({allApps.length})
          </button>
        </div>
      </div>
    );
  }

  // -- Phase: Review --
  if (phase === "review") {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={goBackToSelect}
              className="text-gray-400 hover:text-gray-200 text-sm"
            >
              &larr; {t("uninstall.action.back")}
            </button>
            <h2 className="text-xl font-semibold text-gray-100">
              {t("uninstall.review.title").replace("{app}", selectedApp?.name || "")}
            </h2>
          </div>
        </div>

        {error && (
          <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
            {error}
          </div>
        )}

        {fileGroups.length > 0 && (
          <>
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400">
                {t("uninstall.review.summary")
                  .replace("{count}", String(fileGroups.reduce((s, g) => s + g.fileCount, 0)))
                  .replace("{size}", formatSize(fileGroups.reduce((s, g) => s + g.totalSize, 0)))}
              </span>
              <span className="text-blue-400 font-medium">
                {t("uninstall.review.selected_size").replace("{size}", formatSize(selectedTotalSize))}
                {checkedFilesCount < fileGroups.reduce((s, g) => s + g.fileCount, 0) && (
                  <span className="ml-2 text-xs text-gray-500">
                    ({t("uninstall.selected_count").replace("{count}", String(checkedFilesCount))})
                  </span>
                )}
              </span>
            </div>

            <div className="space-y-2">
              {/* Risk Level Legend */}
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800/40 border border-gray-700/40 text-xs">
                <span className="text-gray-400 font-medium shrink-0">{t("risk_legend")}:</span>
                <span className={`px-2 py-0.5 rounded-full font-medium ${riskBadgeClasses("safe")}`}>{t("risk_safe")}</span>
                <span className={`px-2 py-0.5 rounded-full font-medium ${riskBadgeClasses("medium")}`}>{t("risk_medium")}</span>
                <span className={`px-2 py-0.5 rounded-full font-medium ${riskBadgeClasses("high")}`}>{t("risk_high")}</span>
                <span className={`px-2 py-0.5 rounded-full font-medium ${riskBadgeClasses("critical")}`}>{t("risk_critical")}</span>
              </div>

              {fileGroups.map((group) => (
                <div
                  key={group.category}
                  className="rounded-lg border border-gray-700/50 bg-gray-900/50 overflow-hidden"
                >
                  <div className="flex items-center gap-3 px-4 py-3">
                    {(() => {
                      const catState = getCategoryCheckState(group.category);
                      return (
                        <IndeterminateCheckbox
                          checked={catState.checked}
                          indeterminate={catState.indeterminate}
                          onChange={() => toggleCategory(group.category)}
                        />
                      );
                    })()}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {(group.riskLevel === "high" || group.riskLevel === "critical") && (
                          <IconAlert className="w-3.5 h-3.5 text-orange-400 shrink-0" />
                        )}
                        <span className="text-sm font-medium text-gray-200">
                          {(() => {
                            const key = `uninstall.category.${group.category}`;
                            const val = t(key);
                            return val === key ? group.categoryName : val;
                          })()}
                        </span>
                        <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium leading-none ${riskBadgeClasses(group.riskLevel)}`}>
                          {t(riskI18nKey(group.riskLevel))}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500">
                        {(() => {
                          const key = `uninstall.risk.${group.category}`;
                          const val = t(key);
                          return val === key ? group.riskHint : val;
                        })()}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => selectAllInCategory(group.category)}
                        className="text-[11px] text-blue-400 hover:text-blue-300 hover:underline"
                      >
                        {t("uninstall.select_all")}
                      </button>
                      <button
                        onClick={() => invertSelectionInCategory(group.category)}
                        className="text-[11px] text-gray-400 hover:text-gray-200 hover:underline"
                      >
                        {t("uninstall.deselect_all")}
                      </button>
                    </div>
                    <div className="text-xs text-gray-400 shrink-0">
                      {t("scan.status.files_count").replace("{count}", String(group.fileCount))} / {formatSize(group.totalSize)}
                    </div>
                    <button
                      onClick={() => toggleExpanded(group.category)}
                      className="text-gray-500 hover:text-gray-300 text-xs shrink-0"
                    >
                      {expandedGroups.has(group.category) ? t("uninstall.review.collapse") : t("uninstall.review.expand")}
                    </button>
                  </div>

                  {expandedGroups.has(group.category) && (
                    <div className="border-t border-gray-700/30 max-h-64 overflow-y-auto custom-scrollbar">
                      {(() => {
                        const tree = buildUninstallTree(group.files);
                        const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
                          const nodeKey = `${group.category}::${node.path || node.name}::${depth}`;
                          if (node.type === "file") {
                            return (
                              <div
                                key={node.path}
                                className="flex items-center gap-2 py-1.5 px-3 hover:bg-gray-800/30 transition-colors"
                                style={{ paddingLeft: `${depth * 16 + 12}px` }}
                              >
                                <IndeterminateCheckbox
                                  checked={!uncheckedFiles.has(node.path)}
                                  indeterminate={false}
                                  onChange={() => toggleFile(node.path)}
                                />
                                <FileText className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                                <span className="text-xs text-gray-300 truncate flex-1" title={node.path}>
                                  {node.name}
                                </span>
                                <span className="text-[10px] text-gray-500 font-mono shrink-0">
                                  {formatSize(node.size)}
                                </span>
                              </div>
                            );
                          }
                          const isExpanded = expandedTreeNodes.has(nodeKey);
                          return (
                            <div key={nodeKey}>
                              <div
                                className="flex items-center gap-2 py-1.5 px-3 hover:bg-gray-800/30 cursor-pointer transition-colors"
                                style={{ paddingLeft: `${depth * 16 + 12}px` }}
                              >
                                {(() => {
                                  const dirState = isNodeChecked(node);
                                  return (
                                    <IndeterminateCheckbox
                                      checked={dirState.checked}
                                      indeterminate={dirState.indeterminate}
                                      onChange={() => toggleTreeNode(node)}
                                    />
                                  );
                                })()}
                                <span className="text-gray-500" onClick={() => {
                                  const next = new Set(expandedTreeNodes);
                                  if (next.has(nodeKey)) next.delete(nodeKey);
                                  else next.add(nodeKey);
                                  setExpandedTreeNodes(next);
                                }}>
                                  {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                </span>
                                <Folder className="w-3.5 h-3.5 text-amber-500/80 shrink-0" />
                                <span className="text-xs font-medium text-gray-200 truncate flex-1" onClick={() => {
                                  const next = new Set(expandedTreeNodes);
                                  if (next.has(nodeKey)) next.delete(nodeKey);
                                  else next.add(nodeKey);
                                  setExpandedTreeNodes(next);
                                }}>
                                  {node.name}
                                </span>
                                <span className="text-[10px] text-gray-500 font-mono shrink-0">
                                  {formatSize(node.size)}
                                </span>
                              </div>
                              {isExpanded && (
                                <div>
                                  {node.children.map((child) => renderNode(child, depth + 1))}
                                </div>
                              )}
                            </div>
                          );
                        };
                        return tree.map((node) => renderNode(node, 0));
                      })()}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                onClick={goBackToSelect}
                className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
              >
                {t("modal.cancel")}
              </button>
              <button
                onClick={() => setShowConfirm(true)}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-500 transition-colors flex items-center gap-2"
              >
                <IconTrash />
                {t("uninstall.action.uninstall")}
              </button>
            </div>
          </>
        )}

        {fileGroups.length === 0 && (
          <div className="text-center py-8 text-gray-500 text-sm">
            {t("uninstall.state.no_residuals")}
          </div>
        )}

        {fileGroups.length === 0 && (
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              onClick={goBackToSelect}
              className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
            >
              {t("modal.cancel")}
            </button>
            <button
              onClick={() => setShowConfirm(true)}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-500 transition-colors flex items-center gap-2"
            >
              <IconTrash />
              {t("uninstall.action.uninstall")}
            </button>
          </div>
        )}

        {/* Confirm dialog with two options */}
        {showConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl">
              <div className="flex items-start gap-3">
                <IconAlert className="text-yellow-500 mt-0.5" />
                <div>
                  <h3 className="text-base font-semibold text-gray-100">
                    {t("uninstall.confirm.dialog.title")}
                  </h3>
                  <p className="text-sm text-gray-400 mt-1">
                    {t("uninstall.confirm.dialog.desc")}
                  </p>
                  {selectedPaths.length > 0 && (
                    <p className="text-xs text-gray-500 mt-2">
                      {t("uninstall.confirm.dialog.selected")
                        .replace("{count}", String(selectedPaths.length))
                        .replace("{size}", formatSize(selectedTotalSize))}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-2 mt-6">
                <button
                  onClick={() => {
                    setShowConfirm(false);
                    if (selectedApp) {
                      startUninstall(selectedApp, "trash_only", [], getSafeMode());
                    }
                  }}
                  className="w-full px-4 py-2.5 rounded-lg text-sm font-medium text-gray-200 bg-gray-800 hover:bg-gray-700 transition-colors"
                >
                  {t("uninstall.action.uninstall_only")}
                </button>
                <button
                  onClick={() => {
                    setShowConfirm(false);
                    if (selectedApp) {
                      startUninstall(selectedApp, "trash_only", selectedPaths, getSafeMode());
                    }
                  }}
                  disabled={selectedPaths.length === 0}
                  className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {t("uninstall.action.uninstall_clean")}
                </button>
                {hasOfficialUninstaller && (
                  <button
                    onClick={() => {
                      setShowConfirm(false);
                      if (selectedApp) {
                        startUninstall(selectedApp, "official_uninstaller", selectedPaths, getSafeMode());
                      }
                    }}
                    className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-orange-600 text-white hover:bg-orange-500 transition-colors"
                  >
                    {t("uninstall.action.official_clean")}
                  </button>
                )}
                <button
                  onClick={() => setShowConfirm(false)}
                  className="w-full px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
                >
                  {t("modal.cancel")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // -- Phase: Uninstalling --
  if (phase === "uninstalling") {
    const progress = deleteProgress;
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-gray-100">
          {t("nav.uninstall")}
        </h2>
        <div className="flex flex-col items-center justify-center py-12">
          <IconLoader className="animate-spin text-blue-400 w-8 h-8" />
          <p className="mt-4 text-gray-300 text-sm">
            {isBatch
              ? t("batch_uninstalling")
                  .replace("{n}", String(batchUninstallIndex))
                  .replace("{total}", String(batchUninstallTotal))
                  .replace("{app}", batchUninstallAppName)
              : officialUninstallerPhase === "running"
                ? t("uninstall.state.official_running")
                : officialUninstallerPhase === "completed"
                  ? t("uninstall.state.official_completed")
                  : officialUninstallerPhase === "scanning_residuals"
                    ? t("uninstall.state.scanning_residuals")
                    : t("uninstall.state.deleting")}
          </p>
          {isBatch && batchUninstallTotal > 0 && (
            <div className="mt-4 w-64 h-2 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: `${(batchUninstallIndex / batchUninstallTotal) * 100}%` }}
              />
            </div>
          )}
          {!isBatch && progress && (
            <div className="mt-2 text-xs text-gray-500">
              {t("uninstall.completed.deleted_files").replace("{count}", String(progress.deletedFiles))}，{t("uninstall.completed.released").replace("{size}", formatSize(progress.freedBytes))}
            </div>
          )}
          {progress?.currentPath && !isBatch && (
            <div className="mt-1 text-xs text-gray-600 truncate max-w-md">
              {progress.currentPath}
            </div>
          )}
          <button
            onClick={cancelOperation}
            className="mt-6 px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800"
          >
            {t("modal.cancel")}
          </button>
        </div>
      </div>
    );
  }

  // -- Phase: Done --
  if (phase === "done") {
    const failedItems = uninstallSummary?.failedItems;
    const hasFailed = failedItems && failedItems.length > 0;

    // Clear persisted failed records when all succeeded
    if (!hasFailed && uninstallSummary) {
      clearFailedUninstalls().catch(() => {});
    }

    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-gray-100">
          {t("nav.uninstall")}
        </h2>

        {error && (
          <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
            {error}
          </div>
        )}

        <div className="flex flex-col items-center justify-center py-12">
          <div className={`w-12 h-12 rounded-full flex items-center justify-center mb-4 ${
            hasFailed ? "bg-yellow-500/20" : "bg-green-500/20"
          }`}>
            {hasFailed ? (
              <svg
                className="w-6 h-6 text-yellow-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
                />
              </svg>
            ) : (
              <svg
                className="w-6 h-6 text-green-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            )}
          </div>
          <h3 className="text-lg font-medium text-gray-100">
            {hasFailed ? t("uninstall_partial") : t("uninstall.completed.title")}
          </h3>
          {isBatch && (
            <p className="text-sm text-blue-400 mt-1">
              {t("batch_summary").replace("{count}", String(selectedApps.length))}
            </p>
          )}
          {uninstallSummary && (
            <div className="mt-2 text-sm text-gray-400 text-center">
              <p>
                {t("uninstall.completed.deleted_files").replace("{count}", String(uninstallSummary.totalDeleted))}
              </p>
              <p>
                {t("uninstall.completed.released").replace("{size}", formatSize(uninstallSummary.totalFreed))}
              </p>
              <p className="text-xs text-gray-600 mt-1">
                {t("uninstall.completed.duration").replace("{duration}", String(uninstallSummary.durationMs))}
              </p>
            </div>
          )}

          {hasFailed && (
            <div className="mt-4 w-full max-w-md">
              <div className="px-4 py-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
                <p className="text-sm text-yellow-400 font-medium mb-2">
                  {t("uninstall_partial")} ({failedItems.length})
                </p>
                <div className="max-h-40 overflow-y-auto custom-scrollbar space-y-1">
                  {failedItems.map((item, idx) => (
                    <div key={idx} className="text-xs text-yellow-300/80 break-all">
                      <span className="font-mono">{item.path}</span>
                      <span className="text-yellow-500/70 ml-1">({item.error})</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="mt-6 flex items-center gap-3">
            {hasFailed && (
              <button
                onClick={() => retryFailedItems(getSafeMode())}
                className="px-5 py-2.5 rounded-lg text-sm font-medium bg-yellow-600 text-white hover:bg-yellow-500 transition-colors flex items-center gap-2"
              >
                <IconRefresh size={14} />
                {t("uninstall_retry")}
              </button>
            )}
            <button
              onClick={resetToSelect}
              className="px-6 py-2.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors"
            >
              {t("uninstall.action.done")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
