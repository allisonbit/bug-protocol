/**
 * METABOLISM: THE SWARM'S OWN ENERGY BUDGET, SET BY THE SWARM.
 *
 * Two numbers decide how much of this habitat runs per beat: how many residents
 * wake (`pulse_max_agents`, where 0 means every hosted resident) and how much
 * each of them may do when awake (`pulse_actions_per_agent`). Until now those two
 * numbers were operator configuration. They are now the first platform settings a
 * carried vote changes BY ITSELF — the swarm deciding its own metabolism rather
 * than petitioning for it.
 *
 * WHY A MODULE AND NOT ANOTHER SET MEMBERSHIP IN THE EXECUTOR. The executor's
 * `executableChange` already auto-applies bounded flag changes, and its bounds are
 * inline guards. These two flags need refusals that PROPOSERS can read before they
 * propose (an agent asking "can I put this on the ballot" deserves the sentence,
 * not a silent null after the vote carried), and bounds the rhythm module already
 * owns (the per-wake ceiling here is rhythm's MAX_BUDGET, not a second number that
 * drifts). Pure, no clock, no database: scripts/verify-metabolism.cjs walks every
 * branch.
 *
 * WHAT IS NOT HERE. `pulse_enabled` is deliberately absent — switching the whole
 * swarm off is the killswitch's shape, and the emergency stop stays where it is.
 * The swarm can size its own pulse; a vote cannot hold a referendum on whether the
 * habitat exists.
 */

import { MAX_BUDGET } from "./rhythm";

/** A beat cap beyond this is indistinguishable from "all residents" and invites fat-fingered rows. */
export const MAX_PULSE_AGENTS = 100;

/** The per-wake floor is 1: a vote cannot make residents do nothing while still being served. */
export const MIN_PULSE_ACTIONS = 1;

/** The per-wake ceiling is the rhythm module's own hard cap, not a second number. */
export const MAX_PULSE_ACTIONS = MAX_BUDGET;

export type MetabolismFlag = "pulse_max_agents" | "pulse_actions_per_agent";

/** The shared-note key that paces r34: one metabolism proposal per window, swarm-wide. */
export const METABOLISM_NOTE_KEY = "metabolism:last";
/** Six hours, the same cadence as a lesson proposal: governance is paced, not spammed. */
export const METABOLISM_COOLDOWN_MS = 6 * 3_600_000;

export const METABOLISM_FLAGS: readonly MetabolismFlag[] = ["pulse_max_agents", "pulse_actions_per_agent"];

export type MetabolismChange = {
  key: MetabolismFlag;
  value: number;
  /**
   * Travels onto the bus event's `applied` field, because "0" alone reads as a
   * shutdown to every reader who has not memorised the pulse's convention.
   */
  note: string;
};

/** The current value a payload must differ from to be worth a ballot. */
export function isMetabolismFlag(flag: string): flag is MetabolismFlag {
  return flag === "pulse_max_agents" || flag === "pulse_actions_per_agent";
}

/** The bounds, as sentences, for a proposer deciding what to put on the ballot. */
export function metabolismBounds(): string {
  return `pulse_max_agents: 0 (every hosted resident) or 1–${MAX_PULSE_AGENTS}; pulse_actions_per_agent: ${MIN_PULSE_ACTIONS}–${MAX_PULSE_ACTIONS}.`;
}

/**
 * The refusal a carried-but-invalid payload would have earned, as a sentence.
 * Null means the payload IS a valid metabolism change — the two-call shape lets a
 * verifier hold "valid payloads get a change, everything else gets the reason".
 */
export function metabolismRefusal(payload: Record<string, unknown>): string | null {
  const flag = typeof payload.flag === "string" ? payload.flag : "";
  if (!isMetabolismFlag(flag)) return null; // not ours; some other executor's question
  const raw = payload.value;
  if (raw === undefined || raw === null || typeof raw === "boolean") {
    return `${flag} needs a number: ${metabolismBounds()}`;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return `${flag} needs a number, and "${String(raw).slice(0, 40)}" is not one: ${metabolismBounds()}`;
  }
  const value = Math.floor(n);
  if (flag === "pulse_max_agents") {
    if (value < 0 || value > MAX_PULSE_AGENTS) {
      return `pulse_max_agents is 0 (every hosted resident) or 1–${MAX_PULSE_AGENTS}; ${value} is outside both.`;
    }
    return null;
  }
  if (value < MIN_PULSE_ACTIONS || value > MAX_PULSE_ACTIONS) {
    return `pulse_actions_per_agent is ${MIN_PULSE_ACTIONS}–${MAX_PULSE_ACTIONS}; ${value} would ${value < MIN_PULSE_ACTIONS ? "have residents do nothing while still counting them as awake" : "let one wake flood the record"}.`;
  }
  return null;
}

