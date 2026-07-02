/** WhitelistManager — manage whitelist paths with backend persistence */

import { useState, useEffect } from "react";
import { getWhitelist, updateWhitelist, type Whitelist } from "../lib/ipc";
import { Trash2, Plus, AlertCircle, Loader2, ToggleLeft, ToggleRight, Download, Upload, HelpCircle, Eye, EyeOff } from "lucide-react";
import Tooltip from "./Tooltip";
import { useToast } from "./Toast";

export default function WhitelistManager() {
  const toast = useToast();
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
          toast.success("导入白名单成功！");
        } else {
          toast.error("非法的白名单 JSON 格式，期望是一个对象");
        }
      } catch (err) {
        toast.error("导入失败: " + err);
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
      toast.info("该路径已存在于全局排除白名单中。");
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
      toast.success(`已将 "${trimmed}" 成功添加到全局排除白名单中！`);
    } catch (e) {
      setError("添加失败，无法更新白名单");
      toast.error("添加白名单失败，请重试");
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
      setError("删除失败，无法更新白名单");
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
      setError("切换失败，无法更新白名单");
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
      setError("切换小眼睛状态失败，无法更新白名单");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleAddPath();
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2">
        <Loader2 className="animate-spin text-blue-500 w-8 h-8" />
        <p className="text-sm text-gray-500">正在加载白名单配置...</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-1.5">
            <h3 className="text-base font-semibold text-white">全局白名单</h3>
            <Tooltip content="显示/隐藏匹配规则提示">
              <button
                onClick={() => setShowTip(!showTip)}
                className={`text-gray-400 hover:text-blue-400 transition-colors p-0.5 rounded hover:bg-gray-800/60 ${showTip ? 'text-blue-400' : ''}`}
              >
                <HelpCircle size={16} />
              </button>
            </Tooltip>
          </div>
          <p className="text-xs text-gray-500 mt-0.5 pr-4">
            配置在此处的路径和通配符规则将永远不会被系统扫描或清理，有效保护您的关键项目与个人隐私数据。
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
          <Tooltip content="从 JSON 文件导入白名单排除项">
            <button
              onClick={() => document.getElementById("import-whitelist-input")?.click()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 hover:border-gray-600 transition-colors"
            >
              <Upload size={14} /> 导入白名单
            </button>
          </Tooltip>
          <Tooltip content="导出当前白名单排除项为 JSON 文件">
            <button
              onClick={handleExportWhitelist}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 hover:border-gray-600 transition-colors"
            >
              <Download size={14} /> 导出白名单
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Info Notice Banner */}
      {showTip && (
        <div className="flex gap-3 p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs leading-relaxed transition-all duration-200">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <div>
            <span className="font-bold">匹配规则提示：</span>
            白名单采用标准 Glob 通配符模式。例如：
            <code className="mx-1 px-1 bg-blue-500/20 rounded font-mono">**/.git/**</code> 会自动忽略任何子目录中的 Git 仓库信息；
            <code className="mx-1 px-1 bg-blue-500/20 rounded font-mono">**/node_modules/**</code> 会保护依赖缓存；
            <code className="mx-1 px-1 bg-blue-500/20 rounded font-mono">*.key</code> 会过滤所有密钥后缀的文件。
          </div>
        </div>
      )}

      {error && (
        <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Exclude Inputs & List */}
      <div className="bg-gray-800/20 border border-gray-800/80 rounded-xl p-4 space-y-3">
        <h4 className="text-xs font-semibold text-gray-300 tracking-wide uppercase">排除路径列表</h4>

        {/* Input */}
        <div className="flex gap-2">
          <input
            type="text"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 px-3 py-2 bg-gray-950 border border-gray-850 rounded-xl text-sm text-white placeholder-gray-650 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all"
            placeholder="输入要全局排除的路径或文件名模式，例如 **/my_documents/**"
          />
          <button
            onClick={handleAddPath}
            disabled={!newPath.trim()}
            className="flex items-center gap-1 px-4 py-2 rounded-xl text-xs font-semibold bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            <Plus size={14} /> 添加路径
          </button>
        </div>

        {/* List of paths */}
        {!whitelist || whitelist.global_excludes.length === 0 ? (
          <div className="py-12 text-center text-gray-600 text-sm">
            暂无全局白名单路径，点击上方“添加”新增规则
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
                <Tooltip content={!enabled ? "规则已禁用" : eyeOpen ? "白名单标记：磁盘分析扫描时显示并标记" : "完全排除：磁盘分析不扫描该路径"}>
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
                <Tooltip content={enabled ? "点击禁用该规则" : "点击启用该规则"}>
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
                <Tooltip content="删除规则">
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
