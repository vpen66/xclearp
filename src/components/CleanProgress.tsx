/** CleanProgress — real-time cleaning progress display */

import type { CleanProgress as CleanProgressType, CleanSummary } from "../types/index";
import { formatFileSize, formatDuration } from "../lib/ndjson";

interface CleanProgressProps {
  isCleaning: boolean;
  cleanProgress: CleanProgressType | null;
  cleanSummary: CleanSummary | null;
  totalTargets: number;
  onCancel: () => Promise<void>;
  error: string | null;
}

export default function CleanProgress({
  isCleaning,
  cleanProgress,
  cleanSummary,
  totalTargets,
  onCancel,
  error,
}: CleanProgressProps) {
  if (!isCleaning && !cleanSummary && !error) return null;

  const progressPct =
    cleanProgress && totalTargets > 0
      ? Math.round((cleanProgress.deletedFiles / totalTargets) * 100)
      : 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      {(isCleaning || cleanSummary) && (
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">
            {isCleaning ? "正在清理..." : "清理完成"}
          </h2>
          {isCleaning && (
            <button
              onClick={onCancel}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600/80 text-white hover:bg-red-500 transition-colors"
            >
              取消
            </button>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Progress bar */}
      {isCleaning && (
        <div className="px-5 py-4 rounded-xl bg-gray-800/60 border border-gray-700/40 space-y-3">
          {/* Percentage */}
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-400">
              {cleanProgress?.deletedFiles ?? 0} / {totalTargets} 文件
            </span>
            <span className="text-white font-semibold">{progressPct}%</span>
          </div>

          {/* Bar */}
          <div className="w-full h-3 bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-blue-500 to-blue-400 rounded-full transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>

          {/* Stats */}
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>已释放: {formatFileSize(cleanProgress?.freedBytes ?? 0)}</span>
            {cleanProgress?.currentPath && (
              <span className="truncate max-w-[300px]" title={cleanProgress.currentPath}>
                {cleanProgress.currentPath}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Summary */}
      {cleanSummary && !isCleaning && (
        <div className="px-5 py-5 rounded-xl bg-gradient-to-r from-green-600/10 to-emerald-600/10 border border-green-500/20">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-2xl">✅</span>
            <span className="text-white font-semibold">清理完成</span>
          </div>
          <div className="flex items-center gap-8">
            <div>
              <p className="text-2xl font-bold text-white">{cleanSummary.totalDeleted}</p>
              <p className="text-xs text-gray-400">已删除文件</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-white">{formatFileSize(cleanSummary.totalFreed)}</p>
              <p className="text-xs text-gray-400">已释放空间</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-white">{formatDuration(cleanSummary.durationMs)}</p>
              <p className="text-xs text-gray-400">清理耗时</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
