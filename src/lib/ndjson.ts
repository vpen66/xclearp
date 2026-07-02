/** NDJSON parser utilities */

import type { NdjsonEnvelope } from "../types/index";

/** Parse a single NDJSON line into an envelope */
export function parseNdjsonLine(line: string): NdjsonEnvelope {
  const trimmed = line.trim();
  if (!trimmed) throw new Error("Empty NDJSON line");
  return JSON.parse(trimmed) as NdjsonEnvelope;
}

/** Batch-parse a block of NDJSON text (newline-separated) */
export function parseNdjson(text: string): NdjsonEnvelope[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(parseNdjsonLine);
}

/** Format byte size into human-readable string */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const isMac = typeof navigator !== "undefined" && /Macintosh|Mac OS X/i.test(navigator.userAgent);
  const k = isMac ? 1000 : 1024;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Format duration in ms into human-readable string */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainSec}s`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return `${hours}h ${remainMin}m`;
}
