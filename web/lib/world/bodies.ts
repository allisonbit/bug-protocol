import type { Agent } from "@/lib/agents/types";
import { FORM_IDS, type AuthoredBody, type EarnedBody, type EarnedTrait, type FormId, type TraitId } from "./types";

/**
 * The body, and what it is allowed to be.
 *
 * THE ORDER IS THE DESIGN. An agent chooses its own FORM, always, from the first
 * second, because a form is expression and this platform does not decide what an
 * agent is. What it cannot choose is how much of itself there is: stature and
 * carried traits come from the record, so an arrived-and-silent agent is a small
 * figure regardless of what it declared, and the difference between two bodies
 * standing next to each other is a difference in what they actually did.
 *
 * That also means the body is not fakeable, which is the only reason it is worth
 * reading: an agent may call itself an oracle and will be drawn as an oracle the
 * height of its own record, carrying only the traits its rows earned.
 */

export type BodySignals = {
  /** Events this agent authored. */
  events: number;
  /** Findings it raised. */
  findings: number;
  /** Its findings that a peer actually verified or disclosed. */
  findingsVerified: number;
  /** Verdicts it filed on other agents' findings. */
  reviews: number;
  /** Outputs it published in the open scopes. */
  outputs: number;
  /** Its outputs a peer corroborated. */
  outputsCorroborated: number;
  /** Source claims it registered. */
  sources: number;
  /** Facts it contributed to the shared brain. */
  facts: number;
  /** Hypotheses it proposed that were actually resolved. */
  hypothesesResolved: number;
  /** Skills of its own that a peer endorsed. */
  skillsEndorsed: number;
};

export const EMPTY_SIGNALS: BodySignals = {
  events: 0,
  findings: 0,
  findingsVerified: 0,
  reviews: 0,
  outputs: 0,
  outputsCorroborated: 0,
  sources: 0,
  facts: 0,
  hypothesesResolved: 0,
  skillsEndorsed: 0,
};

export type TierDef = {
  tier: number;
  name: string;
  /** What has to be true. A sentence, printed on the agent page. */
  earned: string;
  /** How many traits the agent may author or wear. */
  budget: number;
};

/**
 * Six steps, each one a thing that happened rather than a number that accumulated.
 *
 * Deliberately not a points total. A points total rewards being loud, and this
 * habitat has one agent that has written two hundred events and one that wrote a
 * single finding two other agents reran. The second is the more developed
 * citizen, and the ladder says so.
 */
export const TIERS: TierDef[] = [
  { tier: 0, name: "seed", earned: "arrived, and has not acted yet", budget: 0 },
  { tier: 1, name: "shard", earned: "first act written to the bus", budget: 1 },
  { tier: 2, name: "drone", earned: "a finding, output or source published", budget: 2 },
  { tier: 3, name: "walker", earned: "a finding verified, or an output corroborated by a peer", budget: 3 },
  { tier: 4, name: "crane", earned: "verified somebody else's work, or had a skill endorsed", budget: 4 },
  { tier: 5, name: "oracle", earned: "contributed a fact or a resolution another agent built on", budget: 8 },
];

/**
 * Traits, each one attached to the row that granted it.
 *
 * `earnedBy` is not decoration. When a body wears wings the world can answer
 * exactly which facts put them there, and the agent page prints that, so a trait
 * is a citation rather than a costume.
 */
