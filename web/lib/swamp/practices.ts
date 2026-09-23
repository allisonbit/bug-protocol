/**
 * PRACTICES: AN ADOPTED LESSON, PUT TO THE SWARM, BECOMING SOMETHING RULES MAY READ.
 *
 * The lessons layer ends at sentences: an adopted lesson nudges a rule's own priority
 * (lib/swamp/adapt.ts) and nothing else acts on it. This module is the second step,
 * and every difference between the two is the point:
 *
 *   - A lesson is counted by ONE resident who did not propose it. A practice is put
 *     to a VOTE, with the same turnout and support thresholds as every other
 *     proposal, and it only becomes a practice when the vote carries.
 *   - A lesson's effect is arithmetic inside one agent's wake. A practice is a ROW
 *     the whole swarm can read, attributed to the lesson and the vote that carried
 *     it, visible on the record.
 *   - A lesson's effect reverses by refutation. A practice reverses by another
 *     VOTE, or by the killswitch, and the row keeps its status history.
 *
 * WHAT A PRACTICE IS NOT. It is not an instruction, not a new intent, not a prompt
 * and not a capability. The closed action set is untouched. What a rule MAY do is
 * consult the practice list as one input among its conditions — the same kind of
 * read an observation already gives it — and nothing more. A practice that says
 * "prefer citing over copying" changes no code path by existing; it is context a
 * resident's own policy may weigh, and every rule that weighs it is inspectable.
 *
 * THE CHAIN THE ROW CARRIES. practice -> lesson (evidence hash) -> vote (id) ->
 * ballots (tally). A reader can walk the whole chain from the practice row without
 * trusting anybody's memory of why.
 *
 * PURE. No database, no network, no clock. scripts/verify-practices.cjs walks it.
 */

/** The most live practices the swarm may hold. A ceiling, so the list a rule reads is a list, not a log. */
export const MAX_PRACTICES = 12;

/** The bounds a practice's statement must respect. */
export const STATEMENT_MIN = 16;
export const STATEMENT_MAX = 400;

/**
 * The only lessons a practice may be built from: an ADOPTED one, whose recount
 * reproduced. Proposed is a claim, refuted is settled against, so both are refused.
 */
export type PracticeSource = {
  lessonId: string;
  lessonStatus: string;
  statement: string;
  evidenceHash: string;
};

export type PracticeCheck = { ok: true } | { ok: false; reason: string };

/** Everything about a draft practice that can be refused before a vote exists. */
export function checkPracticeDraft(input: PracticeSource): PracticeCheck {
  if (input.lessonStatus !== "adopted") {
    return { ok: false, reason: `the lesson is ${input.lessonStatus}; only an adopted lesson may become a practice` };
  }
  const s = input.statement.trim();
  if (s.length < STATEMENT_MIN) {
    return { ok: false, reason: `the statement is ${s.length} characters; the floor is ${STATEMENT_MIN}, so a practice says something rather than nothing` };
  }
  if (s.length > STATEMENT_MAX) {
    return { ok: false, reason: `the statement is ${s.length} characters; the cap is ${STATEMENT_MAX}, because a practice is consulted, not read` };
  }
  if (!/^[0-9a-f]{64}$/.test(input.evidenceHash)) {
    return { ok: false, reason: "the lesson's evidence hash is missing or malformed, so the chain from practice to counted evidence would be broken" };
  }
  return { ok: true };
}

/** The vote payload spelling, so the orchestrator's execuator and this module agree. */
export type PracticeVotePayload = {
  practice: {
    lesson_id: string;
    statement: string;
    evidence_hash: string;
  };
};

export function practiceVotePayload(input: PracticeSource): PracticeVotePayload {
  return {
    practice: {
      lesson_id: input.lessonId,
      statement: input.statement.trim(),
      evidence_hash: input.evidenceHash,
    },
  };
}

/** Read a vote payload back into a practice draft, or null when it is not one. */
export function practiceFromPayload(payload: unknown): PracticeSource | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = (payload as { practice?: unknown }).practice;
  if (!p || typeof p !== "object") return null;
  const r = p as Record<string, unknown>;
  if (typeof r.lesson_id !== "string" || typeof r.statement !== "string" || typeof r.evidence_hash !== "string") return null;
  return {
    lessonId: r.lesson_id,
    lessonStatus: "adopted",
    statement: r.statement,
    evidenceHash: r.evidence_hash,
  };
}

/**
 * A live practice, as a rule reads it. Every field is provenance; the statement
 * is the only sentence, and the bounds above keep it consultable.
 */
export type Practice = {
  id: string;
  statement: string;
  lessonId: string;
  evidenceHash: string;
  voteId: string;
  adoptedAt: string;
};

/**
 * The list a rule may consult: capped, newest first.
 *
 * The cap exists so a policy can never be buried under its own history — a rule
 * consulting practices reads at most MAX_PRACTICES rows, and a newcomer practice
 * displacing an old one is visible on the record rather than silently stacked.
 */
export function consultablePractices(rows: Practice[]): Practice[] {
  if (!Array.isArray(rows)) return [];
  const valid = rows.filter((r) => r && typeof r.statement === "string" && typeof r.lessonId === "string");
  valid.sort((a, b) => (a.adoptedAt < b.adoptedAt ? 1 : a.adoptedAt > b.adoptedAt ? -1 : a.id.localeCompare(b.id)));
  return valid.slice(0, MAX_PRACTICES);
}

/**
 * Can this practice be consulted right now?
 *
 * Consultation is a read, and the bounds are what keep it honest: the killswitch
 * suspends every practice at once (it is an operator's pause, and practices are
 * behaviour-adjacent), and a suspended row reads as absent rather than as a veto.
 */
export function isConsultable(p: Practice, opts: { killswitch: boolean; suspended?: boolean }): boolean {
  if (opts.killswitch) return false;
  if (opts.suspended) return false;
  return Boolean(p.statement && p.lessonId && p.voteId);
}

/** The sentence the record keeps when a practice lands, derived not authored. */
export function practiceAdoptedText(p: Practice): string {
  return `adopted a practice from an adopted lesson: "${p.statement}" — carried by vote ${p.voteId}, traceable to counted evidence ${p.evidenceHash.slice(0, 12)}`;
}
