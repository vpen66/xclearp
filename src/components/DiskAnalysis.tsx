/** DiskAnalysis — file-manager-style disk space explorer */

import { useState, useEffect, useRef, useCallback } from "react";
import type { FileEntry, SortField } from "../types/disk";
import type { RuleGroup, CleanRule } from "../types/index";
import { useDiskAnalysis } from "../hooks/useDiskAnalysis";
import { formatFileSize } from "../lib/ndjson";
import { getWhitelist, updateWhitelist, deletePath, openPath, getPlatform } from "../lib/ipc";
import {
  IconRefresh,
  IconHome,
  IconChevronRight,
  IconArrowUp,
  IconFolder,
  IconFile,
  IconLoader,
  IconTrash,
  IconAlert,
  IconClipboard,
  IconListPlus,
  IconChevronRightSmall,
} from "./Icons";
import {
  Globe,
  Folder,
  HardDrive,
  Code,
  Trash2,
  AlertTriangle,
  Database,
  Cpu,
  Settings as LucideSettings,
  Hammer,
  ShieldCheck,
  ExternalLink,
} from "lucide-react";
import { useToast } from "./Toast";
import { useI18n } from "../lib/i18n";

interface DiskAnalysisProps {
  groups: RuleGroup[];
  onAddRule: (rule: CleanRule) => void | Promise<void>;
}


// ─── Helpers ─────────────────────────────────────────────────────────────────

interface LevelColor {
  bg: string;
  text: string;
}


function renderGroupIcon(iconName: string, className = "w-4 h-4") {
  switch (iconName) {
    case "globe": return <Globe className={`${className} text-blue-400`} />;
    case "folder": return <Folder className={`${className} text-amber-400`} />;
    case "hard-drive": return <HardDrive className={`${className} text-purple-400`} />;
    case "code": return <Code className={`${className} text-emerald-400`} />;
    case "trash-2": return <Trash2 className={`${className} text-red-400`} />;
    case "alert-triangle": return <AlertTriangle className={`${className} text-yellow-400`} />;
    case "database": return <Database className={`${className} text-pink-400`} />;
    case "cpu": return <Cpu className={`${className} text-indigo-400`} />;
    case "settings": return <LucideSettings className={`${className} text-cyan-400`} />;
    case "hammer": return <Hammer className={`${className} text-orange-400`} />;
    default:
      if (iconName.includes("globe")) return <Globe className={`${className} text-blue-400`} />;
      if (iconName.includes("folder")) return <Folder className={`${className} text-amber-400`} />;
      if (iconName.includes("drive") || iconName.includes("hard")) return <HardDrive className={`${className} text-purple-400`} />;
      if (iconName.includes("code")) return <Code className={`${className} text-emerald-400`} />;
      if (iconName.includes("trash")) return <Trash2 className={`${className} text-red-400`} />;
      if (iconName.includes("alert") || iconName.includes("triangle")) return <AlertTriangle className={`${className} text-yellow-400`} />;
      if (iconName.includes("hammer")) return <Hammer className={`${className} text-orange-400`} />;
      return <Folder className={`${className} text-blue-400`} />;
  }
}

function formatRelativeTime(iso: string | null, t: (key: string) => string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return t("time.just_now");
  if (diffMin < 60) return t("time.minutes_ago").replace("{mins}", String(diffMin));
  if (diffHr < 24) return t("time.hours_ago").replace("{hours}", String(diffHr));
  if (diffDay === 1) return t("time.yesterday");
  if (diffDay < 7) return t("time.days_ago").replace("{days}", String(diffDay));

  const m = date.getMonth() + 1;
  const d = date.getDate();
  const y = date.getFullYear();
  return y === now.getFullYear()
    ? t("time.date_format_this_year").replace("{month}", String(m)).replace("{day}", String(d))
    : t("time.date_format_other_year").replace("{year}", String(y)).replace("{month}", String(m)).replace("{day}", String(d));
}

function isWindowsDrivePath(p: string): boolean {
  return /^[a-zA-Z]:/.test(p);
}

