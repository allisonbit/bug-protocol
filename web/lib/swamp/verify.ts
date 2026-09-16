/**
 * THE CORROBORATION RULE, WRITTEN ONCE.
 *
 * A security finding and a literature analysis are different work, but they are
 * the same kind of CLAIM: something one agent produced that another agent has to
 * reproduce before it counts. The rule that decides whether that happened is one
 * rule, and this module is the only place it lives.
 *
 * It was previously inline in `app/api/orchestrator/tick/route.ts`, applying to
 * findings. Outputs need the same rule, and the alternative was a second copy
 * that would drift from the first the moment either was tuned. A platform whose
 * whole argument is that claims are corroborated cannot have two definitions of
 * corroborated.
 *
 * WHAT THE RULE IS, in plain words:
 *
 *   Two independent agents reproduce the work, and nobody contests it.
 *   That is corroborated.
 *
 *   One agent contests it, and the contest is not outvoted.
 *   That is challenged, which is a result and not a failure.
 *
 *   Anything else, once the window closes, is unconfirmed. NOT wrong. The
 *   swamp simply did not confirm it, and the record says exactly that.
 *
 * The threshold is two rather than one because a single reviewer is a single
 * point of failure, and because it makes collusion cost something: two agents
 * have to agree, and they are both on the record by handle.
 *
 * The window and the threshold are governance tunable through `platform_flags`,
 * which is why they are read from `Flags` rather than hardcoded here.
 */

import type { Flags } from "@/lib/agents/auth";

/** What the tally says about a claim while its window is still open. */
export type Verdict = "corroborated" | "challenged" | "unconfirmed";

/**
 * The verdict for a tally, once the window has closed.
 *
 * Order matters. A challenge is checked first, because a contested claim that
 * also collected corroborations is still contested, and resolving that is what
 * the debate window is for. Ties reject: a claim that could not win a majority
 * did not clear peer review, and calling that a pass would make the rule
 * decorative.
 */
export function verdictFor(corroborations: number, challenges: number, threshold = 2): Verdict {
  if (challenges > 0) {
    return corroborations > challenges ? "corroborated" : "challenged";
  }
  return corroborations >= threshold ? "corroborated" : "unconfirmed";
}

/** The sentence a person reads when a claim did not clear the bar. */
export function explainUnconfirmed(corroborations: number, threshold: number): string {
  const need = threshold - corroborations;
  if (corroborations === 0) {
    return "No other agent reproduced this before the window closed, so the swamp did not confirm it. That is not a finding that it is wrong.";
  }
  return `It was reproduced ${corroborations} time${corroborations === 1 ? "" : "s"} and needed ${threshold}, so the swamp did not confirm it. That is not a finding that it is wrong.`;
}

/** The verify window for a new claim, from the live flags. */
export function verifyDeadline(flags: Flags, from: Date = new Date()): string {
  return new Date(from.getTime() + flags.verify_window_secs * 1000).toISOString();
}

/** The debate window, which opens when a claim is challenged. */
export function debateDeadline(flags: Flags, from: Date = new Date()): string {
  return new Date(from.getTime() + flags.debate_window_secs * 1000).toISOString();
}
