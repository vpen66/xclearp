/** ScanView — scan results with group-based display and selection */

import { useState, useMemo, useEffect } from "react";
import type { FileDiscovery, ScanProgress, ScanSummary, ScanTarget, RuleGroup } from "../types/index";
import { formatFileSize, formatDuration } from "../lib/ndjson";
import {
  Search,
  Trash2,
  AlertTriangle,
  Clock,
  HardDrive,
  ShieldCheck,
  Globe,
  Folder,
  Code,
  Database,
  Cpu,
  Settings,
  Zap,
  ChevronDown,
  ChevronRight,
  FileText,
  Hammer
} from "lucide-react";

interface TreeNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size: number;
  children: TreeNode[];
  file?: FileDiscovery;
}

function buildTree(scanPath: string, files: FileDiscovery[]): TreeNode[] {
  const root: TreeNode = {
    name: "",
    path: scanPath,
    type: 'dir',
    size: 0,
    children: [],
  };

  for (const f of files) {
    let relativePath = f.path;
    if (f.path.startsWith(scanPath)) {
      relativePath = f.path.substring(scanPath.length).replace(/^\//, "");
    }

    const parts = relativePath.split('/').filter(p => p !== "");
    let current = root;
    current.size += f.size;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      if (isLast) {
        current.children.push({
          name: part,
          path: f.path,
          type: 'file',
          size: f.size,
          children: [],
          file: f,
        });
      } else {
        let dirNode = current.children.find(c => c.name === part && c.type === 'dir');
        if (!dirNode) {
          const dirPath = current.path === "" ? part : `${current.path}/${part}`;
          dirNode = {
            name: part,
            path: dirPath,
            type: 'dir',
            size: 0,
            children: [],
          };
          current.children.push(dirNode);
        }
        dirNode.size += f.size;
        current = dirNode;
      }
    }
  }

  const sortChildren = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'dir' ? -1 : 1;
      }
      return b.size - a.size;
    });
    for (const node of nodes) {
      if (node.type === 'dir') {
        sortChildren(node.children);
      }
    }
  };

  sortChildren(root.children);
  return root.children;
}

function getAllFilePaths(node: TreeNode): string[] {
  if (node.type === 'file') {
    return [node.path];
  }
  return node.children.flatMap(getAllFilePaths);
}

interface ScanViewProps {
  groups: RuleGroup[];
  isScanning: boolean;
  scanProgress: ScanProgress | null;
  discoveredFiles: FileDiscovery[];
  scanSummary: ScanSummary | null;
  onStartScan: (ruleIds: string[]) => Promise<void>;
  onCancelScan: () => Promise<void>;
  onStartClean: (targets: ScanTarget[]) => Promise<void>;
  error: string | null;
}

