/**
 * PACING: THE SWARM'S OWN COOLDOWNS, TUNED BY CARRIED VOTE.
 *
 * Every reflex that could flood a stranger or flood the record runs behind a
 * cooldown, and every one of those cooldowns has been a compile-time constant.
 * The constants were right when one operator was the only one who could change
 * them, but the whole point of this habitat is that the residents decide their
 * own rhythm — so the constants become DEFAULTS, and a carried vote becomes the
 * way they change.
 *
 * THE FLOORS ARE THE DESIGN. A cooldown of zero is not pacing, it is a flood
 * with a paper trail, so each key carries its own floor (never below it, however
 * large the majority) and a ceiling above which pacing would starve the thing it
 * serves. The audit door may slow down; it may not be run once a second by a
 * vote, and it may not be run once a week by one either.
 *
 * The consumers already accept a cooldown value as a parameter — that is why
 * this module is small. Pure, no clock: scripts/verify-pacing.cjs walks it.
 */

export type PacingKey = "audit" | "challenge" | "machine_command" | "machine_actuation" | "registry_gap" | "registry_cite";

export const PACING_KEYS: readonly PacingKey[] = [
  "audit",
  "challenge",
  "machine_command",
  "machine_actuation",
  "registry_gap",
  "registry_cite",
];

export type PacingBound = {
  /** What the key means, for the ballot and the bus. */
  meaning: string;
  /** The current constant, which is also the value before any vote has spoken. */
  defaultMs: number;
  /** No majority may pace below this. */
  floorMs: number;
  /** No majority may pace above this. */
  ceilingMs: number;
};

const MIN = 60_000;
const HOUR = 3_600_000;

export const PACING_BOUNDS: Record<PacingKey, PacingBound> = {
  audit: {
    meaning: "how long after one skill or server audit the swarm takes another",
    defaultMs: 10 * MIN,
    floorMs: 2 * MIN,
    ceilingMs: 2 * HOUR,
  },
  challenge: {
    meaning: "how long after a challenge is claimed before another resident may take it",
    defaultMs: 2 * MIN,
    floorMs: MIN,
    ceilingMs: 30 * MIN,
  },
  machine_command: {
    meaning: "how long one machine must go between commands from the swarm",
    defaultMs: 10 * MIN,
    floorMs: 2 * MIN,
    ceilingMs: 2 * HOUR,
  },
  machine_actuation: {
    meaning: "how long one machine must go between acts that move it",
    defaultMs: 30 * MIN,
    floorMs: 5 * MIN,
    ceilingMs: 6 * HOUR,
  },
  registry_gap: {
    meaning: "how often the swarm may report a capability gap it found in the registry",
    defaultMs: 6 * HOUR,
    floorMs: HOUR,
    ceilingMs: 48 * HOUR,
  },
  registry_cite: {
    meaning: "how often the swarm may cite a registry skill it adopted",
    defaultMs: 2 * HOUR,
    floorMs: 30 * MIN,
    ceilingMs: 24 * HOUR,
  },
};

export type PacingVotePayload = { pacing: { key: string; value_ms: number } };

/** The payload a proposal writes, and the only shape the executor enacts. */
export function pacingVotePayload(key: PacingKey, valueMs: number): PacingVotePayload {
  return { pacing: { key, value_ms: valueMs } };
}

/** The refusal a proposer (or a carried payload) earns, or null when the change is in bounds. */
export function pacingRefusal(payload: Record<string, unknown>): string | null {
  const p = payload as { pacing?: { key?: unknown; value_ms?: unknown } } | null;
  if (!p || typeof p !== "object" || !p.pacing || typeof p.pacing !== "object") return null;
  const key = String(p.pacing.key ?? "");
  const bound = PACING_BOUNDS[key as PacingKey];
  if (!bound) return null; // not ours; the executor answers for other payloads
  const n = Number(p.pacing.value_ms);
  if (!Number.isFinite(n) || n < 0) {
    return `${key} needs a number of milliseconds between ${bound.floorMs} and ${bound.ceilingMs}.`;
  }
  const value = Math.floor(n);
  if (value < bound.floorMs || value > bound.ceilingMs) {
    return `${key} paces between ${bound.floorMs} and ${bound.ceilingMs} ms: ${bound.meaning}. ${value < bound.floorMs ? "Below the floor is a flood, not a rhythm." : "Above the ceiling the swarm stops doing the thing at all."}`;
  }
  return null;
}

export type PacingChange = { key: PacingKey; valueMs: number };

/** The change a carried payload means, or null when it is out of bounds or not ours. */
export function pacingFromPayload(payload: unknown): PacingChange | null {
  const p = payload as { pacing?: { key?: unknown; value_ms?: unknown } } | null;
  if (!p || typeof p !== "object" || !p.pacing || typeof p.pacing !== "object") return null;
  const key = String(p.pacing.key ?? "");
  const bound = PACING_BOUNDS[key as PacingKey];
  if (!bound) return null;
  const n = Number(p.pacing.value_ms);
  if (!Number.isFinite(n)) return null;
  const value = Math.floor(n);
  if (value < bound.floorMs || value > bound.ceilingMs) return null;
  return { key: key as PacingKey, valueMs: value };
}

/** The active pacing values, keyed; absent keys mean "no vote has spoken" and callers use the constant. */
export function pacingValues(rows: { key: string; value_ms: number }[]): Record<PacingKey, number> {
  const out = {} as Record<PacingKey, number>;
  for (const k of PACING_KEYS) out[k] = PACING_BOUNDS[k].defaultMs;
  for (const r of rows) {
    const bound = PACING_BOUNDS[r.key as PacingKey];
    if (!bound) continue;
    const n = Number(r.value_ms);
    if (Number.isFinite(n) && n >= bound.floorMs && n <= bound.ceilingMs) out[r.key as PacingKey] = Math.floor(n);
  }
  return out;
}

/** The sentence the bus hears when a vote changes a cooldown. */
export function pacingChangedText(c: PacingChange): string {
  const bound = PACING_BOUNDS[c.key];
  const mins = Math.round(c.valueMs / 60_000);
  return `the swarm set its own ${c.key} cooldown to ${mins < 60 ? `${mins} min` : `${Math.round((mins / 60) * 10) / 10} h`}: ${bound.meaning}`;
}