function buildBreadcrumbSegments(path: string, platform?: string, t?: (key: string) => string): { label: string; path: string }[] {
  const isWinPlatform = platform === "win32" || platform === "windows";
  const thisPcLabel = t ? t("disk.this_pc") : "This PC";
  if (!path || path === "/") return [{ label: isWinPlatform ? thisPcLabel : "/", path: "/" }];
  
  const normalized = path.replace(/\\/g, "/");
  const isWin = isWindowsDrivePath(normalized);
  const parts = normalized.split("/").filter(Boolean);
  
  const segs: { label: string; path: string }[] = [];
  if (isWin) {
    segs.push({ label: thisPcLabel, path: "/" });
  } else {
    segs.push({ label: "/", path: "/" });
  }
  
  let acc = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i === 0 && isWin) {
      acc = part; // e.g. "C:"
    } else {
      acc = acc ? (acc + "/" + part) : (isWin ? part : "/" + part);
    }
    segs.push({ label: part, path: acc });
  }
  return segs;
}

function makeRuleFromEntry(entry: FileEntry, groupId: string, platform: string): CleanRule {
  const isWin = platform === "win32" || platform === "windows";
  const targetPlatform = isWin ? "windows" : (platform === "darwin" || platform === "macos" ? "macos" : "linux");
  
  let cleanPath = entry.path;
  if (isWin) {
    cleanPath = cleanPath.replace(/\//g, "\\");
    // Remove leading slash if it precedes a drive letter on Windows (e.g. \C:\ -> C:\)
    if (cleanPath.startsWith("\\") && /^[a-zA-Z]:/.test(cleanPath.slice(1))) {
      cleanPath = cleanPath.slice(1);
    }
  }

  return {
    id: crypto.randomUUID(),
    name: entry.name,
    group: groupId,
    description: entry.isDir ? `Directory: ${cleanPath}` : `File: ${cleanPath}`,
    platforms: [targetPlatform as any],
    paths: [cleanPath],
    file_patterns: entry.isDir ? ["*"] : [entry.name],
    exclude_patterns: [],
    min_age_hours: null,
    max_size_mb: null,
    risk_level: "Safe",
    enabled: true,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function DiskAnalysis({ groups, onAddRule }: DiskAnalysisProps) {
  const toast = useToast();
  const { t } = useI18n();
  const {
    currentPath,
    entries,
    diskUsage,
    loading,
    error,
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
  } = useDiskAnalysis();

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    entry: FileEntry;
  } | null>(null);
  const [showGroupSubmenu, setShowGroupSubmenu] = useState(false);
  const ctxRef = useRef<HTMLDivElement>(null);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);

  // Platform state for context menu labels
  const [platform, setPlatform] = useState<string>("macos");

  useEffect(() => {
    getPlatform()
      .then((p) => setPlatform(p))
      .catch((e) => console.error("Failed to get platform:", e));
  }, []);

  const handleOpenInFileManager = useCallback(async (entry: FileEntry) => {
    try {
      await openPath(entry.path);
    } catch (e) {
      console.error("Failed to open path:", e);
      alert(t("disk.error.open_path_alert").replace("{error}", String(e)));
    }
    setCtxMenu(null);
  }, [t]);

  // Close context menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
        setShowGroupSubmenu(false);
      }
    };
    if (ctxMenu) {
      document.addEventListener("mousedown", handler);
      return () => document.removeEventListener("mousedown", handler);
    }
  }, [ctxMenu]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, entry: FileEntry) => {
      e.preventDefault();
      setShowGroupSubmenu(false);
      // Clamp to viewport
      const x = Math.min(e.clientX, window.innerWidth - 220);
      const y = Math.min(e.clientY, window.innerHeight - 200);
      setCtxMenu({ x, y, entry });
    },
    [],
  );

  const handleCopyPath = useCallback((entry: FileEntry) => {
    navigator.clipboard.writeText(entry.path);
    setCtxMenu(null);
  }, []);

  const handleAddToGroup = useCallback(
    async (entry: FileEntry, groupId: string) => {
      const rule = makeRuleFromEntry(entry, groupId, platform);
      try {
        await onAddRule(rule);
        const group = groups.find((g) => g.id === groupId);
        const groupName = group ? group.name : t("disk.target_group");
        toast.success(t("disk.toast.add_rule_success").replace("{name}", entry.name).replace("{group}", groupName));
      } catch (e) {
        console.error("Failed to add to group:", e);
        toast.error(t("disk.error.add_failed").replace("{error}", String(e)));
      }
      setCtxMenu(null);
      setShowGroupSubmenu(false);
    },
    [onAddRule, platform, groups, toast, t],
  );

  const handleAddToWhitelist = useCallback(async (entry: FileEntry) => {
    try {
      const wl = await getWhitelist();
      if (!wl.global_excludes.includes(entry.path)) {
        const updated = {
          ...wl,
          global_excludes: [...wl.global_excludes, entry.path],
        };
        await updateWhitelist(updated);
        toast.success(t("whitelist.toast.add_success").replace("{name}", entry.name));
        removeEntryLocally(entry.path);
      } else {
        toast.info(t("whitelist.toast.exists"));
      }
    } catch (e) {
      console.error("Failed to add to whitelist:", e);
      toast.error(t("disk.error.whitelist_failed"));
    }
    setCtxMenu(null);
  }, [removeEntryLocally, toast, t]);

  const handleRowClick = useCallback(
    (entry: FileEntry) => {
      console.log("[DiskAnalysis] Row clicked:", entry.name, "isDir:", entry.isDir, "path:", entry.path);
      if (entry.isDir) {
        console.log("[DiskAnalysis] Navigating to:", entry.path);
        navigateTo(entry.path);
      }
    },
    [navigateTo],
  );

  const handleBreadcrumbClick = useCallback(
    (segPath: string) => {
      if (segPath === currentPath) return;
      // Clear forward history by navigating fresh
      navigateTo(segPath);
    },
    [navigateTo, currentPath],
  );

  const usedPct = diskUsage ? Math.round((diskUsage.used / diskUsage.total) * 100) : 0;
  const currentPathSize = entries.reduce((s, e) => s + e.size, 0);
  
  // Parent size must be at least the current path size since current is a sub-directory
  const safeParentSize = Math.max(currentPathSize, parentPathSize);

  const parentPathPct = diskUsage && parentPathSize > 0
    ? Math.min(usedPct, Math.round((parentPathSize / diskUsage.total) * 100))
    : 0;

  const currentPathPct = diskUsage && currentPathSize > 0
    ? Math.max(1, Math.min(usedPct, Math.round((currentPathSize / diskUsage.total) * 100)))
    : 0;

  const remainingUsedPct = parentPathSize > 0
    ? Math.max(0, usedPct - parentPathPct)
    : Math.max(0, usedPct - currentPathPct);

  const parentColors: LevelColor = { bg: "bg-indigo-500", text: "text-indigo-400" };
  const currentColors: LevelColor = { bg: "bg-purple-500", text: "text-purple-400" };

  const breadcrumbs = buildBreadcrumbSegments(currentPath, platform, t);

  const sortLabel: Record<SortField, string> = {
    name: t("disk.table.header.name"),
    size: t("disk.table.header.size"),
    modified: t("disk.table.header.modified"),
  };

  const SortIndicator = ({ field }: { field: SortField }) => {
    const active = sortBy === field;
    const order = active ? sortOrder : "none";
    return (
      <span className="inline-flex flex-col ml-1 leading-none">
        <span
          className={`text-[8px] ${
            order === "asc"
              ? "text-blue-400 opacity-100"
              : active
                ? "text-gray-500 opacity-40"
                : "text-gray-600 opacity-25"
          }`}
        >
          ▲
        </span>
        <span
          className={`text-[8px] ${
            order === "desc"
              ? "text-blue-400 opacity-100"
              : active
                ? "text-gray-500 opacity-40"
                : "text-gray-600 opacity-25"
          }`}
        >
          ▼
        </span>
      </span>
    );
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-100 flex items-center gap-2">
          {t("nav.disk")}
          {scanStatus === "scanning" && (
            <IconLoader className="animate-spin text-blue-400" />
          )}
        </h2>
        <button
          onClick={refresh}
          className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors flex items-center gap-2"
        >
          <IconRefresh /> {t("disk.action.refresh")}
        </button>
      </div>

      {/* Disk usage overview */}
      {diskUsage && (
        <div className="px-5 py-4 rounded-xl bg-gray-800/60 border border-gray-700/40 space-y-3">
          <div className="flex items-center justify-between text-sm gap-4">
            <span className="text-gray-300 font-medium shrink-0">{t("disk.usage.title")}</span>
            <div className="flex items-center gap-3 text-xs text-gray-400 min-w-0">
              <span className="truncate" title={currentPath}>
                {currentPath}
              </span>
              <span className={`${currentColors.text} font-semibold shrink-0`}>
                {formatFileSize(currentPathSize)}
              </span>
            </div>
          </div>
          <div className="w-full h-3 bg-gray-700 rounded-full overflow-hidden flex">
            {parentPathSize > 0 && parentPathPct > 0 ? (
              <div
                className={`h-full ${parentColors.bg} transition-all duration-500 shrink-0 py-[1.5px] pr-[1.5px] pl-0 overflow-hidden flex items-center`}
                style={{ width: `${parentPathPct}%` }}
                title={`${t("disk.usage.parent_dir").replace("{size}", formatFileSize(parentPathSize))}`}
              >
                {currentPathSize > 0 && (
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      scanStatus === "scanning"
                        ? "bg-shimmer-purple animate-progress-shimmer"
                        : currentColors.bg
                    }`}
                    style={{ width: `${Math.min(100, (currentPathSize / safeParentSize) * 100)}%` }}
                    title={`${t("disk.usage.current_dir").replace("{size}", formatFileSize(currentPathSize))}`}
                  />
                )}
              </div>
            ) : (
              currentPathPct > 0 && (
                <div
                  className={`h-full transition-all duration-500 shrink-0 ${
                    scanStatus === "scanning"
                      ? "bg-shimmer-purple animate-progress-shimmer"
                      : currentColors.bg
                  }`}
                  style={{ width: `${currentPathPct}%` }}
                  title={`${t("disk.usage.current_dir").replace("{size}", formatFileSize(currentPathSize))}`}
                />
              )
            )}
            <div
              className={`h-full transition-all duration-500 ${
                usedPct > 90 ? "bg-red-500" : usedPct > 70 ? "bg-yellow-500" : "bg-blue-500"
              }`}
              style={{ width: `${remainingUsedPct}%` }}
            />
          </div>
          <div className="flex justify-between items-center text-xs text-gray-500 flex-wrap gap-y-2">
            <div className="flex items-center gap-3">
              <span>
                {t("disk.usage.used")} <span className="text-gray-300">{formatFileSize(diskUsage.used)}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${currentColors.bg} shrink-0 ${
                  scanStatus === "scanning" ? "animate-pulse" : ""
                }`} />
                {t("disk.usage.current_dir").split(":")[0].trim()} <span className={`${currentColors.text} font-medium`}>{formatFileSize(currentPathSize)}</span>
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span>
                {t("disk.usage.available")} <span className="text-gray-300">{formatFileSize(diskUsage.available)}</span>
              </span>
              <span>
                {t("disk.usage.total")} <span className="text-gray-300">{formatFileSize(diskUsage.total)}</span>
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Breadcrumb */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Up button */}
        {pathHistory.length > 0 && (
          <button
            onClick={navigateUp}
            className="shrink-0 p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
            title={t("disk.action.up_dir")}
          >
            <IconArrowUp />
          </button>
        )}
        {/* Breadcrumb */}
        <nav className="flex items-center gap-1 text-sm flex-1 min-w-0 overflow-x-auto custom-scrollbar">
          {breadcrumbs.map((seg, i) => (
            <span key={seg.path} className="flex items-center gap-1 shrink-0">
              {i > 0 && <IconChevronRight className="text-gray-600" />}
              <button
                onClick={() => handleBreadcrumbClick(seg.path)}
                className={`px-1.5 py-0.5 rounded transition-colors flex items-center gap-1 ${
                  i === breadcrumbs.length - 1
                    ? "text-gray-50 font-medium bg-gray-800"
                    : "text-gray-400 hover:text-gray-50 hover:bg-gray-800/60"
                }`}
              >
                {i === 0 ? <IconHome /> : seg.label}
              </button>
            </span>
          ))}
        </nav>
      </div>

      {/* Error */}
      {error && (
        <div className="px-5 py-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm space-y-3">
          <div className="flex items-center justify-between">
            <span className="font-semibold flex items-center gap-2">
              <IconAlert className="shrink-0 text-red-400" />
              {t("disk.error.no_access")}
            </span>
            <button
              onClick={refresh}
              className="px-3 py-1 rounded-lg text-xs bg-red-500/20 hover:bg-red-500/30 text-red-300 transition-colors font-medium"
            >
              {t("disk.action.retry")}
            </button>
          </div>
          <p className="text-xs font-mono bg-red-500/5 p-2 rounded-lg border border-red-500/10 whitespace-pre-wrap">{error}</p>
          {(error.includes("拒绝访问") || error.includes("Access is denied") || error.includes("permission denied") || error.includes("os error 5")) && (
            <div className="pt-3 border-t border-red-500/20 text-xs text-gray-400 space-y-2">
              <p className="font-semibold text-gray-200 flex items-center gap-1.5">
                <span>💡</span> {t("disk.error.junction_title")}
              </p>
              <p className="leading-relaxed">
                {t("disk.error.junction_desc1")}
              </p>
              <p className="leading-relaxed">
                {t("disk.error.junction_desc2")}
              </p>
              <p className="leading-relaxed font-medium text-gray-300">
                {t("disk.error.junction_desc3")}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Scanning progress removed - loading spinner moved to header */}

      {/* File table */}
      {loading && entries.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <IconLoader className="animate-spin text-blue-500" size={32} />
        </div>
      ) : entries.length === 0 && !error && scanStatus !== "scanning" ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <IconFolder className="text-gray-600 mb-4" size={48} />
          <p className="text-gray-400 text-sm">{t("disk.table.empty")}</p>
          <p className="text-gray-600 text-xs mt-1">{currentPath}</p>
        </div>
      ) : (
        <div className="rounded-xl bg-gray-800/40 border border-gray-700/30 overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[1fr_100px_120px] gap-2 px-4 py-2.5 text-xs font-medium border-b border-gray-700/40 bg-gray-900/40 select-none">
            {(Object.keys(sortLabel) as SortField[]).map((field) => (
              <button
                key={field}
                onClick={() => toggleSort(field)}
                className={`flex items-center transition-colors ${
                  field === "size" || field === "modified" ? "justify-end" : ""
                } ${
                  sortBy === field && sortOrder !== "none"
                    ? "text-blue-400"
                    : "text-gray-500 hover:text-gray-300"
                }`}
              >
                <span>{sortLabel[field]}</span>
                <SortIndicator field={field} />
              </button>
            ))}
          </div>

          {/* Rows */}
          <div className="max-h-[calc(100vh-380px)] overflow-y-auto custom-scrollbar">
            {entries.map((entry) => (
              <div
                key={entry.path}
                onClick={() => handleRowClick(entry)}
                onContextMenu={(e) => handleContextMenu(e, entry)}
                className={`grid grid-cols-[1fr_100px_120px] gap-2 px-4 py-3 text-sm items-center transition-colors border-b border-gray-700/20 last:border-b-0 ${
                  entry.isDir
                    ? "cursor-pointer hover:bg-gray-700/30"
                    : "cursor-default hover:bg-gray-700/20"
                }`}
              >
                {/* Name */}
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-base shrink-0 text-gray-400 relative inline-flex items-center justify-center">
                    {entry.isDir ? <IconFolder /> : <IconFile />}
                    {entry.isSymlink && (
                      <div className="absolute -bottom-1 -left-1 bg-slate-900/90 text-blue-400 border border-blue-500/50 rounded-[3px] p-[1px] shadow-md flex items-center justify-center" title={t("disk.table.symlink_tooltip")}>
                        <svg className="w-2 h-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="7" y1="17" x2="17" y2="7"></line>
                          <polyline points="7 7 17 7 17 17"></polyline>
                        </svg>
                      </div>
                    )}
                  </span>
                  <span
                    className={`truncate ${entry.isDir ? "text-blue-300 font-medium" : "text-gray-200"}`}
                    title={entry.path}
                  >
                    {entry.name}
                  </span>
                  {entry.isWhitelisted && (
                    <span title={t("disk.table.whitelisted_tip")} className="flex items-center shrink-0">
                      <ShieldCheck size={14} className="text-emerald-400" />
                    </span>
                  )}
                  {entry.isDir && entry.childrenCount !== null && (
                    <span className="text-xs text-gray-600 shrink-0">
                      {t("scan.status.items_count").replace("{count}", String(entry.childrenCount))}
                    </span>
                  )}
                </div>

                {/* Size */}
                <span className="text-right text-gray-400 text-xs">
                  {entry.isDir && entry.calculating ? (
                    <span className="text-blue-400/80 animate-pulse">{t("disk.table.calculating")}</span>
                  ) : (
                    formatFileSize(entry.size)
                  )}
                </span>

                {/* Modified */}
                <span className="text-right text-gray-500 text-xs">
                  {formatRelativeTime(entry.modified, t)}
                </span>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t border-gray-700/30 text-xs text-gray-600 flex justify-between">
            <span>{t("scan.status.items_count").replace("{count}", String(entries.length))}</span>
            <span>{formatFileSize(entries.reduce((s, e) => s + e.size, 0))}</span>
          </div>
        </div>
      )}

      {/* Context menu */}
      {ctxMenu && (
        <div
          ref={ctxRef}
          className="fixed z-50 min-w-[180px] py-1 rounded-lg bg-gray-800 border border-gray-700/60 shadow-xl shadow-black/40"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          {/* Open */}
          {ctxMenu.entry.isDir && (
            <button
              onClick={() => {
                navigateTo(ctxMenu.entry.path);
                setCtxMenu(null);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700/60 transition-colors"
            >
              <IconFolder size={16} /> {t("disk.menu.open")}
            </button>
          )}

          {/* Open in system file manager */}
          <button
            onClick={() => handleOpenInFileManager(ctxMenu.entry)}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700/60 transition-colors"
          >
            <ExternalLink size={16} className="shrink-0 text-gray-400" />
            {platform === "macos" ? t("disk.menu.open_file_manager_macos") : t("disk.menu.open_file_manager_generic")}
          </button>

          {/* Add to group rule */}
          <div className="relative">
            <button
              onClick={() => setShowGroupSubmenu((v) => !v)}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700/60 transition-colors"
            >
              <IconListPlus />
              {t("disk.menu.add_to_group")}
              <IconChevronRightSmall className="ml-auto text-gray-600" />
            </button>
            {showGroupSubmenu && (
              <div className="absolute left-full top-0 ml-1 min-w-[180px] py-1 rounded-lg bg-gray-800 border border-gray-700/60 shadow-xl shadow-black/40 z-50">
                {groups.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-gray-500">{t("disk.menu.no_groups")}</div>
                ) : (
                  groups.map((g) => (
                    <button
                      key={g.id}
                      onClick={() => handleAddToGroup(ctxMenu.entry, g.id)}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700/60 transition-colors"
                    >
                      {renderGroupIcon(g.icon, "w-4 h-4 shrink-0")}
                      <span className="truncate flex-1 text-left">{g.name}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Separator */}
          <div className="my-1 border-t border-gray-700/40" />

          {/* Add to whitelist */}
          <button
            onClick={() => handleAddToWhitelist(ctxMenu.entry)}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-emerald-400 hover:bg-emerald-500/10 transition-colors"
          >
            <ShieldCheck size={16} className="shrink-0" /> {t("disk.menu.add_to_whitelist")}
          </button>

          {/* Copy path */}
          <button
            onClick={() => handleCopyPath(ctxMenu.entry)}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700/60 transition-colors"
          >
            <IconClipboard /> {t("disk.menu.copy_path")}
          </button>

          {/* Delete */}
          <button
            onClick={() => {
              setDeleteTarget(ctxMenu.entry);
              setCtxMenu(null);
              setShowGroupSubmenu(false);
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <IconTrash size={16} /> {t("disk.menu.delete_label")}
          </button>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-sm mx-4 p-5 rounded-xl bg-gray-800 border border-gray-700/60 shadow-2xl">
            <h3 className="text-base font-semibold text-white mb-2 flex items-center gap-2">
              <IconAlert className="text-yellow-500" /> {t("disk.confirm.delete_title")}
            </h3>
            <p className="text-sm text-gray-400 mb-1">{t("disk.confirm.delete_message")}</p>
            <p className="text-sm text-gray-200 bg-gray-900/60 rounded px-3 py-2 mb-3 break-all font-mono text-xs">
              {deleteTarget.path}
            </p>
            <p className="text-xs text-red-400/80 mb-4">
              {deleteTarget.isDir
                ? t("disk.confirm.delete_dir_warning")
                : t("disk.confirm.delete_file_warning")}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-4 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
              >
                {t("modal.cancel")}
              </button>
              <button
                onClick={async () => {
                  if (deleteTarget) {
                    try {
                      const success = await deletePath(deleteTarget.path);
                      if (success) {
                        refresh();
                      }
                    } catch (e) {
                      alert(t("disk.error.delete_alert").replace("{error}", String(e)));
                    }
                  }
                  setDeleteTarget(null);
                }}
                className="px-4 py-1.5 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-500 transition-colors"
              >
                {t("modal.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