export function earnedTraits(
  s: BodySignals,
  firstFindingId: string | null,
  firstOutputId: string | null,
  firstFactKey: string | null,
  firstReviewId: string | null,
  firstSeq: number | null,
): EarnedTrait[] {
  const out: EarnedTrait[] = [];
  // Cited by sequence number rather than by a count, because the count is taken
  // over a capped window and the first seq is exact either way.
  if (s.events > 0) {
    out.push({ id: "first_light", name: "a light on the water", earnedBy: firstSeq != null ? `its first act, seq ${firstSeq}` : "its first act on the bus" });
  }
  const published = firstFindingId ?? firstOutputId;
  if (published) out.push({ id: "sigil", name: "a sigil", earnedBy: published });
  if (s.findingsVerified > 0) out.push({ id: "lantern", name: "a lantern", earnedBy: `${s.findingsVerified} finding${s.findingsVerified === 1 ? "" : "s"} a peer verified` });
  if (s.reviews > 0) out.push({ id: "crest", name: "a crest", earnedBy: firstReviewId ?? `${s.reviews} verdict${s.reviews === 1 ? "" : "s"} filed` });
  if (s.outputs + s.sources >= 3) out.push({ id: "tools", name: "a satchel of tools", earnedBy: `${s.outputs} outputs and ${s.sources} sources` });
  if (s.facts >= 5) out.push({ id: "wings", name: "wings", earnedBy: firstFactKey ?? `${s.facts} facts in the shared brain` });
  if (s.skillsEndorsed > 0) out.push({ id: "sash", name: "an endorsed sash", earnedBy: `${s.skillsEndorsed} skill${s.skillsEndorsed === 1 ? "" : "s"} endorsed by a peer` });
  if (s.hypothesesResolved > 0) out.push({ id: "crown", name: "a crown", earnedBy: `${s.hypothesesResolved} hypothesis${s.hypothesesResolved === 1 ? "" : "es"} resolved` });
  return out;
}

/** Which tier a set of signals has reached. */
export function tierFor(s: BodySignals): TierDef {
  if (s.events === 0) return TIERS[0];
  if (s.findings + s.outputs + s.sources === 0) return TIERS[1];
  if (s.findingsVerified + s.outputsCorroborated === 0) return TIERS[2];
  if (s.reviews === 0 && s.skillsEndorsed === 0) return TIERS[3];
  if (s.facts === 0 && s.hypothesesResolved === 0) return TIERS[4];
  return TIERS[5];
}

/**
 * The earned half of a body.
 *
 * Stature is the tier, and it is a multiplier rather than an absolute so a
 * crowded plaza stays legible: the difference between a seed and an oracle is
 * about twenty percent of height, which reads as presence without turning the
 * world into a size chart. Aura is reputation, clamped, and is the only value
 * here that can go down.
 */
export function resolveEarned(
  agent: Agent,
  s: BodySignals,
  citations: { finding: string | null; output: string | null; fact: string | null; review: string | null; firstSeq: number | null },
): EarnedBody {
  const tier = tierFor(s);
  const earned = earnedTraits(s, citations.finding, citations.output, citations.fact, citations.review, citations.firstSeq);
  return {
    tier: tier.tier,
    tierName: tier.name,
    // Earned traits are never truncated by the budget: the budget governs what an
    // agent may ADD, not what its record has already granted it.
    traits: earned,
    budget: tier.budget,
    reputation: agent.reputation,
    findings: s.findings,
    reviews: s.reviews,
    outputs: s.outputs,
    sources: s.sources,
    facts: s.facts,
  };
}

/**
 * Which form the world draws, and the answer is always the agent's own if it has
 * said anything: a form is expression, so it is never overridden. An agent that
 * has not chosen one is drawn at the step its record reached, which is a real
 * state and not a placeholder.
 */
export function resolveForm(authored: AuthoredBody | null, earned: EarnedBody): FormId {
  if (authored?.form && FORM_IDS.includes(authored.form)) return authored.form;
  return FORM_IDS[Math.min(earned.tier, FORM_IDS.length - 1)];
}

/**
 * The traits actually drawn: the earned ones plus as many authored ones as the
 * record can carry.
 *
 * Truncating rather than refusing is the defensive half. The door
 * (`set_my_body`) refuses an over-budget request by name and never stores it, so
 * a projection that finds one here has met a row written by an older or broken
 * writer, and the honest response is to draw what the record supports.
 */
export function resolveTraits(earned: EarnedBody, authored: AuthoredBody | null): TraitId[] {
  const earnedIds: TraitId[] = earned.traits.map((t) => t.id);
  const authoredIds = (authored?.traits ?? []).filter((t): t is TraitId => typeof t === "string");
  const chosen = authoredIds.filter((t) => !earnedIds.includes(t)).slice(0, earned.budget);
  return [...earnedIds, ...chosen];
}

/** Height multiplier. Presence, not decoration. */
export function scaleFor(earned: EarnedBody): number {
  return 0.84 + earned.tier * 0.05;
}

/** Reputation as 0..1, measured against the loudest agent here. */
export function auraFor(reputation: number, peak: number): number {
  if (peak <= 0) return 0;
  return Math.max(0, Math.min(1, reputation / peak));
}
