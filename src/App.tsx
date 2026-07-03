/** App — main layout integrating all components */

import { useState, useEffect } from "react";
import type { Page, CleanRule } from "./types/index";
import { useGroups } from "./hooks/useGroups";
import { useScanStream } from "./hooks/useScanStream";
import { useCleanStream } from "./hooks/useCleanStream";
import Sidebar from "./components/Sidebar";
import SettingsView from "./components/SettingsView";
import ScanView from "./components/ScanView";
import CleanProgress from "./components/CleanProgress";
import DiskAnalysis from "./components/DiskAnalysis";
import UninstallView from "./components/UninstallView";

function App() {
  const [currentPage, setCurrentPage] = useState<Page>("scan");
  const { groups, loading, error: groupsError, updateRule, addCustomRule, addGroup, deleteGroup, deleteRule, refresh } = useGroups();
  const scan = useScanStream();
  const clean = useCleanStream(scan.removeFile);

  const [generalSettings, setGeneralSettings] = useState(() => {
    const saved = localStorage.getItem("xclearp_settings");
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {}
    }
    return {
      startup: false,
      minToTray: true,
      notifyOnComplete: true,
      deepScan: false,
      theme: "system",
    };
  });

  useEffect(() => {
    localStorage.setItem("xclearp_settings", JSON.stringify(generalSettings));
  }, [generalSettings]);

  useEffect(() => {
    const theme = generalSettings.theme || "system";
    
    const applyTheme = (t: "dark" | "light" | "system") => {
      const root = document.documentElement;
      root.classList.remove("theme-dark", "theme-light");
      let actualTheme = t;
      if (t === "system") {
        const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        actualTheme = isDark ? "dark" : "light";
      }
      root.classList.add(`theme-${actualTheme}`);
    };
    
    applyTheme(theme);
    
    if (theme === "system") {
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      const listener = () => applyTheme("system");
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    }
  }, [generalSettings.theme]);

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem("sidebarWidth");
    return saved ? parseInt(saved, 10) : 224;
  });
  const [isDragging, setIsDragging] = useState(false);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const resizer = e.currentTarget;
    resizer.setPointerCapture(e.pointerId);
    
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    setIsDragging(true);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      let newWidth = startWidth + deltaX;
      
      if (newWidth < 120) {
        newWidth = newWidth < 90 ? 64 : Math.max(64, newWidth);
      }
      newWidth = Math.min(350, Math.max(64, newWidth));
      setSidebarWidth(newWidth);
    };

    const handlePointerUp = () => {
      resizer.releasePointerCapture(e.pointerId);
      setIsDragging(false);
      
      setSidebarWidth((latestWidth) => {
        localStorage.setItem("sidebarWidth", latestWidth.toString());
        return latestWidth;
      });

      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
    };

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
  };

  const handleToggleRule = async (rule: CleanRule) => {
    await updateRule(rule);
  };

  const handleAddRule = async (rule: CleanRule) => {
    await addCustomRule(rule);
  };

  const handleEditRule = async (rule: CleanRule) => {
    await updateRule(rule);
  };

  const handleImportRules = async (rules: CleanRule[]) => {
    try {
      const { importRules } = await import("./lib/ipc");
      await importRules(rules);
      await refresh();
    } catch (err) {
      console.error("Failed to import rules:", err);
    }
  };

  const handleStartScan = async (ruleIds: string[]) => {
    clean.resetCleanState();
    await scan.startScan(ruleIds);
  };

  return (
    <div className={`flex h-screen bg-gray-950 text-gray-100 overflow-hidden ${isDragging ? "select-none cursor-col-resize" : ""}`}>
      <Sidebar currentPage={currentPage} onNavigate={setCurrentPage} width={sidebarWidth} />

      {/* Resizer divider */}
      <div
        onPointerDown={handlePointerDown}
        className="group relative w-1 hover:w-1.5 cursor-col-resize shrink-0 transition-all duration-150 z-30 select-none"
        style={{
          marginLeft: "-2px",
          marginRight: "-2px",
        }}
      >
        <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-[1px] bg-gray-700/50 group-hover:bg-blue-500 group-active:bg-blue-600 group-hover:w-0.5 transition-all duration-150" />
      </div>

      <main className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="max-w-4xl mx-auto px-6 py-6">
          {groupsError && (
            <div className="mb-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
              {groupsError}
            </div>
          )}
          {currentPage === "scan" && (
            <div className="space-y-6">
              <ScanView
                groups={groups}
                isScanning={scan.isScanning}
                scanProgress={scan.scanProgress}
                discoveredFiles={scan.discoveredFiles}
                scanSummary={scan.scanSummary}
                onStartScan={handleStartScan}
                onCancelScan={scan.cancelScan}
                onStartClean={clean.startClean}
                error={scan.error || clean.error}
              />
              <CleanProgress
                isCleaning={clean.isCleaning}
                cleanProgress={clean.cleanProgress}
                cleanSummary={clean.cleanSummary}
                totalTargets={clean.totalTargets}
                onCancel={clean.cancelClean}
                error={clean.error}
              />
            </div>
          )}
          {currentPage === "disk" && (
            <DiskAnalysis groups={groups} onAddRule={handleAddRule} />
          )}
          {/* Always keep UninstallView mounted to preserve state across tabs */}
          <div className={currentPage === "uninstall" ? "" : "hidden"}>
            <UninstallView isActive={currentPage === "uninstall"} />
          </div>
          {/* Always keep SettingsView mounted to preserve updater state across tabs */}
          <div className={currentPage === "settings" ? "" : "hidden"}>
            <SettingsView
              groups={groups}
              loading={loading}
              onToggleRule={handleToggleRule}
              onAddRule={handleAddRule}
              onEditRule={handleEditRule}
              onDeleteRule={deleteRule}
              onAddGroup={addGroup}
              onDeleteGroup={deleteGroup}
              onImportRules={handleImportRules}
              generalSettings={generalSettings}
              setGeneralSettings={setGeneralSettings}
            />
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
