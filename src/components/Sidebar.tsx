/** Sidebar navigation component */

import type { Page } from "../types/index";
import {
  IconSearch,
  IconHardDrive,
  IconSettings,
} from "./Icons";

interface SidebarProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
  width: number;
}

const navItems: { page: Page; label: string; icon: React.ReactNode }[] = [
  { page: "scan", label: "扫描清理", icon: <IconSearch /> },
  { page: "disk", label: "磁盘分析", icon: <IconHardDrive /> },
  { page: "settings", label: "设置", icon: <IconSettings /> },
];

export default function Sidebar({ currentPage, onNavigate, width }: SidebarProps) {
  const isCollapsed = width < 110;

  return (
    <aside
      style={{ width: `${width}px` }}
      className="bg-gray-900 flex flex-col shrink-0 overflow-hidden select-none"
    >
      {/* App branding */}
      <div className={`py-5 border-b border-gray-700/50 ${isCollapsed ? "px-0 flex flex-col items-center justify-center gap-1" : "px-5"}`}>
        <h1 className={`font-bold text-gray-50 tracking-tight flex items-center ${isCollapsed ? "justify-center text-lg" : "text-xl gap-2"}`}>
          <span className="relative flex items-center justify-center w-6 h-6 shrink-0">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <linearGradient id="sbSwoosh" x1="0%" y1="100%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#06B6D4" />
                  <stop offset="100%" stopColor="#3B82F6" />
                </linearGradient>
              </defs>
              {/* Metal slash (bottom-left to top-right) */}
              <path d="M5 19L19 5" stroke="#475569" strokeWidth="3" strokeLinecap="round" />
              {/* Glowing swoosh (top-left to bottom-right) */}
              <path d="M5 5 C 10 3, 17 10, 19 19 C 16 17, 10 14, 5 5 Z" fill="url(#sbSwoosh)" />
              {/* Sparkle top right */}
              <path d="M19 2 Q19 5 22 5 Q19 5 19 8 Q19 5 16 5 Q19 5 19 2 Z" fill="#FFFFFF" />
              {/* Sparkle bottom left */}
              <path d="M5 15 Q5 17 7 17 Q5 17 5 19 Q5 17 3 17 Q5 17 5 15 Z" fill="#E0F7FA" />
            </svg>
          </span>
          {!isCollapsed && <span className="truncate">XClearp</span>}
        </h1>
        {!isCollapsed && <p className="text-xs text-gray-500 mt-1 truncate">跨平台系统清理工具</p>}
      </div>

      {/* Navigation */}
      <nav className={`flex-1 py-4 space-y-1 ${isCollapsed ? "px-1.5" : "px-3"}`}>
        {navItems.map((item) => {
          const active = currentPage === item.page;
          return (
            <button
              key={item.page}
              onClick={() => onNavigate(item.page)}
              title={isCollapsed ? item.label : undefined}
              className={`w-full flex items-center rounded-lg text-sm font-medium transition-all duration-150 ${
                isCollapsed
                  ? "justify-center px-0 py-2.5"
                  : "gap-3 px-3 py-2.5"
              } ${
                active
                  ? "bg-blue-600/20 text-blue-400 shadow-sm"
                  : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
              }`}
            >
              <span className={`text-lg text-gray-400 ${isCollapsed ? "flex items-center justify-center w-6 h-6 shrink-0" : "shrink-0"}`}>
                {item.icon}
              </span>
              {!isCollapsed && <span className="truncate">{item.label}</span>}
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div className={`py-3 border-t border-gray-700/50 flex justify-center items-center ${isCollapsed ? "px-1" : "px-5"}`}>
        <p className="text-[10px] text-gray-600 truncate">
          {isCollapsed ? "v0.1" : "v0.1.0"}
        </p>
      </div>
    </aside>
  );
}
