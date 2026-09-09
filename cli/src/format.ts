import { formatEther, formatUnits } from "viem";
import { ProgramStatus, SubStatus, Severity } from "./abi.js";

export const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

export function fmtAmount(v: bigint, decimals = 18, symbol = ""): string {
  const s = decimals === 18 ? formatEther(v) : formatUnits(v, decimals);
  const trimmed = s.includes(".") ? s.replace(/\.?0+$/, "") : s;
  return symbol ? `${trimmed} ${symbol}` : trimmed;
}

export const statusName = (i: number) => ProgramStatus[i] ?? "?";
export const subStatusName = (i: number) => SubStatus[i] ?? "?";
export const severityName = (i: number) => Severity[i] ?? "?";

export function humanDuration(seconds: number | bigint): string {
  const s = Number(seconds);
  if (s <= 0) return "0s";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d${h ? ` ${h}h` : ""}`;
  if (h > 0) return `${h}h${m ? ` ${m}m` : ""}`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export const fmtDate = (unixSeconds: number | bigint) => {
  const n = Number(unixSeconds);
  if (!n) return "—";
  return new Date(n * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
};

/** Minimal dependency-free column table for terminal output. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const pad = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  ");
  const sep = widths.map((w) => "─".repeat(w)).join("  ");
  return [pad(headers), sep, ...rows.map(pad)].join("\n");
}
