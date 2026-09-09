import { formatEther, formatUnits, type Address } from "viem";
import { Severity, SubStatus, ProgramStatus } from "./contract";

export const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

export const fmtAmount = (v: bigint, decimals = 18, symbol = "") => {
  const s = decimals === 18 ? formatEther(v) : formatUnits(v, decimals);
  // trim trailing zeros but keep it readable
  const trimmed = s.includes(".") ? s.replace(/\.?0+$/, "") : s;
  return symbol ? `${trimmed} ${symbol}` : trimmed;
};

export const statusName = (i: number) => ProgramStatus[i] ?? "?";
export const subStatusName = (i: number) => SubStatus[i] ?? "?";
export const severityName = (i: number) => Severity[i] ?? "?";

/** Palette per program status. */
export const statusTone: Record<string, string> = {
  Draft: "text-mist border-line",
  Live: "text-bug border-bug-dim",
  Paused: "text-warn border-warn/50",
  Closed: "text-mist border-line",
};

/** Palette per submission status. */
export const subTone: Record<string, string> = {
  Pending: "text-warn border-warn/50",
  Accepted: "text-bug border-bug-dim",
  Rejected: "text-mist border-line",
  Duplicate: "text-mist border-line",
  Spam: "text-red-400 border-red-500/40",
  Escalated: "text-warn border-warn/50",
  Resolved: "text-bug border-bug-dim",
};

export const severityTone: Record<string, string> = {
  None: "text-mist",
  Low: "text-sky-400",
  Medium: "text-yellow-400",
  High: "text-orange-400",
  Critical: "text-red-400",
};

export const isNative = (token: Address) =>
  token === "0x0000000000000000000000000000000000000000";

export const rewardSymbol = (token: Address) => (isNative(token) ? "ETH" : "TOKEN");

/** Human duration from seconds. */
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

/** Countdown to a unix timestamp; negative means lapsed. */
export function untilLabel(unixSeconds: number | bigint): { label: string; lapsed: boolean } {
  const now = Math.floor(Date.now() / 1000);
  const target = Number(unixSeconds);
  const delta = target - now;
  if (delta <= 0) return { label: `lapsed ${humanDuration(-delta)} ago`, lapsed: true };
  return { label: `${humanDuration(delta)} left`, lapsed: false };
}

export const fmtDate = (unixSeconds: number | bigint) => {
  const n = Number(unixSeconds);
  if (!n) return "—";
  return new Date(n * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
};
