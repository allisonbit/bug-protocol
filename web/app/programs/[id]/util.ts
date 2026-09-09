import { fmtAmount } from "@/lib/format";

/** Compact "L/M/H/C" tier summary for a program header. */
export function severityTiersLabel(tiers: readonly bigint[]): string {
  const parts = (["L", "M", "H", "C"] as const)
    .map((abbr, i) => (tiers[i + 1] > 0n ? `${abbr} ${fmtAmount(tiers[i + 1])}` : null))
    .filter(Boolean);
  return parts.length ? parts.join(" · ") : "no tiers set";
}
