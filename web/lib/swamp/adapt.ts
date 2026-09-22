import type { ReflexRule } from "./policy";
import type { Lesson } from "./lessons";

/**
 * SELF-TUNING, AND THE EXACT EDGE OF IT.
 *
 * The lessons layer writes sentences about this deployment's own behaviour. This is
 * the one thing that acts on them, and it is deliberately the smallest useful thing
 * it could be: a rule the swarm has concluded fires and lands nothing is moved DOWN
 * in the agent's own priority order, so the work a resident actually completes goes
 * first.
 *
 * WHAT THIS CANNOT DO, stated here because it is the whole safety argument.
 *
 *   - It cannot add, remove or change an intent. The action set stays closed. A
 *     lesson can never hand an agent a capability it was not given.
 *   - It cannot reach the killswitch. An operator's pause is structural in the
 *     brain and is not a weight any of this touches.
 *   - It cannot touch hardware or money. A lease, a mandate and a target's opt-in
 *     are all decided elsewhere and are unaffected by rule order.
 *   - It cannot move a rule to the point of stopping it. The floor is a low
 *     priority, not an off switch: if a lowered rule is the only one whose condition
 *     holds, it still fires, because a rule that genuinely matches work should run.
 *
 * AND IT REVERSES ITSELF. The adjustment is not stored anywhere; it is recomputed
 * from the lessons that are adopted RIGHT NOW. A lesson that is later refuted or
 * retired simply is not in that list, so the rule returns to the weight the agent
 * wrote. There is no accumulated drift to unwind, which is what makes this safe to
 * ship on a live swarm.
 *
 * PURE. No clock, no database. scripts/verify-adapt.cjs walks every branch.
 */

/** How far one adopted lesson moves a rule. A nudge, not a rewrite. */
export const ADAPT_STEP = 15;

/** The lowest a rule's weight can be pushed. A low priority, never an off switch. */
export const ADAPT_FLOOR = 1;

/** How many rules one beat may reorder, so a flood of proposals cannot reshuffle a
 *  whole policy at once and make the run order unknowable from the record. */
export const MAX_ADJUSTMENTS = 8;

export type RuleAdjustment = {
  /** The rule id whose priority moved. */
  rule: string;
  /** The adopted lesson that moved it, so the span can be traced to the claim. */
  lessonId: string;
  before: number;
  after: number;
  why: string;
};

export type AdaptResult = {
  rules: ReflexRule[];
  adjustments: RuleAdjustment[];
};

/**
 * The rules to actually run, with adopted conclusions applied.
 *
 * Only one lesson kind moves anything: `rule_barren`, which is a rule the swarm
 * counted firing with every planned action failed or dropped. `rule_silent` is a
 * rule whose condition never held, which is not the rule's fault and would be a
 * mistake to punish, and `brain_degraded` is about an agent rather than a rule.
 */
export function adaptRules(
  rules: ReflexRule[],
  adopted: Lesson[],
  opts?: { step?: number; floor?: number; max?: number },
): AdaptResult {
  const step = opts?.step ?? ADAPT_STEP;
  const floor = opts?.floor ?? ADAPT_FLOOR;
  const max = opts?.max ?? MAX_ADJUSTMENTS;

  if (!Array.isArray(rules) || rules.length === 0) return { rules: rules ?? [], adjustments: [] };

  const byId = new Map(rules.map((r) => [r.id, r]));

  // One adjustment per rule, not per lesson: a rule that five residents called barren
  // is moved once, by the strongest single claim, rather than five times into the floor.
  const claims = new Map<string, Lesson>();
  for (const l of adopted ?? []) {
    if (!l || l.kind !== "rule_barren") continue;
    const subject = typeof l.subject === "string" ? l.subject : "";
    if (!byId.has(subject)) continue;
    const prior = claims.get(subject);
    if (!prior || l.id < prior.id) claims.set(subject, l);
  }
  if (claims.size === 0) return { rules, adjustments: [] };

  const adjustments: RuleAdjustment[] = [];
  const moved = new Map<string, number>();
  const subjects = [...claims.keys()].sort().slice(0, Math.max(0, max));
  for (const id of subjects) {
    const rule = byId.get(id);
    if (!rule) continue;
    const after = Math.max(floor, rule.weight - step);
    if (after === rule.weight) continue;
    moved.set(id, after);
    adjustments.push({
      rule: id,
      lessonId: claims.get(id)!.id,
      before: rule.weight,
      after,
      why: "an adopted lesson counted this rule firing and landing nothing, so its own work runs first",
    });
  }
  if (moved.size === 0) return { rules, adjustments: [] };

  const out = rules.map((r) => (moved.has(r.id) ? { ...r, weight: moved.get(r.id)! } : r));
  return { rules: out, adjustments };
}
