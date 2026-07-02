/** RuleEditor — modal form for creating/editing cleanup rules */

import { useState } from "react";
import type { CleanRule, RiskLevel, RuleGroup } from "../types/index";
import { X, Plus, Trash2, ChevronDown } from "lucide-react";

interface RuleEditorProps {
  rule: CleanRule | null; // null = create new
  defaultGroup?: string;
  groups: RuleGroup[];
  onSave: (rule: CleanRule) => void;
  onCancel: () => void;
}

const PLATFORMS = ["windows", "macos", "linux"] as const;
const RISK_LEVELS: RiskLevel[] = ["Safe", "Medium", "High"];

const renderPlatformIcon = (platform: string, className = "w-3.5 h-3.5") => {
  switch (platform) {
    case "windows":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor">
          <path d="M0 3.449L9.75 2.1v9.45H0V3.449zM0 12.45h9.75v9.45L0 20.551v-8.101zM10.95 1.937L24 0v11.55H10.95V1.937zM10.95 12.45H24v11.55l-13.05-1.937v-9.613z"/>
        </svg>
      );
    case "macos":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor">
          <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 4.17c.66-.81 1.11-1.93.99-3.06-1 .04-2.22.67-2.94 1.5-.63.73-1.18 1.87-1.03 2.98.66.05 1.83-.55 2.98-1.42z"/>
        </svg>
      );
    case "linux":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor">
          <path d="M12.01 2c-2.31 0-4.14 1.7-4.14 3.79 0 .84.3 1.62.8 2.26C7.11 9.47 6.01 11.23 6.01 13.29c0 3.25 2.5 5.86 5.59 5.86.35 0 .69-.03 1.03-.1.52.48 1.2.77 1.95.77 1.65 0 2.99-1.4 2.99-3.13 0-.6-.16-1.15-.45-1.63.78-.97 1.27-2.2 1.27-3.56 0-2.06-1.1-3.82-2.66-5.24.5-.64.8-1.42.8-2.26C16.15 3.7 14.32 2 12.01 2zm0 1.5c1.47 0 2.64.9 2.64 2.29S13.48 8 12.01 8c-1.47 0-2.64-.9-2.64-2.21s1.17-2.29 2.64-2.29zm.41 6c2.09 0 3.79 1.7 3.79 3.79 0 .74-.21 1.43-.58 2.01-.73-.86-1.84-1.4-3.08-1.4-1.24 0-2.35.54-3.08 1.4-.37-.58-.58-1.27-.58-2.01 0-2.09 1.7-3.79 3.79-3.79z"/>
        </svg>
      );
    default:
      return null;
  }
};

