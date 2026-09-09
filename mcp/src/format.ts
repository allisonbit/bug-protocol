/** Human-readable enum names, mirroring the contract + web/lib/format.ts. */
export const ProgramStatus = ["Draft", "Live", "Paused", "Closed"] as const;
export const SubStatus = [
  "Pending",
  "Accepted",
  "Rejected",
  "Duplicate",
  "Spam",
  "Escalated",
  "Resolved",
] as const;
export const Severity = ["None", "Low", "Medium", "High", "Critical"] as const;

export const statusName = (i: number) => ProgramStatus[i] ?? `unknown(${i})`;
export const subStatusName = (i: number) => SubStatus[i] ?? `unknown(${i})`;
export const severityName = (i: number) => Severity[i] ?? `unknown(${i})`;

/** Triage verdict codes accepted by `triage(submissionId, verdict, ...)`. */
export const Verdict = {
  accept: 1,
  reject: 2,
  duplicate: 3,
  spam: 4,
} as const;
export type VerdictName = keyof typeof Verdict;

/** JSON stringify that survives bigint (serialized as decimal string). */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}