export default function ScanView({
  groups,
  isScanning,
  scanProgress,
  discoveredFiles,
  scanSummary,
  onStartScan,
  onCancelScan,
  onStartClean,
  error,
}: ScanViewProps) {
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [isSelectMode, setIsSelectMode] = useState<boolean>(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [showAllFolderFiles, setShowAllFolderFiles] = useState<Record<string, boolean>>({});
  const [scanDurationMs, setScanDurationMs] = useState<number>(0);

  useEffect(() => {
    if (isScanning) {
      const start = Date.now();
      setScanDurationMs(0);
      const timer = setInterval(() => {
        setScanDurationMs(Date.now() - start);
      }, 100);
      return () => clearInterval(timer);
    }
  }, [isScanning]);

  // Synchronize selectedPaths with discoveredFiles to remove deleted paths
  useEffect(() => {
    setSelectedPaths((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const p of prev) {
        if (discoveredFiles.some((f) => f.path === p)) {
          next.add(p);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [discoveredFiles]);

  // Helper to parse file path and clean home dir
  const parsePath = (path: string) => {
    const normalized = path.replace(/^\/Users\/[^\/]+/, "~");
    const lastSlash = normalized.lastIndexOf("/");
    if (lastSlash === -1) return { name: normalized, dir: "" };
    return {
      name: normalized.substring(lastSlash + 1),
      dir: normalized.substring(0, lastSlash),
    };
  };

  const toggleGroupExpand = (groupId: string) => {
    const next = new Set(expandedGroups);
    if (next.has(groupId)) {
      next.delete(groupId);
    } else {
      next.add(groupId);
    }
    setExpandedGroups(next);
  };

  const toggleFolderExpand = (groupId: string, folderPath: string) => {
    const key = `${groupId}::${folderPath}`;
    const next = new Set(expandedFolders);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setExpandedFolders(next);
  };

  const toggleShowAllFolderFiles = (groupId: string, folderPath: string) => {
    const key = `${groupId}::${folderPath}`;
    setShowAllFolderFiles((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Group files by their group id
  const filesByGroup = useMemo(() => {
    const map = new Map<string, FileDiscovery[]>();
    for (const g of groups) {
      if (g.rules.some((r) => r.enabled)) {
        map.set(g.id, []);
      }
    }
    for (const f of discoveredFiles) {
      const arr = map.get(f.group) ?? [];
      arr.push(f);
      map.set(f.group, arr);
    }
    return map;
  }, [discoveredFiles, groups]);

  // Group files in each category by scanPath (or parent dir)
  const foldersByGroup = useMemo(() => {
    const groupFoldersMap = new Map<string, Map<string, FileDiscovery[]>>();

    for (const [groupId, files] of filesByGroup.entries()) {
      const foldersMap = new Map<string, FileDiscovery[]>();
      for (const f of files) {
        const folderKey = f.scanPath || parsePath(f.path).dir;
        const arr = foldersMap.get(folderKey) ?? [];
        arr.push(f);
        foldersMap.set(folderKey, arr);
      }
      groupFoldersMap.set(groupId, foldersMap);
    }

    return groupFoldersMap;
  }, [filesByGroup]);

  // Compute sorted folders per group
  const sortedFoldersByGroup = useMemo(() => {
    const map = new Map<string, Array<{ folderPath: string; folderFiles: FileDiscovery[]; folderSize: number }>>();
    for (const [groupId, foldersMap] of foldersByGroup.entries()) {
      const arr = Array.from(foldersMap.entries()).map(([folderPath, folderFiles]) => {
        const folderSize = folderFiles.reduce((s, f) => s + f.size, 0);
        return { folderPath, folderFiles, folderSize };
      });
      // Sort by size descending
      arr.sort((a, b) => b.folderSize - a.folderSize);
      map.set(groupId, arr);
    }
    return map;
  }, [foldersByGroup]);

  // Map of `${groupId}::${folderPath}` -> tree children
  const treesByGroupAndFolder = useMemo(() => {
    const map = new Map<string, TreeNode[]>();
    for (const [groupId, folders] of sortedFoldersByGroup.entries()) {
      for (const { folderPath, folderFiles } of folders) {
        const tree = buildTree(folderPath, folderFiles);
        map.set(`${groupId}::${folderPath}`, tree);
      }
    }
    return map;
  }, [sortedFoldersByGroup]);

  const toggleTreeNode = (node: TreeNode) => {
    const filePaths = getAllFilePaths(node);
    const allSelected = filePaths.every((p) => selectedPaths.has(p));
    const next = new Set(selectedPaths);
    if (allSelected) {
      filePaths.forEach((p) => next.delete(p));
    } else {
      filePaths.forEach((p) => next.add(p));
    }
    setSelectedPaths(next);
  };

  // Get group details from id
  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? id;
  const groupIconString = (id: string) => groups.find((g) => g.id === id)?.icon ?? "folder";

  // Total size of selected files
  const selectedTotal = useMemo(() => {
    return discoveredFiles
      .filter((f) => selectedPaths.has(f.path))
      .reduce((sum, f) => sum + f.size, 0);
  }, [discoveredFiles, selectedPaths]);

  const toggleSelectAll = () => {
    if (selectedPaths.size === discoveredFiles.length) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(new Set(discoveredFiles.map((f) => f.path)));
    }
  };

  const toggleGroup = (groupId: string) => {
    const files = filesByGroup.get(groupId) ?? [];
    const allSelected = files.every((f) => selectedPaths.has(f.path));
    const next = new Set(selectedPaths);

    if (allSelected) {
      files.forEach((f) => next.delete(f.path));
    } else {
      files.forEach((f) => next.add(f.path));
    }
    setSelectedPaths(next);
  };

  const toggleFolder = (folderFiles: FileDiscovery[]) => {
    const allSelected = folderFiles.every((f) => selectedPaths.has(f.path));
    const next = new Set(selectedPaths);
    if (allSelected) {
      folderFiles.forEach((f) => next.delete(f.path));
    } else {
      folderFiles.forEach((f) => next.add(f.path));
    }
    setSelectedPaths(next);
  };

  const formatDisplayPath = (path: string) => {
    return path.replace(/^\/Users\/[^\/]+/, "~");
  };

  const toggleFile = (path: string) => {
    const next = new Set(selectedPaths);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setSelectedPaths(next);
  };

  const renderTreeNode = (node: TreeNode, groupId: string, depth: number) => {
    if (node.type === 'file') {
      const isFileSelected = selectedPaths.has(node.path);
      return (
        <div
          key={node.path}
          onClick={() => {
            if (isSelectMode) {
              toggleFile(node.path);
            }
          }}
          className="flex items-center gap-3 px-4 py-1.5 hover:bg-gray-850/30 transition-colors cursor-pointer select-none group/file-row"
          style={{ paddingLeft: `${depth * 16 + 16}px` }}
        >
          {isSelectMode && (
            <div
              className={`w-3 h-3 rounded border flex items-center justify-center shrink-0 transition-colors ${
                isFileSelected
                  ? "bg-blue-600 border-blue-600 shadow-sm shadow-blue-500/10"
                  : "border-gray-700 bg-gray-950/10 group-hover/file-row:border-gray-600"
              }`}
            >
              {isFileSelected && (
                <svg className="w-2 h-2 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </div>
          )}

          <FileText className={`w-3.5 h-3.5 shrink-0 transition-colors ${
            isFileSelected && isSelectMode ? "text-blue-400" : "text-gray-500 group-hover/file-row:text-gray-400"
          }`} />

          <span
            className={`text-xs font-medium truncate flex-1 transition-colors ${
              isFileSelected && isSelectMode ? "text-blue-300" : "text-gray-200 group-hover/file-row:text-white"
            }`}
            title={node.path}
          >
            {node.name}
          </span>

          <span className={`text-[9px] font-mono shrink-0 px-2 py-0.5 rounded border transition-all ${
            isFileSelected && isSelectMode
              ? "text-blue-300 bg-blue-950/20 border-blue-900/30"
              : "text-gray-400 bg-gray-900/40 border-gray-800/60 group-hover/file-row:border-gray-700/60 group-hover/file-row:text-gray-300"
          }`}>
            {formatFileSize(node.size)}
          </span>
        </div>
      );
    } else {
      // It's a directory
      const folderKey = `${groupId}::${node.path}`;
      const isExpanded = expandedFolders.has(folderKey);

      const filePaths = getAllFilePaths(node);
      const isFolderAllSelected = filePaths.length > 0 && filePaths.every((p) => selectedPaths.has(p));
      const isFolderSomeSelected = filePaths.length > 0 && filePaths.some((p) => selectedPaths.has(p));

      const isShowAll = showAllFolderFiles[folderKey] || false;
      const displayedChildren = isShowAll ? node.children : node.children.slice(0, 100);

      return (
        <div key={node.path} className="flex flex-col">
          {/* Folder Row */}
          <div
            onClick={() => toggleFolderExpand(groupId, node.path)}
            className="flex items-center gap-3 px-4 py-2 hover:bg-gray-850/15 transition-colors cursor-pointer select-none group/folder-row border-b border-gray-900/10"
            style={{ paddingLeft: `${depth * 16 + 16}px` }}
          >
            {isSelectMode && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleTreeNode(node);
                }}
                className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 transition-colors ${
                  isFolderAllSelected
                    ? "bg-blue-600 border-blue-600 shadow-sm shadow-blue-500/10"
                    : isFolderSomeSelected
                    ? "bg-gray-800 border-blue-500"
                    : "border-gray-700 bg-gray-950/10 group-hover/folder-row:border-gray-600"
                }`}
              >
                {isFolderAllSelected && (
                  <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                )}
                {!isFolderAllSelected && isFolderSomeSelected && (
                  <div className="w-1.5 h-0.5 bg-blue-400 rounded-sm" />
                )}
              </button>
            )}

            <span className="text-gray-500 group-hover/folder-row:text-gray-400 transition-colors">
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>

            <Folder className={`w-4 h-4 shrink-0 transition-colors ${
              isFolderSomeSelected && isSelectMode ? "text-amber-400" : "text-amber-500/80 group-hover/folder-row:text-amber-400"
            }`} />

            <div className="flex-1 min-w-0 flex flex-col py-0.5">
              <span
                className={`text-xs font-semibold truncate transition-colors ${
                  isFolderSomeSelected && isSelectMode ? "text-blue-300" : "text-gray-200 group-hover/folder-row:text-white"
                }`}
                title={node.path}
              >
                {node.name}
              </span>
            </div>

            <span className={`text-[10px] font-mono font-bold shrink-0 px-2 py-0.5 rounded border transition-all ${
              isFolderSomeSelected && isSelectMode
                ? "text-blue-300 bg-blue-950/20 border-blue-900/30"
                : "text-gray-400 bg-gray-900/40 border-gray-800/60 group-hover/folder-row:border-gray-700/60 group-hover/folder-row:text-gray-300"
            }`}>
              {formatFileSize(node.size)}
            </span>
          </div>

          {/* Children List */}
          {isExpanded && (
            <div className="flex flex-col bg-gray-950/5">
              {displayedChildren.map((child) => renderTreeNode(child, groupId, depth + 1))}
              {node.children.length > 100 && !isShowAll && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleShowAllFolderFiles(groupId, node.path);
                  }}
                  className="w-full flex items-center justify-center py-2 bg-gray-900/10 hover:bg-gray-900/20 text-xs font-semibold text-blue-400 hover:text-blue-300 transition-colors border-t border-gray-850/10"
                  style={{ paddingLeft: `${(depth + 1) * 16 + 16}px` }}
                >
                  还有 {node.children.length - 100} 个项未显示... (点击展开)
                </button>
              )}
            </div>
          )}
        </div>
      );
    }
  };

  const handleScan = () => {
    const enabledRuleIds = groups
      .flatMap((g) => g.rules)
      .filter((r) => r.enabled)
      .map((r) => r.id);
    onStartScan(enabledRuleIds);
    setSelectedPaths(new Set());
    setIsSelectMode(false);
  };

  const handleCleanAll = () => {
    const confirmMessage = `确定要清理扫描出来的所有 ${discoveredFiles.length} 项垃圾文件（约 ${formatFileSize(scanSummary?.totalSize || 0)}）吗？`;
    if (confirm(confirmMessage)) {
      const targets: ScanTarget[] = discoveredFiles.map((f) => ({
        path: f.path,
        size: f.size,
        rule_id: f.ruleId,
        group: f.group,
      }));
      onStartClean(targets);
    }
  };

  const handleClean = () => {
    console.log("[handleClean] clicked. selectedPaths:", Array.from(selectedPaths));
    console.log("[handleClean] discoveredFiles total count:", discoveredFiles.length);
    const targets: ScanTarget[] = discoveredFiles
      .filter((f) => selectedPaths.has(f.path))
      .map((f) => ({
        path: f.path,
        size: f.size,
        rule_id: f.ruleId,
        group: f.group,
      }));
    console.log("[handleClean] mapped targets count:", targets.length, "targets:", targets);
    if (targets.length > 0) {
      console.log("[handleClean] invoking onStartClean...");
      onStartClean(targets);
    } else {
      console.warn("[handleClean] No targets selected!");
    }
  };

  const renderGroupIcon = (iconName: string, className = "w-4 h-4") => {
    switch (iconName) {
      case "globe": return <Globe className={`${className} text-blue-400`} />;
      case "folder": return <Folder className={`${className} text-amber-400`} />;
      case "hard-drive": return <HardDrive className={`${className} text-purple-400`} />;
      case "code": return <Code className={`${className} text-emerald-400`} />;
      case "trash-2": return <Trash2 className={`${className} text-red-400`} />;
      case "alert-triangle": return <AlertTriangle className={`${className} text-yellow-400`} />;
      case "database": return <Database className={`${className} text-pink-400`} />;
      case "cpu": return <Cpu className={`${className} text-indigo-400`} />;
      case "settings": return <Settings className={`${className} text-cyan-400`} />;
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
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-50 tracking-tight">扫描清理</h2>
          <p className="text-sm text-gray-400 mt-1">
            快速扫描并安全清理系统缓存、残留垃圾文件与无效临时文件。
          </p>
        </div>
        {!isScanning ? (
          <button
            onClick={handleScan}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white transition-all flex items-center gap-2 shadow-lg shadow-blue-500/10 active:scale-98"
          >
            <Search size={16} /> 开始扫描
          </button>
        ) : (
          <button
            onClick={onCancelScan}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-red-600 hover:bg-red-500 text-white transition-all active:scale-98"
          >
            取消扫描
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex gap-2 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm items-center">
          <AlertTriangle size={16} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Scan Dashboard (Analysis Report) */}
      {(isScanning || scanSummary) && (
        <div className="space-y-4 animate-slide-up-fade-in">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {/* Cleanable Size */}
            <div className="p-4 rounded-xl bg-gray-900/60 border border-gray-800 space-y-1 backdrop-blur-md hover:border-gray-700/60 transition-colors">
              <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider block">可释放空间</span>
              <p className="text-xl font-extrabold text-blue-400 font-mono">
                {isScanning
                  ? formatFileSize(scanProgress?.totalSize ?? 0)
                  : formatFileSize(scanSummary?.totalSize ?? 0)}
              </p>
            </div>
            {/* Total Files */}
            <div className="p-4 rounded-xl bg-gray-900/60 border border-gray-800 space-y-1 backdrop-blur-md hover:border-gray-700/60 transition-colors">
              <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider block">发现垃圾文件</span>
              <p className="text-xl font-extrabold text-gray-50 font-mono">
                {isScanning
                  ? `${scanProgress?.scannedFiles ?? 0} 个`
                  : `${scanSummary?.totalFiles ?? 0} 个`}
              </p>
            </div>
            {/* Whitelist Exclusions */}
            <div className="p-4 rounded-xl bg-gray-900/60 border border-gray-800 space-y-1 backdrop-blur-md hover:border-gray-700/60 transition-colors">
              <span className="text-[10px] font-bold text-emerald-500 uppercase tracking-wider flex items-center gap-1">
                <ShieldCheck size={12} /> 白名单拦截
              </span>
              <p className="text-sm font-bold text-emerald-400 font-mono leading-7">
                {isScanning
                  ? `0 个 (${formatFileSize(0)})`
                  : `${scanSummary?.skippedFiles ?? 0} 个 (${formatFileSize(scanSummary?.skippedSize ?? 0)})`}
              </p>
            </div>
            {/* Scan efficiency */}
            <div className="p-4 rounded-xl bg-gray-900/60 border border-gray-800 space-y-1 backdrop-blur-md hover:border-gray-700/60 transition-colors">
              <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider block">耗时速率</span>
              <p className="text-sm font-semibold text-gray-350 leading-7 flex items-center gap-1 font-mono">
                <Clock size={12} className="text-gray-500" />
                {isScanning
                  ? formatDuration(scanDurationMs)
                  : formatDuration(scanSummary?.durationMs ?? 0)}
                <span className="text-[10px] text-gray-500 ml-1">
                  ({isScanning
                    ? (scanDurationMs > 0 ? Math.round(((scanProgress?.scannedFiles ?? 0) / scanDurationMs) * 1000) : 0)
                    : (scanSummary && scanSummary.totalFiles > 0 ? Math.round((scanSummary.totalFiles / (scanSummary.durationMs || 1)) * 1000) : 0)
                  }F/s)
                </span>
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Results List */}
      {(isScanning || discoveredFiles.length > 0 || scanSummary !== null) && (
        <div className="space-y-3 animate-slide-up-fade-in animation-delay-100">
          {/* Selection / Clean Control Bar */}
          <div className="flex items-center justify-between px-4 py-2.5 rounded-xl bg-gray-900/40 border border-gray-850 shadow-md">
            {!isSelectMode ? (
              <>
                <div className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                  系统清理清单
                </div>
                <div className="flex items-center gap-3">
                  <button
                    disabled={discoveredFiles.length === 0}
                    onClick={() => {
                      setIsSelectMode(true);
                      setSelectedPaths(new Set(discoveredFiles.map(f => f.path)));
                    }}
                    className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-semibold bg-gray-850 hover:bg-gray-800 text-gray-200 border border-gray-700 transition-all active:scale-98 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    选择
                  </button>
                  <button
                    disabled={discoveredFiles.length === 0 || isScanning}
                    onClick={handleCleanAll}
                    className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-semibold bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 text-white transition-all shadow-md shadow-red-500/10 active:scale-98 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Trash2 size={13} /> 一键清理
                  </button>
                </div>
              </>
            ) : (
              <>
                <button
                  onClick={toggleSelectAll}
                  className="flex items-center gap-2.5 text-xs font-semibold text-gray-400 hover:text-white transition-colors"
                >
                  <span className={`w-4 h-4 rounded-md border flex items-center justify-center shrink-0 transition-all ${
                    selectedPaths.size === discoveredFiles.length
                      ? "bg-blue-600 border-blue-600 shadow-sm shadow-blue-500/20"
                      : "border-gray-700 bg-gray-950/40 hover:border-gray-600"
                  }`}>
                    {selectedPaths.size === discoveredFiles.length && (
                      <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </span>
                  全选
                </button>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-gray-500 font-mono">
                    已选 {selectedPaths.size}/{discoveredFiles.length} 项
                  </span>
                  <span className="text-xs font-bold text-gray-300 font-mono">{formatFileSize(selectedTotal)}</span>
                  <button
                    onClick={() => {
                      setIsSelectMode(false);
                      setSelectedPaths(new Set());
                    }}
                    className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-gray-850 hover:bg-gray-800 text-gray-400 hover:text-gray-300 transition-colors"
                  >
                    取消选择
                  </button>
                  <button
                    onClick={handleClean}
                    disabled={selectedPaths.size === 0 || isScanning}
                    className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-semibold bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-all shadow-md shadow-red-500/10 active:scale-98"
                  >
                    <Trash2 size={13} /> 立即清理
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Group categories */}
          <div className="space-y-3">
            {Array.from(filesByGroup.entries()).map(([groupId, files]) => {
              const groupSize = files.reduce((s, f) => s + f.size, 0);
              const isExpanded = expandedGroups.has(groupId);
              const percentage = scanSummary
                ? Math.round((groupSize / (scanSummary.totalSize || 1)) * 100)
                : (scanProgress && scanProgress.totalSize > 0
                  ? Math.round((groupSize / scanProgress.totalSize) * 100)
                  : 0);

              // Dynamic computed checkboxes for group
              const isGroupAllSelected = files.length > 0 && files.every((f) => selectedPaths.has(f.path));
              const isGroupSomeSelected = files.length > 0 && files.some((f) => selectedPaths.has(f.path));

              // Get folders for this group
              const groupFolders = sortedFoldersByGroup.get(groupId) || [];

              return (
                <div key={groupId} className="rounded-xl bg-gray-900/30 border border-gray-800/80 overflow-hidden transition-all duration-200">
                  {/* Group header */}
                  <div
                    onClick={() => {
                      if (files.length > 0) {
                        toggleGroupExpand(groupId);
                      }
                    }}
                    className={`flex flex-col gap-2 px-4 py-3 bg-gray-900/60 transition-colors select-none ${
                      files.length > 0 ? "hover:bg-gray-850/60 active:bg-gray-900/80 cursor-pointer" : "cursor-default"
                    } ${
                      isExpanded && files.length > 0 ? "border-b border-gray-850/60" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between w-full gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        {isSelectMode && (
                          <button
                            disabled={files.length === 0}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (files.length > 0) {
                                toggleGroup(groupId);
                              }
                            }}
                            className={`w-4 h-4 rounded-md border flex items-center justify-center shrink-0 transition-colors ${
                              files.length === 0
                                ? "border-gray-800 bg-gray-950/20 cursor-not-allowed opacity-30"
                                : isGroupAllSelected
                                ? "bg-blue-600 border-blue-600 shadow-sm shadow-blue-500/20"
                                : isGroupSomeSelected
                                ? "bg-gray-800 border-blue-500"
                                : "border-gray-700 bg-gray-950/40 hover:border-gray-600"
                            }`}
                          >
                            {isGroupAllSelected && (
                              <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                            {!isGroupAllSelected && isGroupSomeSelected && (
                              <div className="w-1.5 h-0.5 bg-blue-400 rounded-sm" />
                            )}
                          </button>
                        )}
                        <span className="shrink-0">{renderGroupIcon(groupIconString(groupId))}</span>
                        <span className="text-xs font-bold text-gray-200 truncate">{groupName(groupId)}</span>
                        {(() => {
                          const selectedInGroup = files.filter((f) => selectedPaths.has(f.path)).length;
                          return (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-950/50 border border-gray-850/30 text-gray-400 font-mono font-medium shrink-0">
                              {selectedInGroup > 0 ? `已选 ${selectedInGroup}/` : ""}{files.length} 项
                            </span>
                          );
                        })()}
                      </div>

                      <div className="flex items-center gap-3 shrink-0">
                        <span className="text-[10px] font-bold text-gray-400 font-mono">
                          {formatFileSize(groupSize)}
                          <span className="text-gray-500 ml-1.5">({percentage}%)</span>
                        </span>
                        {files.length > 0 && (
                          <span className="text-gray-400 hover:text-white transition-colors">
                            {isExpanded ? (
                              <ChevronDown size={14} />
                            ) : (
                              <ChevronRight size={14} />
                            )}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Integrated Progress Bar */}
                    <div className="w-full h-1 bg-gray-950/60 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-blue-500 via-indigo-500 to-violet-600 rounded-full transition-all duration-500"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>

                  {/* Folders and Files list */}
                  {isExpanded && (
                    <div className="max-h-120 overflow-y-auto custom-scrollbar bg-gray-950/15 divide-y divide-gray-900/40">
                      {groupFolders.map(({ folderPath, folderFiles, folderSize }) => {
                        const isFolderExpanded = expandedFolders.has(`${groupId}::${folderPath}`);
                        const isFolderAllSelected = folderFiles.every((f) => selectedPaths.has(f.path));
                        const isFolderSomeSelected = folderFiles.some((f) => selectedPaths.has(f.path));

                        // Get the tree children for this folder
                        const folderTree = treesByGroupAndFolder.get(`${groupId}::${folderPath}`) || [];

                        return (
                          <div key={folderPath} className="flex flex-col">
                            {/* Top-level Root Folder row */}
                            <div
                              onClick={() => toggleFolderExpand(groupId, folderPath)}
                              className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-850/15 transition-colors cursor-pointer select-none group/folder-row border-b border-gray-900/10"
                            >
                              {isSelectMode && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleFolder(folderFiles);
                                  }}
                                  className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 transition-colors ${
                                    isFolderAllSelected
                                      ? "bg-blue-600 border-blue-600 shadow-sm shadow-blue-500/20"
                                      : isFolderSomeSelected
                                      ? "bg-gray-800 border-blue-500"
                                      : "border-gray-700 bg-gray-950/10 group-hover/folder-row:border-gray-600"
                                  }`}
                                >
                                  {isFolderAllSelected && (
                                    <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                    </svg>
                                  )}
                                  {!isFolderAllSelected && isFolderSomeSelected && (
                                    <div className="w-1.5 h-0.5 bg-blue-400 rounded-sm" />
                                  )}
                                </button>
                              )}

                              <span className="text-gray-500 group-hover/folder-row:text-gray-400 transition-colors">
                                {isFolderExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              </span>

                              <Folder className={`w-4 h-4 shrink-0 transition-colors ${
                                isFolderSomeSelected ? "text-amber-400" : "text-amber-500/80 group-hover/folder-row:text-amber-400"
                              }`} />

                              <div className="flex-1 min-w-0 flex flex-col py-0.5">
                                <span
                                  className={`text-xs font-semibold truncate transition-colors ${
                                    isFolderSomeSelected ? "text-blue-300" : "text-gray-200 group-hover/folder-row:text-white"
                                  }`}
                                  title={folderPath}
                                >
                                  {formatDisplayPath(folderPath)}
                                </span>
                                <span className="text-[10px] text-gray-500 font-mono mt-0.5">
                                  包含 {folderFiles.length} 个文件
                                </span>
                              </div>

                              <span className={`text-[10px] font-mono font-bold shrink-0 px-2 py-0.5 rounded border transition-all ${
                                isFolderSomeSelected
                                  ? "text-blue-300 bg-blue-950/20 border-blue-900/30"
                                  : "text-gray-400 bg-gray-900/40 border-gray-800/60 group-hover/folder-row:border-gray-700/60 group-hover/folder-row:text-gray-300"
                              }`}>
                                {formatFileSize(folderSize)}
                              </span>
                            </div>

                            {/* Recursive Tree under root folder */}
                            {isFolderExpanded && (
                              <div className="flex flex-col bg-gray-950/20 pb-1">
                                {folderTree.map((child) => renderTreeNode(child, groupId, 1))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty / Initial state */}
      <div
        className={`flex flex-col items-center justify-center text-center overflow-hidden transition-all duration-500 ease-in-out ${
          !isScanning && discoveredFiles.length === 0 && !scanSummary
            ? "opacity-100 py-24 max-h-[400px]"
            : "opacity-0 py-0 max-h-0 pointer-events-none"
        }`}
      >
        <div className="w-16 h-16 rounded-2xl bg-gray-900 border border-gray-800 flex items-center justify-center mb-4 text-gray-500 shadow-xl shadow-black/10">
          <Zap size={24} className="text-blue-500 animate-pulse" />
        </div>
        <p className="text-sm font-semibold text-gray-300">系统就绪，等待扫描</p>
        <p className="text-xs text-gray-500 mt-1 max-w-xs leading-relaxed">
          点击“开始扫描”按钮来检索您系统中由规则组定义的可清理冗余文件。
        </p>
      </div>
    </div>
  );
}
