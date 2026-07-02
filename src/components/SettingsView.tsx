import { useState, useEffect } from "react";
import type { RuleGroup, CleanRule } from "../types/index";
import RuleEditor from "./RuleEditor";
import WhitelistManager from "./WhitelistManager";
import {
  Sliders,
  ListCollapse,
  Info,
  Plus,
  Edit2,
  Check,
  AlertCircle,
  Trash2,
  Globe,
  Folder,
  HardDrive,
  Code,
  AlertTriangle,
  Database,
  Cpu,
  Settings as SettingsIcon,
  X,
  FolderPlus,
  ShieldCheck,
  Hammer,
  Download,
  Upload
} from "lucide-react";

interface SettingsViewProps {
  groups: RuleGroup[];
  loading: boolean;
  onToggleRule: (rule: CleanRule) => void;
  onAddRule: (rule: CleanRule) => void;
  onEditRule: (rule: CleanRule) => void;
  onAddGroup: (name: string, description: string, icon: string) => Promise<void>;
  onDeleteGroup: (id: string) => Promise<void>;
  onImportRules?: (rules: CleanRule[]) => Promise<void>;
}

type SettingsTab = "general" | "rules" | "whitelist" | "about";

const AVAILABLE_ICONS = [
  { name: "folder", label: "文件夹" },
  { name: "globe", label: "浏览器" },
  { name: "hard-drive", label: "磁盘" },
  { name: "code", label: "代码" },
  { name: "trash-2", label: "废纸篓" },
  { name: "alert-triangle", label: "警告" },
  { name: "database", label: "数据库" },
  { name: "cpu", label: "系统" },
  { name: "settings", label: "配置" }
];

