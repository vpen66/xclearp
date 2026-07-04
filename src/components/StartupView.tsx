/** StartupView — startup item management UI */

import { useState, useEffect, useMemo, useCallback } from "react";
import { useI18n } from "../lib/i18n";
import { listStartupItems, toggleStartupItem, removeStartupItem } from "../lib/ipc";
import { IconLoader, IconRefresh, IconTrash, IconAlert } from "./Icons";
import {
  Rocket,
  Shield,
  Terminal,
  FileText,
  Settings,
  Monitor,
  Search,
} from "lucide-react";
import type { StartupItem } from "../types/startup";

/** Icon for each item type */
function itemTypeIcon(itemType: string) {
  switch (itemType) {
    case "launch_agent":
    case "launch_daemon":
      return <Rocket size={16} className="text-blue-400" />;
    case "login_item":
      return <Monitor size={16} className="text-purple-400" />;
    case "registry_run":
      return <Settings size={16} className="text-amber-400" />;
    case "desktop_file":
      return <FileText size={16} className="text-green-400" />;
    case "systemd_user":
      return <Terminal size={16} className="text-cyan-400" />;
    default:
      return <Rocket size={16} className="text-gray-400" />;
  }
}

/** Human-readable label for item_type */
function itemTypeLabel(itemType: string): string {
  switch (itemType) {
    case "launch_agent":
      return "LaunchAgent";
    case "launch_daemon":
      return "LaunchDaemon";
    case "login_item":
      return "Login Item";
    case "registry_run":
      return "Registry Run";
    case "desktop_file":
      return "Desktop File";
    case "systemd_user":
      return "Systemd User";
    default:
      return itemType;
  }
}

export default function StartupView({ isActive }: { isActive: boolean }) {
  const { t } = useI18n();

  const [items, setItems] = useState<StartupItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<StartupItem | null>(null);
  const [togglingSources, setTogglingSources] = useState<Set<string>>(new Set());

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      console.log('[StartupView] Fetching startup items...');
      const result = await listStartupItems();
      console.log('[StartupView] Received', result.length, 'items');
      setItems(result);
    } catch (err) {
      console.error('[StartupView] Error fetching items:', err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Load items when tab becomes active for the first time
  useEffect(() => {
    if (isActive && !loading && items.length === 0) {
      fetchItems();
    }
  }, [isActive, loading, items.length, fetchItems]);

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items;
    const q = searchQuery.toLowerCase();
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.command.toLowerCase().includes(q) ||
        item.source.toLowerCase().includes(q),
    );
  }, [items, searchQuery]);

  const handleToggle = async (item: StartupItem) => {
    setTogglingSources((prev) => new Set(prev).add(item.source));
    try {
      await toggleStartupItem(item.source, !item.enabled);
      // Update local state
      setItems((prev) =>
        prev.map((i) =>
          i.source === item.source ? { ...i, enabled: !i.enabled } : i,
        ),
      );
    } catch (err) {
      setError(String(err));
    } finally {
      setTogglingSources((prev) => {
        const next = new Set(prev);
        next.delete(item.source);
        return next;
      });
    }
  };

  const handleDelete = async (item: StartupItem) => {
    try {
      await removeStartupItem(item.source);
      setItems((prev) => prev.filter((i) => i.source !== item.source));
    } catch (err) {
      setError(String(err));
    }
    setDeleteTarget(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-gray-100">
          {t("startup_title")}
        </h2>
        <button
          onClick={fetchItems}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-700/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title={t("disk.action.refresh")}
        >
          <IconRefresh
            size={14}
            className={loading ? "animate-spin" : ""}
          />
          <span>{t("disk.action.refresh")}</span>
        </button>
      </div>

      {error && (
        <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {error}
        </div>
      )}

      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">
          <Search size={16} />
        </span>
        <input
          type="text"
          placeholder={t("startup_search")}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
        />
      </div>

      {loading && items.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <IconLoader className="animate-spin text-blue-400" />
          <span className="ml-2 text-gray-400 text-sm">
            {t("startup_search")}
          </span>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="text-center py-12 text-gray-500 text-sm">
          {searchQuery
            ? t("uninstall.state.no_matching_apps")
            : t("startup_empty")}
        </div>
      ) : (
        <div className="space-y-1 max-h-[65vh] overflow-y-auto custom-scrollbar">
          {filteredItems.map((item) => {
            const isToggling = togglingSources.has(item.source);
            const isSystem = item.user_level === "system";
            return (
              <div
                key={item.source}
                className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                  isSystem
                    ? "bg-gray-800/30 border border-gray-700/30"
                    : "hover:bg-gray-800/80"
                }`}
              >
                {/* Icon */}
                <div className="w-9 h-9 rounded-lg bg-gray-800 flex items-center justify-center shrink-0">
                  {itemTypeIcon(item.item_type)}
                </div>

                {/* Name + source */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-200 truncate">
                      {item.name}
                    </span>
                    <span
                      className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium leading-none shrink-0 ${
                        isSystem
                          ? "text-orange-400 bg-orange-900/20"
                          : "text-green-400 bg-green-900/20"
                      }`}
                    >
                      {isSystem
                        ? t("startup_system_level")
                        : t("startup_user_level")}
                    </span>
                    <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium leading-none text-gray-400 bg-gray-700/50 shrink-0">
                      {itemTypeLabel(item.item_type)}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 truncate mt-0.5" title={item.source}>
                    {item.source}
                  </div>
                  {item.command && (
                    <div className="text-[11px] text-gray-600 truncate" title={item.command}>
                      {item.command}
                    </div>
                  )}
                </div>

                {/* Toggle switch */}
                <button
                  onClick={() => handleToggle(item)}
                  disabled={isToggling}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 focus:outline-none ${
                    item.enabled
                      ? "bg-blue-600"
                      : "bg-gray-600"
                  } ${isToggling ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                  title={item.enabled ? t("startup_disable") : t("startup_enable")}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      item.enabled ? "translate-x-[18px]" : "translate-x-[3px]"
                    }`}
                  />
                </button>

                {/* Delete button */}
                <button
                  onClick={() => setDeleteTarget(item)}
                  className="text-gray-500 hover:text-red-400 transition-colors shrink-0 p-1"
                  title={t("startup_delete")}
                >
                  <IconTrash size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <IconAlert className="text-yellow-500 mt-0.5" />
              <div>
                <h3 className="text-base font-semibold text-gray-100">
                  {t("startup_delete")}
                </h3>
                <p className="text-sm text-gray-400 mt-1">
                  {t("startup_delete_confirm")}
                </p>
                <div className="mt-2 px-3 py-2 rounded-lg bg-gray-800 text-xs text-gray-300 break-all">
                  <span className="font-medium">{deleteTarget.name}</span>
                  <br />
                  <span className="text-gray-500">{deleteTarget.source}</span>
                </div>
                {deleteTarget.user_level === "system" && (
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-orange-400">
                    <Shield size={12} />
                    <span>{t("startup_system_level")}</span>
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 mt-6">
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
              >
                {t("modal.cancel")}
              </button>
              <button
                onClick={() => handleDelete(deleteTarget)}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-500 transition-colors flex items-center gap-2"
              >
                <IconTrash />
                {t("startup_delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
