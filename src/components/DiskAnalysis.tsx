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

interface DiskAnalysisProps {
  groups: RuleGroup[];
  onAddRule: (rule: CleanRule) => void;
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

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return "刚刚";
  if (diffMin < 60) return `${diffMin}分钟前`;
  if (diffHr < 24) return `${diffHr}小时前`;
  if (diffDay === 1) return "昨天";
  if (diffDay < 7) return `${diffDay}天前`;

  const m = date.getMonth() + 1;
  const d = date.getDate();
  const y = date.getFullYear();
  return y === now.getFullYear() ? `${m}月${d}日` : `${y}/${m}/${d}`;
}

function buildBreadcrumbSegments(path: string): { label: string; path: string }[] {
  if (!path || path === "/") return [{ label: "/", path: "/" }];
  const parts = path.split("/").filter(Boolean);
  const segs: { label: string; path: string }[] = [{ label: "/", path: "/" }];
  let acc = "";
  for (const part of parts) {
    acc += "/" + part;
    segs.push({ label: part, path: acc });
  }
  return segs;
}

function makeRuleFromEntry(entry: FileEntry, groupId: string): CleanRule {
  return {
    id: crypto.randomUUID(),
    name: entry.name,
    group: groupId,
    description: entry.isDir ? `目录: ${entry.path}` : `文件: ${entry.path}`,
    platforms: ["macos", "linux", "windows"],
    paths: [entry.path],
    file_patterns: entry.isDir ? [] : [entry.name],
    exclude_patterns: [],
    min_age_hours: null,
    max_size_mb: null,
    risk_level: "Safe",
    enabled: true,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function DiskAnalysis({ groups, onAddRule }: DiskAnalysisProps) {
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
      alert(`无法打开路径: ${e}`);
    }
    setCtxMenu(null);
  }, []);

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
    (entry: FileEntry, groupId: string) => {
      const rule = makeRuleFromEntry(entry, groupId);
      onAddRule(rule);
      setCtxMenu(null);
      setShowGroupSubmenu(false);
    },
    [onAddRule],
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
        alert(`已将 "${entry.name}" 成功添加到全局排除白名单中，今后将忽略该路径！`);
        removeEntryLocally(entry.path);
      } else {
        alert("该路径已存在于全局排除白名单中。");
      }
    } catch (e) {
      console.error("Failed to add to whitelist:", e);
      alert("添加到白名单失败，请重试");
    }
    setCtxMenu(null);
  }, [removeEntryLocally]);

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

  const breadcrumbs = currentPath ? buildBreadcrumbSegments(currentPath) : [];

  const sortLabel: Record<SortField, string> = {
    name: "名称",
    size: "大小",
    modified: "修改时间",
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
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          磁盘分析
          {scanStatus === "scanning" && (
            <IconLoader className="animate-spin text-blue-400" />
          )}
        </h2>
        <button
          onClick={refresh}
          className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors flex items-center gap-2"
        >
          <IconRefresh /> 刷新
        </button>
      </div>

      {/* Disk usage overview */}
      {diskUsage && (
        <div className="px-5 py-4 rounded-xl bg-gray-800/60 border border-gray-700/40 space-y-3">
          <div className="flex items-center justify-between text-sm gap-4">
            <span className="text-gray-300 font-medium shrink-0">磁盘使用情况</span>
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
                title={`上一级目录: ${formatFileSize(parentPathSize)}`}
              >
                {currentPathSize > 0 && (
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      scanStatus === "scanning"
                        ? "bg-shimmer-purple animate-progress-shimmer"
                        : currentColors.bg
                    }`}
                    style={{ width: `${Math.min(100, (currentPathSize / safeParentSize) * 100)}%` }}
                    title={`当前目录: ${formatFileSize(currentPathSize)}`}
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
                  title={`当前目录: ${formatFileSize(currentPathSize)}`}
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
                已用 <span className="text-gray-300">{formatFileSize(diskUsage.used)}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${currentColors.bg} shrink-0 ${
                  scanStatus === "scanning" ? "animate-pulse" : ""
                }`} />
                当前目录 <span className={`${currentColors.text} font-medium`}>{formatFileSize(currentPathSize)}</span>
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span>
                可用 <span className="text-gray-300">{formatFileSize(diskUsage.available)}</span>
              </span>
              <span>
                总计 <span className="text-gray-300">{formatFileSize(diskUsage.total)}</span>
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
            title="返回上级目录"
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
                    ? "text-white font-medium bg-gray-800"
                    : "text-gray-400 hover:text-white hover:bg-gray-800/60"
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
        <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm flex items-center justify-between">
          <span>{error}</span>
          <button
            onClick={refresh}
            className="px-3 py-1 rounded text-xs bg-red-500/20 hover:bg-red-500/30 text-red-300 transition-colors"
          >
            重试
          </button>
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
          <p className="text-gray-400 text-sm">空目录</p>
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
                      <div className="absolute -bottom-1 -left-1 bg-slate-900/90 text-blue-400 border border-blue-500/50 rounded-[3px] p-[1px] shadow-md flex items-center justify-center" title="快捷方式/软链接">
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
                    <span title="该路径已列入全局白名单" className="flex items-center shrink-0">
                      <ShieldCheck size={14} className="text-emerald-400" />
                    </span>
                  )}
                  {entry.isDir && entry.childrenCount !== null && (
                    <span className="text-xs text-gray-600 shrink-0">
                      {entry.childrenCount} 项
                    </span>
                  )}
                </div>

                {/* Size */}
                <span className="text-right text-gray-400 text-xs">
                  {entry.isDir && entry.calculating ? (
                    <span className="text-blue-400/80 animate-pulse">计算中...</span>
                  ) : (
                    formatFileSize(entry.size)
                  )}
                </span>

                {/* Modified */}
                <span className="text-right text-gray-500 text-xs">
                  {formatRelativeTime(entry.modified)}
                </span>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t border-gray-700/30 text-xs text-gray-600 flex justify-between">
            <span>{entries.length} 项</span>
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
              <IconFolder size={16} /> 打开
            </button>
          )}

          {/* Open in system file manager */}
          <button
            onClick={() => handleOpenInFileManager(ctxMenu.entry)}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700/60 transition-colors"
          >
            <ExternalLink size={16} className="shrink-0 text-gray-400" />
            {platform === "macos" ? "用访达打开" : "用文件管理器打开"}
          </button>

          {/* Add to group rule */}
          <div className="relative">
            <button
              onClick={() => setShowGroupSubmenu((v) => !v)}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700/60 transition-colors"
            >
              <IconListPlus />
              添加到分组规则...
              <IconChevronRightSmall className="ml-auto text-gray-600" />
            </button>
            {showGroupSubmenu && (
              <div className="absolute left-full top-0 ml-1 min-w-[180px] py-1 rounded-lg bg-gray-800 border border-gray-700/60 shadow-xl shadow-black/40 z-50">
                {groups.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-gray-500">暂无分组</div>
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
            <ShieldCheck size={16} className="shrink-0" /> 添加到全局白名单
          </button>

          {/* Copy path */}
          <button
            onClick={() => handleCopyPath(ctxMenu.entry)}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700/60 transition-colors"
          >
            <IconClipboard /> 复制路径
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
            <IconTrash size={16} /> 删除
          </button>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-sm mx-4 p-5 rounded-xl bg-gray-800 border border-gray-700/60 shadow-2xl">
            <h3 className="text-base font-semibold text-white mb-2 flex items-center gap-2">
              <IconAlert className="text-yellow-500" /> 确认删除
            </h3>
            <p className="text-sm text-gray-400 mb-1">确定要删除以下路径吗？</p>
            <p className="text-sm text-gray-200 bg-gray-900/60 rounded px-3 py-2 mb-3 break-all font-mono text-xs">
              {deleteTarget.path}
            </p>
            <p className="text-xs text-red-400/80 mb-4">
              {deleteTarget.isDir
                ? "此操作将删除该目录及其所有内容，且不可撤销。"
                : "此操作不可撤销。"}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-4 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
              >
                取消
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
                      alert(`删除失败: ${e}`);
                    }
                  }
                  setDeleteTarget(null);
                }}
                className="px-4 py-1.5 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-500 transition-colors"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
