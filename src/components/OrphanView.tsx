/** OrphanView — orphan / residual file scanner and cleaner */

import { useState, useMemo, useCallback } from "react";
import { useI18n } from "../lib/i18n";
import { scanOrphanFiles, deleteOrphanFiles } from "../lib/ipc";
import type { OrphanGroup } from "../types/orphan";
import { IconSearch, IconTrash, IconLoader } from "./Icons";

const CATEGORY_COLORS: Record<string, string> = {
  cache: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  logs: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  preferences: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  app_support: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  saved_state: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  containers: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
  config: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
  default: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300',
};

type SortKey = "size" | "name" | "date" | "category";

export default function OrphanView({ isActive }: { isActive: boolean }) {
  const { t } = useI18n();

  const [orphans, setOrphans] = useState<OrphanGroup[]>([]);
  const [scanning, setScanning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("size");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showConfirm, setShowConfirm] = useState(false);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());

  const formatSize = (bytes: number): string => {
    if (!bytes || isNaN(bytes) || bytes <= 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const formatDate = (ts: number | null): string => {
    if (!ts) return "—";
    const d = new Date(ts * 1000);
    return d.toLocaleDateString();
  };

  const categoryLabel = (cat: string): string => {
    const key = `orphan.category.${cat}`;
    const label = t(key);
    return label === key ? cat : label;
  };

  const handleScan = async () => {
    setScanning(true);
    setError(null);
    setResultMsg(null);
    setSelected(new Set());
    setSelectedCategories(new Set());
    try {
      const data = await scanOrphanFiles();
      setOrphans(data);
      setScanned(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setScanning(false);
    }
  };

  const availableCategories = useMemo(() => {
    const cats = new Set(orphans.map(g => g.category));
    return Array.from(cats).sort();
  }, [orphans]);

  const toggleCategory = useCallback((cat: string) => {
    setSelectedCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  const sortedOrphans = useMemo(() => {
    let list = [...orphans];
    if (selectedCategories.size > 0) {
      list = list.filter(g => selectedCategories.has(g.category));
    }
    switch (sortKey) {
      case "size":
        list.sort((a, b) => (b.total_size || 0) - (a.total_size || 0));
        break;
      case "name":
        list.sort((a, b) => a.app_name.localeCompare(b.app_name));
        break;
      case "date":
        list.sort((a, b) => (b.last_modified ?? 0) - (a.last_modified ?? 0));
        break;
      case "category":
        list.sort((a, b) => a.category.localeCompare(b.category) || (b.total_size || 0) - (a.total_size || 0));
        break;
    }
    return list;
  }, [orphans, sortKey, selectedCategories]);

  const total = useMemo(() => ({
    size: sortedOrphans.reduce((s, g) => s + (g.total_size || 0), 0),
  }), [sortedOrphans]);

  const toggleSelect = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const allSelected = sortedOrphans.length > 0 && sortedOrphans.every((o) => selected.has(o.base_path));

  const toggleAll = useCallback(() => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sortedOrphans.map((o) => o.base_path)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSelected, sortedOrphans]);

  const selectedCount = selected.size;
  const selectedSize = useMemo(
    () => sortedOrphans.filter((o) => selected.has(o.base_path)).reduce((s, o) => s + (o.total_size || 0), 0),
    [sortedOrphans, selected],
  );

  const handleDelete = async () => {
    setShowConfirm(false);
    setDeleting(true);
    try {
      const result = await deleteOrphanFiles(Array.from(selected), true);
      const msg =
        result.failed_count === 0
          ? t("orphan.delete_success").replace("{count}", String(result.deleted_count)).replace("{size}", formatSize(result.freed_bytes))
          : t("orphan.delete_partial").replace("{success}", String(result.deleted_count)).replace("{fail}", String(result.failed_count));
      setResultMsg(msg);
      // Remove deleted items from list
      setOrphans((prev) => prev.filter((o) => !selected.has(o.base_path)));
      setSelected(new Set());
    } catch (err) {
      setError(String(err));
    } finally {
      setDeleting(false);
    }
  };

  // Don't render anything when not active to save resources on initial load
  // but once scanned we keep the state
  if (!isActive && orphans.length === 0 && !scanning && !scanned) {
    return null;
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-50">{t("orphan.title")}</h2>
          <p className="text-sm text-gray-400 mt-1">{t("orphan.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Sort dropdown */}
          {orphans.length > 0 && (
            <select
              className="text-xs bg-gray-800 text-gray-300 border border-gray-700 rounded-lg px-2 py-1.5 outline-none"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
            >
              <option value="size">{t("orphan.sort.size")}</option>
              <option value="name">{t("orphan.sort.name")}</option>
              <option value="date">{t("orphan.sort.date")}</option>
              <option value="category">{t("orphan.sortByCategory")}</option>
            </select>
          )}
          <button
            onClick={handleScan}
            disabled={scanning || deleting}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
          >
            {scanning ? (
              <>
                <IconLoader className="animate-spin" />
                {t("orphan.scanning")}
              </>
            ) : (
              <>
                <IconSearch />
                {t("orphan.scan")}
              </>
            )}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Result message */}
      {resultMsg && (
        <div className="px-4 py-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm">
          {resultMsg}
        </div>
      )}

      {/* Scanning indicator */}
      {scanning && (
        <div className="flex flex-col items-center justify-center py-16 text-gray-400">
          <IconLoader className="animate-spin text-blue-400" size={32} />
          <p className="mt-4 text-sm">{t("orphan.scanning")}</p>
        </div>
      )}

      {/* Empty state */}
      {!scanning && scanned && orphans.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-gray-500">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <p className="mt-4 text-sm font-medium">{t("orphan.empty")}</p>
          <p className="mt-1 text-xs text-gray-600">{t("orphan.empty.desc")}</p>
        </div>
      )}

      {/* Results list */}
      {!scanning && sortedOrphans.length > 0 && (
        <>
          {/* Summary bar */}
          <div className="px-4 py-3 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 rounded-lg">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">
                {t('orphan.scanResultSummary')
                  .replace('{count}', String(sortedOrphans.length))
                  .replace('{size}', formatSize(total.size))}
              </span>
            </div>
          </div>

          {/* Category filter chips */}
          {availableCategories.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 py-2 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 rounded-lg">
              <button
                onClick={() => setSelectedCategories(new Set())}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  selectedCategories.size === 0
                    ? 'bg-blue-500 text-white'
                    : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'
                }`}
              >
                {t('orphan.allCategories')}
              </button>
              {availableCategories.map(cat => (
                <button
                  key={cat}
                  onClick={() => toggleCategory(cat)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    selectedCategories.has(cat)
                      ? 'bg-blue-500 text-white'
                      : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'
                  }`}
                >
                  {categoryLabel(cat)}
                  <span className="ml-1 opacity-75">
                    ({orphans.filter(g => g.category === cat).length})
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Toolbar */}
          <div className="flex items-center justify-between">
            <button
              onClick={toggleAll}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              {allSelected ? t("orphan.deselect_all") : t("orphan.select_all")}
            </button>
            {selectedCount > 0 && (
              <span className="text-xs text-gray-400">
                {t("orphan.selected_summary")
                  .replace("{count}", String(selectedCount))
                  .replace("{size}", formatSize(selectedSize))}
              </span>
            )}
          </div>

          {/* List */}
          <div className="space-y-2">
            {sortedOrphans.map((orphan) => {
              const isSelected = selected.has(orphan.base_path);
              return (
                <div
                  key={orphan.base_path}
                  className={`flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors cursor-pointer ${
                    isSelected
                      ? "bg-blue-600/10 border-blue-500/40"
                      : "bg-gray-900/50 border-gray-800 hover:border-gray-700"
                  }`}
                  onClick={() => toggleSelect(orphan.base_path)}
                >
                  {/* Checkbox */}
                  <div
                    className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                      isSelected ? "bg-blue-600 border-blue-600" : "border-gray-600"
                    }`}
                  >
                    {isSelected && (
                      <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                        <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-100 truncate">
                        {orphan.app_name}
                      </span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${CATEGORY_COLORS[orphan.category] || CATEGORY_COLORS.default}`}>
                        {categoryLabel(orphan.category)}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 truncate mt-0.5">{orphan.base_path}</p>
                  </div>

                  {/* Stats */}
                  <div className="text-right shrink-0 space-y-0.5">
                    <span className={`text-sm font-medium ${
                      (orphan.total_size || 0) > 1024 * 1024 * 1024
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-gray-200'
                    }`}>{formatSize(orphan.total_size || 0)}</span>
                    <p className="text-[10px] text-gray-500">
                      {orphan.file_count} {t("orphan.items")} · {formatDate(orphan.last_modified)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Bottom action bar */}
          {selectedCount > 0 && (
            <div className="flex items-center justify-between px-4 py-3 bg-gray-900 rounded-lg border border-gray-800">
              <span className="text-sm text-gray-300">
                {t("orphan.selected")} {selectedCount} {t("orphan.items")} · {formatSize(selectedSize)}
              </span>
              <button
                onClick={() => setShowConfirm(true)}
                disabled={deleting}
                className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
              >
                {deleting ? (
                  <>
                    <IconLoader className="animate-spin" />
                    {t("orphan.deleting")}
                  </>
                ) : (
                  <>
                    <IconTrash />
                    {t("orphan.cleanup")}
                  </>
                )}
              </button>
            </div>
          )}
        </>
      )}

      {/* Confirm dialog */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto">
            <h3 className="text-lg font-bold text-gray-50 mb-2">{t("orphan.confirm.title")}</h3>
            <p className="text-sm text-gray-400 mb-4">
              {t("orphan.confirm.desc").replace("{count}", String(selectedCount))}
            </p>
            <ul className="space-y-1 mb-6 max-h-48 overflow-y-auto">
              {sortedOrphans
                .filter((o) => selected.has(o.base_path))
                .map((o) => (
                  <li key={o.base_path} className="text-xs text-gray-400 font-mono truncate">
                    {o.base_path} ({formatSize(o.total_size || 0)})
                  </li>
                ))}
            </ul>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowConfirm(false)}
                className="px-4 py-2 text-sm text-gray-300 hover:text-gray-100 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
              >
                {t("modal.cancel")}
              </button>
              <button
                onClick={handleDelete}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
              >
                {t("orphan.cleanup")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
