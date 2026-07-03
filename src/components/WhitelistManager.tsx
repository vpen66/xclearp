/** WhitelistManager — manage whitelist paths with backend persistence */

import { useState, useEffect } from "react";
import { getWhitelist, updateWhitelist, type Whitelist } from "../lib/ipc";
import { Trash2, Plus, AlertCircle, Loader2, ToggleLeft, ToggleRight, Download, Upload, HelpCircle, Eye, EyeOff } from "lucide-react";
import Tooltip from "./Tooltip";
import { useToast } from "./Toast";
import { useI18n } from "../lib/i18n";

export default function WhitelistManager() {
  const toast = useToast();
  const { t } = useI18n();
  const [whitelist, setWhitelist] = useState<Whitelist | null>(null);
  const [newPath, setNewPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showTip, setShowTip] = useState(false);

  const handleImportWhitelist = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const content = event.target?.result as string;
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === 'object') {
          const wl: Whitelist = {
            global_excludes: Array.isArray(parsed.global_excludes) ? parsed.global_excludes : [],
            group_excludes: (parsed.group_excludes && typeof parsed.group_excludes === 'object') ? parsed.group_excludes : {},
            rule_excludes: (parsed.rule_excludes && typeof parsed.rule_excludes === 'object') ? parsed.rule_excludes : {},
            disabled_patterns: Array.isArray(parsed.disabled_patterns) ? parsed.disabled_patterns : [],
            show_in_disk_analysis: Array.isArray(parsed.show_in_disk_analysis)
              ? parsed.show_in_disk_analysis
              : (Array.isArray(parsed.global_excludes) ? parsed.global_excludes : []),
          };
          await updateWhitelist(wl);
          setWhitelist(wl);
          toast.success(t("whitelist.toast.import_success"));
        } else {
          toast.error(t("whitelist.toast.import_error_format"));
        }
      } catch (err) {
        toast.error(t("toast.import.error") + ": " + err);
      }
    };
    reader.readAsText(file);
    e.target.value = ""; // Reset
  };

  const handleExportWhitelist = () => {
    if (!whitelist) return;
    const jsonString = JSON.stringify(whitelist, null, 2);
    const blob = new Blob([jsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "xclearp_whitelist.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    loadWL();
  }, []);

  const loadWL = async () => {
    setLoading(true);
    try {
      const wl = await getWhitelist();
      setWhitelist(wl);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleAddPath = async () => {
    const trimmed = newPath.trim();
    if (!trimmed || !whitelist) return;

    if (whitelist.global_excludes.includes(trimmed)) {
      setNewPath("");
      toast.info(t("whitelist.toast.exists"));
      return;
    }

    const updated = {
      ...whitelist,
      global_excludes: [...whitelist.global_excludes, trimmed],
      show_in_disk_analysis: [...(whitelist.show_in_disk_analysis || []), trimmed]
    };

    try {
      await updateWhitelist(updated);
      setWhitelist(updated);
      setNewPath("");
      toast.success(t("whitelist.toast.add_success").replace("{name}", trimmed));
    } catch (e) {
      setError(t("whitelist.error.add"));
      toast.error(t("toast.rule.error"));
    }
  };

  const handleRemovePath = async (path: string) => {
    if (!whitelist) return;
    const updated = {
      ...whitelist,
      global_excludes: whitelist.global_excludes.filter(p => p !== path),
      disabled_patterns: whitelist.disabled_patterns.filter(p => p !== path),
      show_in_disk_analysis: (whitelist.show_in_disk_analysis || []).filter(p => p !== path)
    };

    try {
      await updateWhitelist(updated);
      setWhitelist(updated);
    } catch (e) {
      setError(t("whitelist.error.delete"));
    }
  };

  const handleToggleEnabled = async (path: string) => {
    if (!whitelist) return;
    const isDisabled = whitelist.disabled_patterns.includes(path);
    const updated = {
      ...whitelist,
      disabled_patterns: isDisabled
        ? whitelist.disabled_patterns.filter(p => p !== path)
        : [...whitelist.disabled_patterns, path]
    };

    try {
      await updateWhitelist(updated);
      setWhitelist(updated);
    } catch (e) {
      setError(t("whitelist.error.toggle"));
    }
  };

  const handleToggleEye = async (path: string) => {
    if (!whitelist) return;
    const showInDisk = whitelist.show_in_disk_analysis || [];
    const isEyeOpen = showInDisk.includes(path);
    const updated = {
      ...whitelist,
      show_in_disk_analysis: isEyeOpen
        ? showInDisk.filter(p => p !== path)
        : [...showInDisk, path]
    };

    try {
      await updateWhitelist(updated);
      setWhitelist(updated);
    } catch (e) {
      setError(t("whitelist.error.eye"));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleAddPath();
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2">
        <Loader2 className="animate-spin text-blue-500 w-8 h-8" />
        <p className="text-sm text-gray-500">{t("whitelist.state.loading")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-1.5">
            <h3 className="text-base font-semibold text-white">{t("whitelist.title")}</h3>
            <Tooltip content={t("whitelist.tooltip.match_rule")}>
              <button
                onClick={() => setShowTip(!showTip)}
                className={`text-gray-400 hover:text-blue-400 transition-colors p-0.5 rounded hover:bg-gray-800/60 ${showTip ? 'text-blue-400' : ''}`}
              >
                <HelpCircle size={16} />
              </button>
            </Tooltip>
          </div>
          <p className="text-xs text-gray-500 mt-0.5 pr-4">
            {t("whitelist.desc")}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <input
            type="file"
            id="import-whitelist-input"
            accept=".json"
            className="hidden"
            onChange={handleImportWhitelist}
          />
          <Tooltip content={t("whitelist.import")}>
            <button
              onClick={() => document.getElementById("import-whitelist-input")?.click()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-gray-850 hover:bg-gray-800 text-gray-300 border border-gray-700 hover:border-gray-600 transition-colors"
            >
              <Upload size={14} /> {t("whitelist.import")}
            </button>
          </Tooltip>
          <Tooltip content={t("whitelist.export")}>
            <button
              onClick={handleExportWhitelist}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-gray-850 hover:bg-gray-800 text-gray-300 border border-gray-700 hover:border-gray-600 transition-colors"
            >
              <Download size={14} /> {t("whitelist.export")}
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Info Notice Banner */}
      {showTip && (
        <div className="flex gap-3 p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs leading-relaxed transition-all duration-200">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <div>
            <span className="font-bold">{t("whitelist.tip.title")}</span>
            {t("whitelist.tip.desc")}
          </div>
        </div>
      )}

      {error && (
        <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Exclude Inputs & List */}
      <div className="bg-gray-850/20 border border-gray-800/80 rounded-xl p-4 space-y-3">
        <h4 className="text-xs font-semibold text-gray-300 tracking-wide uppercase">{t("whitelist.list_title")}</h4>

        {/* Input */}
        <div className="flex gap-2">
          <input
            type="text"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 px-3 py-2 bg-gray-950 border border-gray-850 rounded-xl text-sm text-white placeholder-gray-650 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all"
            placeholder={t("whitelist.placeholder")}
          />
          <button
            onClick={handleAddPath}
            disabled={!newPath.trim()}
            className="flex items-center gap-1 px-4 py-2 rounded-xl text-xs font-semibold bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            <Plus size={14} /> {t("whitelist.action.add")}
          </button>
        </div>

        {/* List of paths */}
        {!whitelist || whitelist.global_excludes.length === 0 ? (
          <div className="py-12 text-center text-gray-600 text-sm">
            {t("whitelist.empty")}
          </div>
        ) : (
          <div className="space-y-2 max-h-[350px] overflow-y-auto custom-scrollbar pr-1">
            {whitelist.global_excludes.map((path) => {
              const enabled = !whitelist.disabled_patterns.includes(path);
              const eyeOpen = whitelist.show_in_disk_analysis?.includes(path) ?? false;
              return (
              <div
                key={path}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl bg-gray-950 border transition-all ${
                  enabled
                    ? "border-gray-850/60 hover:bg-gray-850/20"
                    : "border-gray-900/40 opacity-50"
                }`}
              >
                <span className={`text-xs font-semibold select-none px-2 py-0.5 rounded border ${
                  enabled
                    ? "text-blue-400 bg-blue-500/5 border-blue-500/10"
                    : "text-gray-500 bg-gray-700/5 border-gray-700/20"
                }`}>
                  {enabled ? "PASS" : "OFF"}
                </span>
                <Tooltip content={path} className="flex-1 w-0 min-w-0">
                  <span className={`text-xs truncate font-mono select-all w-full cursor-help ${
                    enabled ? "text-gray-300" : "text-gray-500 line-through"
                  }`}>
                    {path}
                  </span>
                </Tooltip>
                <Tooltip content={!enabled ? t("whitelist.rule_disabled") : eyeOpen ? t("whitelist.tooltip.disk_marker") : t("whitelist.tooltip.disk_exclude")}>
                  <button
                    onClick={() => handleToggleEye(path)}
                    disabled={!enabled}
                    className={`p-1.5 rounded-lg transition-all shrink-0 ${
                      !enabled
                        ? "text-gray-750 cursor-not-allowed opacity-30"
                        : eyeOpen
                        ? "text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10"
                        : "text-gray-500 hover:text-gray-300 hover:bg-gray-800/40"
                    }`}
                  >
                    {eyeOpen ? <Eye size={18} /> : <EyeOff size={18} />}
                  </button>
                </Tooltip>
                <Tooltip content={enabled ? t("whitelist.tooltip.toggle_disable") : t("whitelist.tooltip.toggle_enable")}>
                  <button
                    onClick={() => handleToggleEnabled(path)}
                    className={`p-1.5 rounded-lg transition-all shrink-0 ${
                      enabled
                        ? "text-blue-400 hover:text-blue-300 hover:bg-blue-500/10"
                        : "text-gray-600 hover:text-gray-400 hover:bg-gray-800/40"
                    }`}
                  >
                    {enabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
                  </button>
                </Tooltip>
                <Tooltip content={t("whitelist.tooltip.delete")}>
                  <button
                    onClick={() => handleRemovePath(path)}
                    className="text-gray-500 hover:text-red-400 hover:bg-gray-800/40 p-1.5 rounded-lg transition-all shrink-0"
                  >
                    <Trash2 size={14} />
                  </button>
                </Tooltip>
              </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