export default function RuleEditor({
  rule,
  defaultGroup,
  groups,
  onSave,
  onCancel,
}: RuleEditorProps) {
  const [name, setName] = useState(rule?.name ?? "");
  const [description, setDescription] = useState(rule?.description ?? "");
  const [group, setGroup] = useState(rule?.group ?? defaultGroup ?? groups[0]?.id ?? "");
  const [platforms, setPlatforms] = useState<string[]>(rule?.platforms ?? ["macos"]);
  const [paths, setPaths] = useState<string[]>(rule?.paths ?? [""]);
  const [filePatterns, setFilePatterns] = useState<string[]>(rule?.file_patterns ?? ["*"]);
  const [excludePatterns, setExcludePatterns] = useState<string[]>(rule?.exclude_patterns ?? []);
  const [minAgeHours, setMinAgeHours] = useState<string>(rule?.min_age_hours?.toString() ?? "");
  const [riskLevel, setRiskLevel] = useState<RiskLevel>(rule?.risk_level ?? "Safe");

  const togglePlatform = (p: string) => {
    setPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
    );
  };

  const updateListItem = (
    list: string[],
    setter: (v: string[]) => void,
    index: number,
    value: string,
  ) => {
    const next = [...list];
    next[index] = value;
    setter(next);
  };

  const addListItem = (list: string[], setter: (v: string[]) => void) => {
    setter([...list, ""]);
  };

  const removeListItem = (
    list: string[],
    setter: (v: string[]) => void,
    index: number,
  ) => {
    setter(list.filter((_, i) => i !== index));
  };

  const handleSave = () => {
    const newRule: CleanRule = {
      id: rule?.id ?? crypto.randomUUID(),
      name,
      group,
      description,
      platforms,
      paths: paths.filter((p) => p.trim() !== ""),
      file_patterns: filePatterns.filter((p) => p.trim() !== ""),
      exclude_patterns: excludePatterns.filter((p) => p.trim() !== ""),
      min_age_hours: minAgeHours ? parseInt(minAgeHours, 10) : null,
      max_size_mb: rule?.max_size_mb ?? null,
      risk_level: riskLevel,
      enabled: rule?.enabled ?? true,
    };
    onSave(newRule);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
      <div className="bg-gray-900/90 border border-gray-800 shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col rounded-2xl m-4 overflow-hidden backdrop-blur-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 bg-gray-950/20 shrink-0">
          <h3 className="text-sm font-bold text-white tracking-wide">
            {rule ? "编辑清理规则" : "添加清理规则"}
          </h3>
          <button
            onClick={onCancel}
            className="text-gray-500 hover:text-white p-1.5 rounded-lg hover:bg-gray-800/60 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Scrollable Form Body */}
        <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-5 space-y-5">
          
          {/* Rule Name */}
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider">规则名称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-gray-950 border border-gray-800 rounded-xl text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all"
              placeholder="例如：Chrome 缓存清理"
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider">描述</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 bg-gray-950 border border-gray-800 rounded-xl text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all"
              placeholder="此规则清理的文件范围和作用..."
            />
          </div>

          {/* Group Dropdown Selector */}
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider">所属分组</label>
            <div className="relative">
              <select
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                className="w-full appearance-none px-3 py-2.5 bg-gray-950 border border-gray-800 rounded-xl text-sm text-white cursor-pointer focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all"
              >
                {groups.map((g) => (
                  <option key={g.id} value={g.id} className="bg-gray-900 text-gray-100">
                    {g.name}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-gray-500">
                <ChevronDown size={16} />
              </div>
            </div>
          </div>

          {/* Platforms Selector */}
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider">适用平台</label>
            <div className="flex gap-2">
              {PLATFORMS.map((p) => {
                const isSelected = platforms.includes(p);
                return (
                  <button
                    key={p}
                    onClick={() => togglePlatform(p)}
                    className={`flex-1 flex items-center justify-center gap-2.5 px-3 py-2 rounded-xl text-xs font-semibold border transition-all ${
                      isSelected
                        ? "bg-blue-600/10 border-blue-500/50 text-blue-400"
                        : "bg-gray-950 border-gray-800 text-gray-500 hover:border-gray-700 hover:text-gray-300"
                    }`}
                  >
                    {renderPlatformIcon(p)}
                    <span className="capitalize">{p === "macos" ? "macOS" : p}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Paths Input List */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider">路径列表</label>
            <div className="space-y-2">
              {paths.map((p, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    type="text"
                    value={p}
                    onChange={(e) => updateListItem(paths, setPaths, i, e.target.value)}
                    className="flex-1 px-3 py-2 bg-gray-950 border border-gray-800 rounded-xl text-sm text-white placeholder-gray-650 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all"
                    placeholder="如：~/Library/Caches/Chrome"
                  />
                  {paths.length > 1 && (
                    <button
                      onClick={() => removeListItem(paths, setPaths, i)}
                      className="text-gray-500 hover:text-red-400 hover:bg-gray-800/50 p-2 rounded-xl transition-colors shrink-0"
                      title="删除路径"
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              onClick={() => addListItem(paths, setPaths)}
              className="inline-flex items-center gap-1 text-xs font-semibold text-blue-400 hover:text-blue-300 transition-colors mt-1"
            >
              <Plus size={14} /> 添加新路径
            </button>
          </div>

          {/* File patterns list */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider">文件匹配模式</label>
            <div className="space-y-2">
              {filePatterns.map((p, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    type="text"
                    value={p}
                    onChange={(e) => updateListItem(filePatterns, setFilePatterns, i, e.target.value)}
                    className="flex-1 px-3 py-2 bg-gray-950 border border-gray-800 rounded-xl text-sm text-white placeholder-gray-650 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all"
                    placeholder="如：*.tmp"
                  />
                  {filePatterns.length > 1 && (
                    <button
                      onClick={() => removeListItem(filePatterns, setFilePatterns, i)}
                      className="text-gray-500 hover:text-red-400 hover:bg-gray-800/50 p-2 rounded-xl transition-colors shrink-0"
                      title="删除匹配模式"
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              onClick={() => addListItem(filePatterns, setFilePatterns)}
              className="inline-flex items-center gap-1 text-xs font-semibold text-blue-400 hover:text-blue-300 transition-colors mt-1"
            >
              <Plus size={14} /> 添加匹配模式
            </button>
          </div>

          {/* Exclude patterns (Whitelist) */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider">排除模式（白名单）</label>
            <div className="space-y-2">
              {excludePatterns.map((p, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    type="text"
                    value={p}
                    onChange={(e) => updateListItem(excludePatterns, setExcludePatterns, i, e.target.value)}
                    className="flex-1 px-3 py-2 bg-gray-950 border border-gray-800 rounded-xl text-sm text-white placeholder-gray-650 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all"
                    placeholder="如：important_*"
                  />
                  <button
                    onClick={() => removeListItem(excludePatterns, setExcludePatterns, i)}
                    className="text-gray-500 hover:text-red-400 hover:bg-gray-800/50 p-2 rounded-xl transition-colors shrink-0"
                    title="删除排除"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={() => addListItem(excludePatterns, setExcludePatterns)}
              className="inline-flex items-center gap-1 text-xs font-semibold text-blue-400 hover:text-blue-300 transition-colors mt-1"
            >
              <Plus size={14} /> 添加排除模式
            </button>
          </div>

          {/* Min Age */}
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider">最小文件年龄（小时）</label>
            <input
              type="number"
              value={minAgeHours}
              onChange={(e) => setMinAgeHours(e.target.value)}
              className="w-full px-3 py-2 bg-gray-950 border border-gray-800 rounded-xl text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all"
              placeholder="留空表示不限，只清理此年龄以上的文件"
            />
          </div>

          {/* Risk Level Selector */}
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider">风险等级</label>
            <div className="flex gap-2">
              {RISK_LEVELS.map((level) => {
                const isSelected = riskLevel === level;
                let activeClass = "";
                if (isSelected) {
                  activeClass = level === "High"
                    ? "bg-red-500/10 border-red-500/40 text-red-400"
                    : level === "Medium"
                      ? "bg-yellow-500/10 border-yellow-500/40 text-yellow-400"
                      : "bg-emerald-500/10 border-emerald-500/40 text-emerald-400";
                }
                return (
                  <button
                    key={level}
                    onClick={() => setRiskLevel(level)}
                    className={`flex-1 px-3 py-2.5 rounded-xl text-xs font-semibold border transition-all ${
                      isSelected
                        ? activeClass
                        : "bg-gray-950 border-gray-800 text-gray-500 hover:border-gray-700 hover:text-gray-400"
                    }`}
                  >
                    {level === "Safe" ? "安全" : level === "Medium" ? "中风险" : "高风险"}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-800 bg-gray-950/20 shrink-0">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-gray-400 hover:text-white hover:bg-gray-850 transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim()}
            className="px-5 py-2 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-lg shadow-blue-650/10"
          >
            保存规则
          </button>
        </div>
      </div>
    </div>
  );
}