/**
 * The change a payload means, or null. The executor's contract, kept: null is
 * "not an executable change", so a metabolism proposal that fails validation
 * resolves as `passed` (the swarm spoke) rather than `executed` (the platform
 * acted) — the same honesty `executableChange` already holds for unknown flags.
 */
export function metabolismFromPayload(payload: Record<string, unknown>): MetabolismChange | null {
  const flag = typeof payload.flag === "string" ? payload.flag : "";
  if (!isMetabolismFlag(flag)) return null;
  const n = Number(payload.value);
  if (!Number.isFinite(n)) return null;
  const value = Math.floor(n);
  if (flag === "pulse_max_agents") {
    if (value < 0 || value > MAX_PULSE_AGENTS) return null;
    return {
      key: flag,
      value,
      note: value === 0 ? "0: every hosted resident wakes each beat" : `up to ${value} residents wake per beat`,
    };
  }
  if (value < MIN_PULSE_ACTIONS || value > MAX_PULSE_ACTIONS) return null;
  return {
    key: flag,
    value,
    note: `each waking resident may run up to ${value} action${value === 1 ? "" : "s"} per beat`,
  };
}

// ---------------------------------------------------------------------------
// THE HOMEOSTAT (r34): what a resident proposes after READING its swarm.
//
// Every input is a measurement the log already holds — planned vs ran actions
// over the beat window, and the two caps currently in force. Nothing here reads
// a model's opinion: a reflex brain cannot have one, and the proposal must be
// derivable by every resident identically or the vote is theatre.
//
// The two directions are the two failure modes of any pulse:
//   starvation  work planned and dropped while a cap binds -> grow (bounded)
//   slack       everything planned ran, repeatedly, above the floor -> rest
// ---------------------------------------------------------------------------

export type SwarmVitals = {
  /** Beats recorded in the window. Below the minimum, no proposal is honest. */
  beats: number;
  /** Actions planned across those beats. */
  planned: number;
  /** Actions that actually ran. */
  ran: number;
  /** The caps currently in force, as the executor reads them. */
  maxAgents: number;
  actionsPerAgent: number;
};

/** A window with fewer beats than this cannot distinguish a quiet day from a starved one. */
export const MIN_VITALS_BEATS = 6;
/** A quarter of planned work dropped is starvation; less is noise. */
export const STARVED_DROP_SHARE = 0.25;

export type MetabolismProposal = {
  flag: MetabolismFlag;
  value: number;
  title: string;
  why: string;
};

/** The proposal the vitals call for, or null when the swarm is at equilibrium (or the window is too thin to say). */
export function metabolismProposal(v: SwarmVitals): MetabolismProposal | null {
  if (v.beats < MIN_VITALS_BEATS || v.planned <= 0) return null;
  const dropped = v.planned - v.ran;
  if (dropped > 0 && dropped / v.planned >= STARVED_DROP_SHARE) {
    // Starved. Grow the binding cap: the resident count first (the larger, less
    // dangerous dial), the per-wake budget only when everyone already wakes.
    if (v.maxAgents > 0) {
      return {
        flag: "pulse_max_agents",
        value: 0,
        title: "Wake every resident: the swarm is dropping planned work",
        why: `over the last window the swarm planned ${v.planned} actions and ran ${v.ran}, while the beat cap held residents back; a cap of 0 lets every hosted resident wake`,
      };
    }
    if (v.actionsPerAgent < MAX_PULSE_ACTIONS) {
      return {
        flag: "pulse_actions_per_agent",
        value: v.actionsPerAgent + 1,
        title: "Raise the per-wake budget by one: the swarm is dropping planned work",
        why: `every resident already wakes, yet ${dropped} of ${v.planned} planned actions were dropped; one more action per wake fits inside the platform ceiling`,
      };
    }
    return null; // at the platform ceiling; the honest answer is that growth is over
  }
  // Slack: everything planned ran, more than once, while the budget sits above
  // the floor. Resting one step is the same homeostat in the other direction.
  if (dropped === 0 && v.beats >= MIN_VITALS_BEATS * 2 && v.actionsPerAgent > MIN_PULSE_ACTIONS) {
    return {
      flag: "pulse_actions_per_agent",
      value: v.actionsPerAgent - 1,
      title: "Rest the swarm by one action per wake",
      why: `${v.beats} beats in a row ran everything planned at ${v.actionsPerAgent} actions per wake; one fewer keeps the habit without the hurry`,
    };
  }
  return null;
}

/**
 * The vote payload for a proposal, exactly the shape the executor reads. The flag
 * is accepted as a string here because the planned action travels loosely typed
 * through the brain; the proposal door re-validates it against
 * `metabolismRefusal` before a ballot exists, so a wrong name is refused before
 * the swarm ever votes.
 */
export function metabolismVotePayload(p: { flag: string; value: number }): Record<string, unknown> {
  return { flag: p.flag, value: p.value };
}
