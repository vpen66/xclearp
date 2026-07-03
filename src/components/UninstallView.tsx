/** UninstallView -- application deep uninstall UI with 5 phases */

import { useState, useEffect, useMemo, useRef } from "react";
import { useUninstallStream } from "../hooks/useUninstallStream";
import { IconLoader, IconAlert, IconTrash, IconRefresh } from "./Icons";
import { getIconDataUrls } from "../lib/ipc";
import { Folder, FileText, ChevronDown, ChevronRight } from "lucide-react";
import type { AppFileEntry } from "../types/uninstall";

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

export default function UninstallView({ isActive }: { isActive: boolean }) {
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
    loadApps,
    refreshApps,
    selectAndScan,
    startUninstall,
    cancelOperation,
    resetToSelect,
    goBackToSelect,
  } = useUninstallStream();

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(
    new Set(),
  );
  const [showConfirm, setShowConfirm] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedTreeNodes, setExpandedTreeNodes] = useState<Set<string>>(new Set());
  const [iconDataUrls, setIconDataUrls] = useState<Record<string, string>>({});
  const listScrollRef = useRef<HTMLDivElement>(null);
  const savedScrollTopRef = useRef(0);

  // Load apps when tab becomes active for the first time
  useEffect(() => {
    if (isActive && phase === "select") {
      loadApps();
    }
  }, [isActive, phase, loadApps]);

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

  // When file groups arrive, select all by default
  useEffect(() => {
    if (fileGroups.length > 0) {
      setSelectedCategories(new Set(fileGroups.map((g) => g.category)));
    }
  }, [fileGroups]);

  const filteredApps = useMemo(() => {
    if (!searchQuery.trim()) return apps;
    const q = searchQuery.toLowerCase();
    return apps.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.bundleId.toLowerCase().includes(q) ||
        (a.publisher && a.publisher.toLowerCase().includes(q)) ||
        (a.packageName && a.packageName.toLowerCase().includes(q)),
    );
  }, [apps, searchQuery]);

  const selectedPaths = useMemo(() => {
    const paths: string[] = [];
    for (const group of fileGroups) {
      if (selectedCategories.has(group.category)) {
        for (const file of group.files) {
          paths.push(file.path);
        }
      }
    }
    return paths;
  }, [fileGroups, selectedCategories]);

  const selectedTotalSize = useMemo(() => {
    let total = 0;
    for (const group of fileGroups) {
      if (selectedCategories.has(group.category)) {
        total += group.totalSize;
      }
    }
    return total;
  }, [fileGroups, selectedCategories]);

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
  };

  const toggleExpanded = (cat: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  // -- Phase: Select --
  if (phase === "select") {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-gray-100">
            应用深度卸载
          </h2>
          <button
            onClick={() => refreshApps()}
            disabled={appsLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-700/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="刷新应用列表"
          >
            <IconRefresh
              size={14}
              className={appsLoading ? "animate-spin" : ""}
            />
            <span>刷新</span>
          </button>
        </div>
        <p className="text-sm text-gray-400">
          选择要卸载的应用，将扫描并删除其所有残余文件（缓存、偏好设置、日志等）。
        </p>

        {error && (
          <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
            {error}
          </div>
        )}

        <div className="relative">
          <input
            type="text"
            placeholder="搜索应用名称..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {appsLoading ? (
          <div className="flex items-center justify-center py-12">
            <IconLoader className="animate-spin text-blue-400" />
            <span className="ml-2 text-gray-400 text-sm">
              正在扫描已安装应用...
            </span>
          </div>
        ) : filteredApps.length === 0 ? (
          <div className="text-center py-12 text-gray-500 text-sm">
            {searchQuery ? "未找到匹配的应用" : "未找到已安装的应用"}
          </div>
        ) : (
          <div ref={listScrollRef} className="space-y-1 max-h-[60vh] overflow-y-auto custom-scrollbar">
            {filteredApps.map((app) => (
              <button
                key={app.appPath}
                onClick={() => {
                  // Save scroll position before leaving
                  if (listScrollRef.current) {
                    savedScrollTopRef.current = listScrollRef.current.scrollTop;
                  }
                  selectAndScan(app);
                }}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-gray-800/80 transition-colors text-left group"
              >
                <div className="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center text-lg font-bold text-gray-400 shrink-0 overflow-hidden">
                  {app.iconPath && iconDataUrls[app.iconPath] ? (
                    <img
                      src={iconDataUrls[app.iconPath]}
                      alt={app.name}
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    app.name.charAt(0).toUpperCase()
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-200 truncate">
                    {app.name}
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
                <div className="text-xs text-gray-500 shrink-0">
                  {formatSize(app.appSize)}
                </div>
              </button>
            ))}
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
          应用深度卸载
        </h2>
        <div className="flex flex-col items-center justify-center py-16">
          <IconLoader className="animate-spin text-blue-400 w-8 h-8" />
          <p className="mt-4 text-gray-300 text-sm">
            正在扫描 {selectedApp?.name} 的残余文件...
          </p>
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
              &larr; 返回
            </button>
            <h2 className="text-xl font-semibold text-gray-100">
              {selectedApp?.name} 残余文件
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
                共发现 {fileGroups.reduce((s, g) => s + g.fileCount, 0)} 个文件，
                总计 {formatSize(fileGroups.reduce((s, g) => s + g.totalSize, 0))}
              </span>
              <span className="text-blue-400 font-medium">
                已选 {formatSize(selectedTotalSize)}
              </span>
            </div>

            <div className="space-y-2">
              {fileGroups.map((group) => (
                <div
                  key={group.category}
                  className="rounded-lg border border-gray-700/50 bg-gray-900/50 overflow-hidden"
                >
                  <div className="flex items-center gap-3 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selectedCategories.has(group.category)}
                      onChange={() => toggleCategory(group.category)}
                      className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-200">
                        {group.categoryName}
                      </div>
                      <div className="text-xs text-gray-500">
                        {group.riskHint}
                      </div>
                    </div>
                    <div className="text-xs text-gray-400 shrink-0">
                      {group.fileCount} 个文件 / {formatSize(group.totalSize)}
                    </div>
                    <button
                      onClick={() => toggleExpanded(group.category)}
                      className="text-gray-500 hover:text-gray-300 text-xs shrink-0"
                    >
                      {expandedGroups.has(group.category) ? "收起" : "展开"}
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
                                onClick={() => {
                                  const next = new Set(expandedTreeNodes);
                                  if (next.has(nodeKey)) next.delete(nodeKey);
                                  else next.add(nodeKey);
                                  setExpandedTreeNodes(next);
                                }}
                                className="flex items-center gap-2 py-1.5 px-3 hover:bg-gray-800/30 cursor-pointer transition-colors"
                                style={{ paddingLeft: `${depth * 16 + 12}px` }}
                              >
                                <span className="text-gray-500">
                                  {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                </span>
                                <Folder className="w-3.5 h-3.5 text-amber-500/80 shrink-0" />
                                <span className="text-xs font-medium text-gray-200 truncate flex-1">
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
                取消
              </button>
              <button
                onClick={() => setShowConfirm(true)}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-500 transition-colors flex items-center gap-2"
              >
                <IconTrash />
                卸载
              </button>
            </div>
          </>
        )}

        {fileGroups.length === 0 && (
          <div className="text-center py-8 text-gray-500 text-sm">
            未发现残余文件，但你可以将应用本身移至废纸篓。
          </div>
        )}

        {fileGroups.length === 0 && (
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              onClick={goBackToSelect}
              className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
            >
              取消
            </button>
            <button
              onClick={() => setShowConfirm(true)}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-500 transition-colors flex items-center gap-2"
            >
              <IconTrash />
              卸载
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
                    确认卸载
                  </h3>
                  <p className="text-sm text-gray-400 mt-1">
                    将把应用移至废纸篓。你还可以选择是否同时删除选中的残余文件。
                  </p>
                  {selectedPaths.length > 0 && (
                    <p className="text-xs text-gray-500 mt-2">
                      已选中 {selectedPaths.length} 个残余文件，共{" "}
                      {formatSize(selectedTotalSize)}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-2 mt-6">
                <button
                  onClick={() => {
                    setShowConfirm(false);
                    if (selectedApp) {
                      startUninstall(selectedApp, "trash_only", []);
                    }
                  }}
                  className="w-full px-4 py-2.5 rounded-lg text-sm font-medium text-gray-200 bg-gray-800 hover:bg-gray-700 transition-colors"
                >
                  仅卸载（移至废纸篓）
                </button>
                <button
                  onClick={() => {
                    setShowConfirm(false);
                    if (selectedApp) {
                      startUninstall(selectedApp, "trash_only", selectedPaths);
                    }
                  }}
                  disabled={selectedPaths.length === 0}
                  className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  卸载并删除选中数据
                </button>
                {hasOfficialUninstaller && (
                  <button
                    onClick={() => {
                      setShowConfirm(false);
                      if (selectedApp) {
                        startUninstall(selectedApp, "official_uninstaller", selectedPaths);
                      }
                    }}
                    className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-orange-600 text-white hover:bg-orange-500 transition-colors"
                  >
                    官方卸载 + 清理残余
                  </button>
                )}
                <button
                  onClick={() => setShowConfirm(false)}
                  className="w-full px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
                >
                  取消
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
          应用深度卸载
        </h2>
        <div className="flex flex-col items-center justify-center py-12">
          <IconLoader className="animate-spin text-blue-400 w-8 h-8" />
          <p className="mt-4 text-gray-300 text-sm">
            {officialUninstallerPhase === "running"
              ? "正在执行官方卸载程序..."
              : officialUninstallerPhase === "completed"
                ? "官方卸载已完成，正在清理残余文件..."
                : officialUninstallerPhase === "scanning_residuals"
                  ? "正在扫描残余文件..."
                  : "正在删除残余文件..."}
          </p>
          {progress && (
            <div className="mt-2 text-xs text-gray-500">
              已删除 {progress.deletedFiles} 个文件，释放{" "}
              {formatSize(progress.freedBytes)}
            </div>
          )}
          {progress?.currentPath && (
            <div className="mt-1 text-xs text-gray-600 truncate max-w-md">
              {progress.currentPath}
            </div>
          )}
          <button
            onClick={cancelOperation}
            className="mt-6 px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800"
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  // -- Phase: Done --
  if (phase === "done") {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-gray-100">
          应用深度卸载
        </h2>

        {error && (
          <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
            {error}
          </div>
        )}

        <div className="flex flex-col items-center justify-center py-12">
          <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center mb-4">
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
          </div>
          <h3 className="text-lg font-medium text-gray-100">卸载完成</h3>
          {uninstallSummary && (
            <div className="mt-2 text-sm text-gray-400 text-center">
              <p>
                已删除 {uninstallSummary.totalDeleted} 个文件
              </p>
              <p>
                释放 {formatSize(uninstallSummary.totalFreed)} 空间
              </p>
              <p className="text-xs text-gray-600 mt-1">
                耗时 {uninstallSummary.durationMs}ms
              </p>
            </div>
          )}
          <button
            onClick={resetToSelect}
            className="mt-6 px-6 py-2.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors"
          >
            返回应用列表
          </button>
        </div>
      </div>
    );
  }

  return null;
}