export default function SettingsView({
  groups,
  loading,
  onToggleRule,
  onAddRule,
  onEditRule,
  onAddGroup,
  onDeleteGroup,
  onImportRules,
}: SettingsViewProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [editingRule, setEditingRule] = useState<CleanRule | null>(null);
  const [showNewRule, setShowNewRule] = useState<string | null>(null);

  // Group creation modal state
  const [showNewGroupModal, setShowNewGroupModal] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupDesc, setNewGroupDesc] = useState("");
  const [newGroupIcon, setNewGroupIcon] = useState("folder");

  const handleImportRulesClick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const content = event.target?.result as string;
        const parsed = JSON.parse(content);
        const rulesToImport = Array.isArray(parsed) ? parsed : [parsed];
        
        if (rulesToImport.length > 0 && rulesToImport[0].id && rulesToImport[0].name) {
          if (onImportRules) {
            await onImportRules(rulesToImport);
            alert("规则导入成功！");
          }
        } else {
          alert("规则 JSON 格式不正确，期望是一个规则数组或规则对象");
        }
      } catch (err) {
        alert("导入失败: " + err);
      }
    };
    reader.readAsText(file);
    e.target.value = ""; // Reset
  };

  const handleExportRulesClick = () => {
    const allRules = groups.flatMap(g => g.rules);
    const jsonString = JSON.stringify(allRules, null, 2);
    const blob = new Blob([jsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "xclearp_rules.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  // Local storage for general settings
  const [generalSettings, setGeneralSettings] = useState(() => {
    const saved = localStorage.getItem("xclearp_settings");
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        // use defaults
      }
    }
    return {
      startup: false,
      minToTray: true,
      notifyOnComplete: true,
      deepScan: false,
    };
  });

  useEffect(() => {
    localStorage.setItem("xclearp_settings", JSON.stringify(generalSettings));
  }, [generalSettings]);

  const toggleSetting = (key: keyof typeof generalSettings) => {
    setGeneralSettings((prev: any) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const toggleGroup = (id: string) => {
    setExpandedGroup((prev) => (prev === id ? null : id));
  };

  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) return;
    try {
      await onAddGroup(newGroupName.trim(), newGroupDesc.trim(), newGroupIcon);
      setNewGroupName("");
      setNewGroupDesc("");
      setNewGroupIcon("folder");
      setShowNewGroupModal(false);
    } catch (e) {
      console.error("Failed to create group:", e);
    }
  };

  const handleDeleteGroupClick = async (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation(); // Prevent toggling accordion
    if (confirm(`确认要删除规则组 "${name}" 吗？该组下的所有自定义规则也将被物理删除。`)) {
      try {
        await onDeleteGroup(id);
        if (expandedGroup === id) {
          setExpandedGroup(null);
        }
      } catch (err) {
        console.error("Failed to delete group:", err);
      }
    }
  };

  const renderIcon = (iconName: string, className = "w-5 h-5") => {
    switch (iconName) {
      case "globe": return <Globe className={`${className} text-blue-400`} />;
      case "folder": return <Folder className={`${className} text-amber-400`} />;
      case "hard-drive": return <HardDrive className={`${className} text-purple-400`} />;
      case "code": return <Code className={`${className} text-emerald-400`} />;
      case "trash-2": return <Trash2 className={`${className} text-red-400`} />;
      case "alert-triangle": return <AlertTriangle className={`${className} text-yellow-400`} />;
      case "hammer": return <Hammer className={`${className} text-orange-400`} />;
      case "database": return <Database className={`${className} text-pink-400`} />;
      case "cpu": return <Cpu className={`${className} text-indigo-400`} />;
      case "settings": return <SettingsIcon className={`${className} text-cyan-400`} />;
      default: return <Folder className={`${className} text-blue-400`} />;
    }
  };

  const renderPlatformIcon = (platform: string, className = "w-3 h-3") => {
    switch (platform) {
      case "windows":
        return (
          <svg className={`${className} text-blue-400`} viewBox="0 0 24 24" fill="currentColor">
            <path d="M0 3.449L9.75 2.1v9.45H0V3.449zM0 12.45h9.75v9.45L0 20.551v-8.101zM10.95 1.937L24 0v11.55H10.95V1.937zM10.95 12.45H24v11.55l-13.05-1.937v-9.613z"/>
          </svg>
        );
      case "macos":
        return (
          <svg className={`${className} text-gray-300`} viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 4.17c.66-.81 1.11-1.93.99-3.06-1 .04-2.22.67-2.94 1.5-.63.73-1.18 1.87-1.03 2.98.66.05 1.83-.55 2.98-1.42z"/>
          </svg>
        );
      case "linux":
        return (
          <svg className={`${className} text-amber-500`} viewBox="0 0 24 24" fill="currentColor">
            <path d="M12.01 2c-2.31 0-4.14 1.7-4.14 3.79 0 .84.3 1.62.8 2.26C7.11 9.47 6.01 11.23 6.01 13.29c0 3.25 2.5 5.86 5.59 5.86.35 0 .69-.03 1.03-.1.52.48 1.2.77 1.95.77 1.65 0 2.99-1.4 2.99-3.13 0-.6-.16-1.15-.45-1.63.78-.97 1.27-2.2 1.27-3.56 0-2.06-1.1-3.82-2.66-5.24.5-.64.8-1.42.8-2.26C16.15 3.7 14.32 2 12.01 2zm0 1.5c1.47 0 2.64.9 2.64 2.29S13.48 8 12.01 8c-1.47 0-2.64-.9-2.64-2.21s1.17-2.29 2.64-2.29zm.41 6c2.09 0 3.79 1.7 3.79 3.79 0 .74-.21 1.43-.58 2.01-.73-.86-1.84-1.4-3.08-1.4-1.24 0-2.35.54-3.08 1.4-.37-.58-.58-1.27-.58-2.01 0-2.09 1.7-3.79 3.79-3.79z"/>
          </svg>
        );
      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      {/* Title */}
      <div>
        <h2 className="text-2xl font-bold text-white tracking-tight">系统设置</h2>
        <p className="text-sm text-gray-400 mt-1">
          在这里管理您的个人偏好、自启动行为以及清理扫描的规则库。
        </p>
      </div>

      {/* Settings Panel Container */}
      <div className="flex flex-col bg-gray-900/60 rounded-2xl border border-gray-800 backdrop-blur-md min-h-[500px] overflow-hidden">
        {/* Settings Top Tab Menu */}
        <div className="border-b border-gray-800 bg-gray-950/20 px-6 flex flex-row gap-6 shrink-0">
          <button
            onClick={() => setActiveTab("general")}
            className={`flex items-center gap-2 px-1 py-4 border-b-2 text-sm font-medium transition-all duration-200 -mb-[2px] ${
              activeTab === "general"
                ? "border-blue-500 text-blue-400 font-semibold"
                : "border-transparent text-gray-400 hover:text-gray-200 hover:border-gray-700/45"
            }`}
          >
            <Sliders size={16} />
            通用设置
          </button>
          <button
            onClick={() => setActiveTab("rules")}
            className={`flex items-center gap-2 px-1 py-4 border-b-2 text-sm font-medium transition-all duration-200 -mb-[2px] ${
              activeTab === "rules"
                ? "border-blue-500 text-blue-400 font-semibold"
                : "border-transparent text-gray-400 hover:text-gray-200 hover:border-gray-700/45"
            }`}
          >
            <ListCollapse size={16} />
            清理规则
          </button>
          <button
            onClick={() => setActiveTab("whitelist")}
            className={`flex items-center gap-2 px-1 py-4 border-b-2 text-sm font-medium transition-all duration-200 -mb-[2px] ${
              activeTab === "whitelist"
                ? "border-blue-500 text-blue-400 font-semibold"
                : "border-transparent text-gray-400 hover:text-gray-200 hover:border-gray-700/45"
            }`}
          >
            <ShieldCheck size={16} />
            白名单
          </button>
          <button
            onClick={() => setActiveTab("about")}
            className={`flex items-center gap-2 px-1 py-4 border-b-2 text-sm font-medium transition-all duration-200 -mb-[2px] ${
              activeTab === "about"
                ? "border-blue-500 text-blue-400 font-semibold"
                : "border-transparent text-gray-400 hover:text-gray-200 hover:border-gray-700/45"
            }`}
          >
            <Info size={16} />
            关于软件
          </button>
        </div>

        {/* Settings Content Area */}
        <div className="flex-1 p-6 overflow-y-auto custom-scrollbar bg-gray-900/10">
          {activeTab === "general" && (
            <div className="space-y-6">
              <div>
                <h3 className="text-base font-semibold text-white">通用配置</h3>
                <p className="text-xs text-gray-500 mt-0.5">控制程序启动与核心清理行为</p>
              </div>

              <div className="space-y-4">
                {/* Startup Switch */}
                <div className="flex items-start justify-between p-4 rounded-xl bg-gray-800/20 border border-gray-800/50 hover:bg-gray-800/30 transition-all duration-150">
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-gray-200 cursor-pointer" onClick={() => toggleSetting("startup")}>
                      开机自启动
                    </label>
                    <p className="text-xs text-gray-400">在您的系统登录时自动启动 XClearp 工具</p>
                  </div>
                  <button
                    onClick={() => toggleSetting("startup")}
                    className={`relative w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none ${
                      generalSettings.startup ? "bg-blue-600" : "bg-gray-700"
                    }`}
                  >
                    <span
                      className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform duration-200 ${
                        generalSettings.startup ? "translate-x-5" : ""
                      }`}
                    />
                  </button>
                </div>

                {/* Min to Tray */}
                <div className="flex items-start justify-between p-4 rounded-xl bg-gray-800/20 border border-gray-800/50 hover:bg-gray-800/30 transition-all duration-150">
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-gray-200 cursor-pointer" onClick={() => toggleSetting("minToTray")}>
                      关闭窗口时最小化
                    </label>
                    <p className="text-xs text-gray-400">点击关闭 (X) 按钮时将程序隐藏到托盘而不是直接退出</p>
                  </div>
                  <button
                    onClick={() => toggleSetting("minToTray")}
                    className={`relative w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none ${
                      generalSettings.minToTray ? "bg-blue-600" : "bg-gray-700"
                    }`}
                  >
                    <span
                      className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform duration-200 ${
                        generalSettings.minToTray ? "translate-x-5" : ""
                      }`}
                    />
                  </button>
                </div>

                {/* Notify on complete */}
                <div className="flex items-start justify-between p-4 rounded-xl bg-gray-800/20 border border-gray-800/50 hover:bg-gray-800/30 transition-all duration-150">
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-gray-200 cursor-pointer" onClick={() => toggleSetting("notifyOnComplete")}>
                      清理完成系统通知
                    </label>
                    <p className="text-xs text-gray-400">当扫描和垃圾清理任务完成时，通过系统横幅通知您</p>
                  </div>
                  <button
                    onClick={() => toggleSetting("notifyOnComplete")}
                    className={`relative w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none ${
                      generalSettings.notifyOnComplete ? "bg-blue-600" : "bg-gray-700"
                    }`}
                  >
                    <span
                      className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform duration-200 ${
                        generalSettings.notifyOnComplete ? "translate-x-5" : ""
                      }`}
                    />
                  </button>
                </div>

                {/* Deep Scan Mode */}
                <div className="flex items-start justify-between p-4 rounded-xl bg-gray-800/20 border border-gray-800/50 hover:bg-gray-800/30 transition-all duration-150">
                  <div className="space-y-1 flex-1 pr-4">
                    <div className="flex items-center gap-2">
                      <label className="text-sm font-medium text-gray-200 cursor-pointer" onClick={() => toggleSetting("deepScan")}>
                        深度检索模式
                      </label>
                      <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
                        <AlertCircle size={10} /> 耗时较长
                      </span>
                    </div>
                    <p className="text-xs text-gray-400">启用该项后，将执行完整的目录层级穿透扫描，查找更隐蔽的缓存残留</p>
                  </div>
                  <button
                    onClick={() => toggleSetting("deepScan")}
                    className={`relative w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none ${
                      generalSettings.deepScan ? "bg-blue-600" : "bg-gray-700"
                    }`}
                  >
                    <span
                      className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform duration-200 ${
                        generalSettings.deepScan ? "translate-x-5" : ""
                      }`}
                    />
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === "rules" && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-semibold text-white">清理规则库</h3>
                  <p className="text-xs text-gray-500 mt-0.5">配置与增删您的文件清理分组及其包含的文件匹配规则</p>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="file"
                    id="import-rules-input"
                    accept=".json"
                    className="hidden"
                    onChange={handleImportRulesClick}
                  />
                  <button
                    onClick={() => document.getElementById("import-rules-input")?.click()}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 hover:border-gray-600 transition-colors"
                    title="从 JSON 文件导入清理规则"
                  >
                    <Upload size={14} /> 导入规则
                  </button>
                  <button
                    onClick={handleExportRulesClick}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 hover:border-gray-600 transition-colors"
                    title="导出所有清理规则为 JSON 文件"
                  >
                    <Download size={14} /> 导出规则
                  </button>
                  <button
                    onClick={() => setShowNewGroupModal(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                  >
                    <FolderPlus size={14} /> 新建规则组
                  </button>
                </div>
              </div>

              {loading ? (
                <div className="flex items-center justify-center h-48">
                  <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent" />
                </div>
              ) : (
                <div className="space-y-3">
                  {groups.map((group) => {
                    const isExpanded = expandedGroup === group.id;
                    const enabledCount = group.rules.filter((r) => r.enabled).length;

                    return (
                      <div
                        key={group.id}
                        className="bg-gray-800/20 rounded-xl border border-gray-800/80 overflow-hidden transition-all duration-200"
                      >
                        {/* Group Header */}
                        <div
                          onClick={() => toggleGroup(group.id)}
                          className="w-full flex items-center gap-4 px-4 py-3.5 hover:bg-gray-800/40 transition-colors cursor-pointer"
                        >
                          <span className="shrink-0">{renderIcon(group.icon)}</span>
                          <div className="flex-1 text-left min-w-0">
                            <h4 className="text-sm font-semibold text-gray-200 truncate">{group.name}</h4>
                            <p className="text-xs text-gray-400 truncate mt-0.5">{group.description}</p>
                          </div>
                          <div className="text-right mr-1 shrink-0 flex items-center gap-3">
                            <span className="text-xs text-gray-500">
                              {enabledCount}/{group.rules.length} 启用
                            </span>
                            {/* Delete Group Button */}
                            <button
                              onClick={(e) => handleDeleteGroupClick(e, group.id, group.name)}
                              className="text-gray-500 hover:text-red-400 p-1 rounded hover:bg-gray-800/60 transition-colors"
                              title="删除此分组"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                          <svg
                            className={`w-4 h-4 text-gray-500 shrink-0 transition-transform duration-200 ${
                              isExpanded ? "rotate-180" : ""
                            }`}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </div>

                        {/* Rules Expanded list */}
                        {isExpanded && (
                          <div className="border-t border-gray-800 px-4 py-3 space-y-2 bg-gray-950/20">
                            {group.rules.length === 0 ? (
                              <p className="text-xs text-gray-500 text-center py-2">暂无规则，请点击下方按钮新建</p>
                            ) : (
                              group.rules.map((rule) => (
                                <div
                                  key={rule.id}
                                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-gray-800/30 border border-gray-800/40 hover:bg-gray-800/60 transition-colors"
                                >
                                  {/* Switch toggle */}
                                  <button
                                    onClick={() => onToggleRule({ ...rule, enabled: !rule.enabled })}
                                    className={`relative w-9 h-5 rounded-full transition-colors duration-200 shrink-0 ${
                                      rule.enabled ? "bg-blue-600" : "bg-gray-700"
                                    }`}
                                  >
                                    <span
                                      className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200 ${
                                        rule.enabled ? "translate-x-4" : ""
                                      }`}
                                    />
                                  </button>

                                  {/* Rule Info */}
                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs font-medium text-gray-200 truncate">{rule.name}</p>
                                    <p className="text-[10px] text-gray-500 truncate">{rule.description}</p>
                                  </div>

                                  {/* Platform Indicators */}
                                  <div className="flex items-center gap-1.5">
                                    {rule.platforms.map((p) => (
                                      <span
                                        key={p}
                                        className="p-1 rounded bg-gray-800/40 border border-gray-700/30 flex items-center justify-center"
                                        title={p}
                                      >
                                        {renderPlatformIcon(p, "w-3 h-3")}
                                      </span>
                                    ))}
                                  </div>

                                  {/* Risk Level Badge */}
                                  <span
                                    className={`text-[9px] px-2 py-0.5 rounded-full font-semibold border ${
                                      rule.risk_level === "High"
                                        ? "bg-red-500/10 text-red-400 border-red-500/20"
                                        : rule.risk_level === "Medium"
                                          ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/20"
                                          : "bg-green-500/10 text-green-400 border-green-500/20"
                                    }`}
                                  >
                                    {rule.risk_level === "High" ? "高风险" : rule.risk_level === "Medium" ? "中等" : "安全"}
                                  </span>

                                  {/* Edit Button */}
                                  <button
                                    onClick={() => setEditingRule(rule)}
                                    className="text-gray-500 hover:text-blue-400 transition-colors p-1.5 rounded-md hover:bg-gray-800/80"
                                    title="编辑规则"
                                  >
                                    <Edit2 size={13} />
                                  </button>
                                </div>
                              ))
                            )}

                            {/* Add Rule Button */}
                            <button
                              onClick={() => setShowNewRule(group.id)}
                              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-dashed border-gray-800 text-gray-500 hover:border-blue-500/50 hover:text-blue-400 transition-all text-xs bg-gray-950/10"
                            >
                              <Plus size={14} /> 添加规则
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === "whitelist" && (
            <WhitelistManager />
          )}

          {activeTab === "about" && (
            <div className="space-y-6 flex flex-col items-center py-6">
              {/* Product Logo / Graphics */}
              <div className="relative">
                <div className="w-20 h-20 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center shadow-xl shadow-blue-500/10">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-white">
                    <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M2 17L12 22L22 17" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M2 12L12 17L22 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                <span className="absolute -bottom-2 -right-2 px-1.5 py-0.5 bg-blue-500 text-[10px] font-bold text-white rounded-md tracking-wider">
                  v0.1.0
                </span>
              </div>

              {/* Description */}
              <div className="text-center space-y-2 max-w-sm">
                <h3 className="text-lg font-bold text-white tracking-tight">XClearp System Utility</h3>
                <p className="text-xs text-gray-400 leading-relaxed">
                  跨平台桌面系统清理利器。基于 Tauri + React 构建，致力于提供极速、低内存占用且安全的系统缓存与冗余垃圾清理方案。
                </p>
              </div>

              {/* Status checklist */}
              <div className="w-full max-w-sm border border-gray-800/80 bg-gray-800/10 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between text-xs border-b border-gray-800 pb-2">
                  <span className="text-gray-400">核心引擎</span>
                  <span className="text-emerald-400 flex items-center gap-1 font-medium">
                    <Check size={12} /> 已连接 (Tauri Core)
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs border-b border-gray-800 pb-2">
                  <span className="text-gray-400">运行平台</span>
                  <span className="text-gray-300 font-medium">macOS (darwin-x64)</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-400">最新状态</span>
                  <span className="text-gray-400 hover:text-blue-400 cursor-pointer transition-colors">
                    已是最新版本
                  </span>
                </div>
              </div>

              {/* Footer text */}
              <div className="text-[10px] text-gray-600 text-center mt-4">
                <p>© 2026 XClearp Authors. Released under the MIT License.</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Rule Group Creation Modal */}
      {showNewGroupModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl w-full max-w-md m-4 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-850 bg-gray-950/20">
              <h3 className="text-sm font-bold text-white">新建清理规则分组</h3>
              <button
                onClick={() => setShowNewGroupModal(false)}
                className="text-gray-500 hover:text-gray-300 transition-colors p-1"
              >
                <X size={16} />
              </button>
            </div>

            {/* Body */}
            <div className="px-6 py-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1">分组名称</label>
                <input
                  type="text"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-950 border border-gray-800 rounded-lg text-sm text-white placeholder-gray-650 focus:outline-none focus:border-blue-500 transition-colors"
                  placeholder="例如：微信垃圾清理"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1">分组描述</label>
                <input
                  type="text"
                  value={newGroupDesc}
                  onChange={(e) => setNewGroupDesc(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-950 border border-gray-800 rounded-lg text-sm text-white placeholder-gray-655 focus:outline-none focus:border-blue-500 transition-colors"
                  placeholder="描述此分组清理的对象与范围..."
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5">选择分组图标</label>
                <div className="grid grid-cols-3 gap-2">
                  {AVAILABLE_ICONS.map((ico) => {
                    const isSelected = newGroupIcon === ico.name;
                    return (
                      <button
                        key={ico.name}
                        onClick={() => setNewGroupIcon(ico.name)}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-all ${
                          isSelected
                            ? "bg-blue-600/10 border-blue-500 text-blue-400"
                            : "bg-gray-950 border-gray-850 text-gray-400 hover:border-gray-700 hover:text-gray-300"
                        }`}
                      >
                        {renderIcon(ico.name, "w-4 h-4")}
                        <span>{ico.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-850 bg-gray-950/10">
              <button
                onClick={() => setShowNewGroupModal(false)}
                className="px-4 py-2 rounded-lg text-xs text-gray-400 hover:text-white hover:bg-gray-850 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleCreateGroup}
                disabled={!newGroupName.trim()}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                创建分组
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rule editor modal */}
      {(editingRule || showNewRule) && (
        <RuleEditor
          rule={editingRule}
          defaultGroup={showNewRule ?? undefined}
          groups={groups}
          onSave={(rule) => {
            if (editingRule) {
              onEditRule(rule);
            } else {
              onAddRule(rule);
            }
            setEditingRule(null);
            setShowNewRule(null);
          }}
          onCancel={() => {
            setEditingRule(null);
            setShowNewRule(null);
          }}
        />
      )}
    </div>
  );
}
