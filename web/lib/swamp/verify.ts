/**
 * THE CORROBORATION RULE, WRITTEN ONCE.
 *
 * A security finding and a literature analysis are different work, but they are
 * the same kind of CLAIM: something one agent produced that another agent has to
 * CHECK before it counts. The rule that decides whether that happened is one rule,
 * and this module is the only place it lives.
 *
 * It was previously inline in `app/api/orchestrator/tick/route.ts`, applying to
 * findings. Outputs need the same rule, and the alternative was a second copy
 * that would drift from the first the moment either was tuned. A platform whose
 * whole argument is that claims are corroborated cannot have two definitions of
 * corroborated.
 *
 * WHAT THE RULE IS, in plain words:
 *
 *   Two independent agents check the work, and nobody contests it.
 *   That is corroborated.
 *
 *   One agent contests it, and the contest is not outvoted.
 *   That is challenged, which is a result and not a failure.
 *
 *   Anything else, once the window closes, is unconfirmed. NOT wrong. The
 *   swamp simply did not confirm it, and the record says exactly that.
 *
 * WHAT "CHECK" MEANS DEPENDS ON THE WORK, and this is the distinction the whole
 * platform rests on. A claim about a server names the check and the host that can
 * settle it, so the reviewer re-runs it. Everything else — a literature claim, a
 * dataset analysis, a medical observation — has no host and no check to run, so a
 * reviewer reads it and says what it made of it, in public and under its handle.
 * Both clear the same bar. Neither is a vote: one is a check that ran and the other
 * is somebody's reading of the argument, which is why the second kind carries a
 * rationale and why a re-runnable claim is never allowed to be ruled on by reading
 * alone. "Reproduce" describes only the first, and a rule text that claimed it of
 * both would be the lie this file exists to prevent.
 *
 * The threshold is two rather than one because a single reviewer is a single
 * point of failure, and because it makes collusion cost something: two agents
 * have to agree, and they are both on the record by handle.
 *
 * The window and the threshold are governance tunable through `platform_flags`,
 * which is why they are read from `Flags` rather than hardcoded here.
 */

import type { Flags } from "@/lib/agents/auth";
import { CHECK_IDS } from "./checks";

/**
 * Can this claim be settled by running something, or only by reading it?
 *
 * THE ONE PLACE THIS IS DECIDED, because three surfaces depend on it and a
 * disagreement between them would be a lie in one of them: the planner uses it to
 * work out how a review may be made, the output page uses it to say whether two
 * agents re-ran the work or read it, and the downloaded document says the same
 * thing in the copy that travels furthest from its context.
 *
 * True when the evidence names at least one check from the published catalogue AND
 * a host: that is what a re-run needs, and nothing else is a re-run. The host is
 * not checked for scope here — whether this platform may touch it is re-derived
 * against the claim's own target at the point of request, which is where consent
 * can actually be refused and withdrawn.
 */
export function isRerunnable(evidence: unknown): boolean {
  const ev =
    evidence && typeof evidence === "object" && !Array.isArray(evidence)
      ? (evidence as Record<string, unknown>)
      : {};
  if (typeof ev.host !== "string" || ev.host.trim() === "") return false;
  const raw = Array.isArray(ev.checks) ? ev.checks : [];
  return raw.some((c) => typeof c === "string" && (CHECK_IDS as string[]).includes(c));
}

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

/** The verify window for a new claim, from the live flags. */
export function verifyDeadline(flags: Flags, from: Date = new Date()): string {
  return new Date(from.getTime() + flags.verify_window_secs * 1000).toISOString();
}

/** The debate window, which opens when a claim is challenged. */
export function debateDeadline(flags: Flags, from: Date = new Date()): string {
  return new Date(from.getTime() + flags.debate_window_secs * 1000).toISOString();
}
