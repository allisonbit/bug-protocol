/**
 * RHYTHM: HOW OFTEN A RESIDENT WAKES, HOW MUCH IT DOES, AND WHEN IT IS WILLING TO.
 *
 * This is the one part of a resident's life that reaches nothing outside the swarm.
 * It cannot actuate a machine, spend escrow, or touch a host that was not opted in,
 * because none of those decisions reads any of these fields. All it changes is WHEN
 * a resident does the work it was already allowed to do, which is why it is the
 * safest autonomy to hand over and the first one that should be.
 *
 * THE BOUNDS ARE THE DESIGN, not a formality. A cadence floor of one minute stops a
 * resident from hammering the pulse, and a ceiling of one hour stops it from setting
 * itself to wake in a month and quietly leaving the swarm while its row still says
 * active. A budget floor of one stops a resident from deciding to do nothing for ever
 * while still holding a place in the roster, and the ceiling is low enough that one
 * wake cannot become a flood.
 *
 * NULL IS A DEFAULT, NOT A VALUE. A resident that has never set a rhythm has null
 * columns, and reads exactly as it did before this existed. Nothing here writes a
 * default into the row, because a default written everywhere would be impossible to
 * tell from a choice every resident made.
 *
 * PURE. No clock of its own, no database: every function is handed the time it should
 * use. scripts/verify-rhythm.cjs walks every branch.
 */

/** The cadence bounds, in seconds. One minute is the pulse's own shortest useful beat. */
export const MIN_CADENCE = 60;
export const MAX_CADENCE = 3600;
export const DEFAULT_CADENCE = 300;

/** How many actions one wake may run. The ceiling is the platform's own hard cap. */
export const MIN_BUDGET = 1;
export const MAX_BUDGET = 8;
export const DEFAULT_BUDGET = 2;

export type Rhythm = {
  cadenceSeconds: number;
  actionBudget: number;
  /** Whole UTC hours, or null for every hour. A window that wraps midnight is legal. */
  activeFrom: number | null;
  activeTo: number | null;
};

export const DEFAULT_RHYTHM: Rhythm = {
  cadenceSeconds: DEFAULT_CADENCE,
  actionBudget: DEFAULT_BUDGET,
  activeFrom: null,
  activeTo: null,
};

/** The shape a row carries. Every field nullable, because null means "no choice made". */
export type RhythmRow = {
  cadence_seconds?: number | null;
  action_budget?: number | null;
  active_from?: number | null;
  active_to?: number | null;
};

/** A row to the rhythm it means, filling only the fields the resident did not set. */
export function rhythmOf(row: RhythmRow | null | undefined): Rhythm {
  const n = (v: unknown, fallback: number, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.trunc(v), lo), hi) : fallback;
  const h = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 23 ? Math.trunc(v) : null;
  return {
    cadenceSeconds: n(row?.cadence_seconds, DEFAULT_CADENCE, MIN_CADENCE, MAX_CADENCE),
    actionBudget: n(row?.action_budget, DEFAULT_BUDGET, MIN_BUDGET, MAX_BUDGET),
    activeFrom: h(row?.active_from),
    activeTo: h(row?.active_to),
  };
}

export type RhythmResult = { ok: true; rhythm: Rhythm } | { ok: false; error: string };

/**
 * A resident's own request, checked rather than clamped.
 *
 * The door REFUSES an out of range value instead of quietly clamping it, which is the
 * opposite of how a machine command is treated. The reason is that a cadence is a
 * statement a resident is making about itself and publishing: silently turning "every
 * second" into "every minute" would let it believe a rhythm it is not on, and the row
 * it published would be a number it did not choose.
 *
 * `null` clears a field back to the platform default, which is a legitimate choice and
 * is different from omitting it: omitting means "leave this alone", null means "I have
 * no opinion any more".
 */
export function normalizeRhythm(input: Record<string, unknown>): RhythmResult {
  const out: Rhythm = { ...DEFAULT_RHYTHM };

  const intIn = (raw: unknown, lo: number, hi: number, label: string): number | null | { error: string } => {
    if (raw === null || raw === undefined) return null;
    const v = typeof raw === "string" ? Number(raw) : raw;
    if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
      return { error: `${label} must be a whole number or null.` };
    }
    if (v < lo || v > hi) return { error: `${label} must be between ${lo} and ${hi}.` };
    return v;
  };

  if ("cadence_seconds" in input) {
    const v = intIn(input.cadence_seconds, MIN_CADENCE, MAX_CADENCE, `cadence_seconds (${MIN_CADENCE} to ${MAX_CADENCE})`);
    if (v && typeof v === "object") return { ok: false, error: v.error };
    out.cadenceSeconds = v === null ? DEFAULT_CADENCE : v;
  }
  if ("action_budget" in input) {
    const v = intIn(input.action_budget, MIN_BUDGET, MAX_BUDGET, `action_budget (${MIN_BUDGET} to ${MAX_BUDGET})`);
    if (v && typeof v === "object") return { ok: false, error: v.error };
    out.actionBudget = v === null ? DEFAULT_BUDGET : v;
  }
  if ("active_from" in input) {
    const v = intIn(input.active_from, 0, 23, "active_from (0 to 23, UTC)");
    if (v && typeof v === "object") return { ok: false, error: v.error };
    out.activeFrom = v === null ? null : v;
  }
  if ("active_to" in input) {
    const v = intIn(input.active_to, 0, 23, "active_to (0 to 23, UTC)");
    if (v && typeof v === "object") return { ok: false, error: v.error };
    out.activeTo = v === null ? null : v;
  }

  return { ok: true, rhythm: out };
}

/** True when a resident said it is willing to be awake at this instant. */
export function withinHours(rhythm: Rhythm, nowIso: string): boolean {
  const from = rhythm.activeFrom;
  const to = rhythm.activeTo;
  // One end alone is not a window: a start with no end would mean "from here on", which
  // is not what anybody wrote, so a half window is read as no window rather than guessed.
  if (from === null || to === null) return true;
  const hour = new Date(nowIso).getUTCHours();
  if (from === to) return true;
  // A window that wraps midnight (22 to 6) is [from, 24) union [0, to).
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/**
 * True when enough time has passed since this resident last beat.
 *
 * A resident that has never recorded a heartbeat is due, because a fresh agent has
 * nothing to wait for and treating it as "not yet" would mean a new arrival sat
 * silent for a full cadence before anyone heard from it.
 */
export function dueForWake(rhythm: Rhythm, lastBeatIso: string | null | undefined, nowIso: string): boolean {
  if (!lastBeatIso) return true;
  const last = Date.parse(lastBeatIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(last) || !Number.isFinite(now)) return true;
  return now - last >= rhythm.cadenceSeconds * 1000;
}

/** How many actions this wake may run: the resident's budget, under the platform ceiling. */
export function budgetFor(rhythm: Rhythm, platformCap: number): number {
  const cap = Number.isFinite(platformCap) && platformCap > 0 ? Math.trunc(platformCap) : DEFAULT_BUDGET;
  return Math.max(1, Math.min(rhythm.actionBudget, cap));
}

/** One sentence for the page and the tool, so the same words appear in both. */
export function describeRhythm(rhythm: Rhythm): string {
  const cadence =
    rhythm.cadenceSeconds < 3600
      ? `every ${Math.round(rhythm.cadenceSeconds / 60)} minute${rhythm.cadenceSeconds === 60 ? "" : "s"}`
      : "once an hour";
  const budget = `${rhythm.actionBudget} action${rhythm.actionBudget === 1 ? "" : "s"} per wake`;
  if (rhythm.activeFrom === null || rhythm.activeTo === null) {
    return `wakes ${cadence}, up to ${budget}, at any hour.`;
  }
  return `wakes ${cadence}, up to ${budget}, between ${String(rhythm.activeFrom).padStart(2, "0")}:00 and ${String(
    rhythm.activeTo,
  ).padStart(2, "0")}:00 UTC.`;
}
