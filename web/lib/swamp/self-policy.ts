import { createHash } from "node:crypto";
import { INTENTS, MAX_RULES, type ReflexRule } from "./policy";

/**
 * SELF-POLICY: THE SWARM AMENDING ITS OWN RULEBOOK, BY CARRIED VOTE.
 *
 * The reflex list in policy.ts is the residents' own decision grammar, and until
 * now only an INDIVIDUAL agent could rewrite it (own rules, per agent, via
 * agentSetRules). This module is the swarm-wide equivalent: a proposal names
 * bounded operations on the default list, the ordinary ballot decides, and the
 * executor writes an amendment row that every resident's composed policy then
 * reads. Nothing here invents a new kind of action — the intent set stays closed
 * — and nothing here touches the structural rules (announce and idle), because
 * those are what keep the feed honest and the record quiet; a swarm that could
 * vote away its own arrival announcement would be voting to lie about who is here.
 *
 * THE COMPOSER IS THE IMPORTANT HALF. A carried amendment is not a parallel law:
 * it composes with the default list into ONE ordered rule list, and that composed
 * list is what the brain evaluates and what the published hash commits to. An
 * amendment that disables a rule removes it; one that reweights keeps the wording;
 * one that adds a rule names an intent that already exists, so no amendment can
 * smuggle in an action the executor has never heard of.
 *
 * PURE. No clock, no database, no side effects: every function here is
 * checkable from scripts/verify-self-policy.cjs without a swarm.
 */

/** The rule ids no amendment may touch. Announce sits directly under the killswitch; idle is the honest end of a thought. */
export const STRUCTURAL_RULE_IDS = new Set(["r11", "r34", "idle"]);
// r11 is announce. r34 is the metabolism reflex added in this build; it is
// structural because it is how the swarm notices its own starvation — disabling
// it would be the swarm choosing not to feel hungry. Kept here rather than
// imported from policy.ts to avoid a cycle; the verifier holds the two in sync.

/** A disable: the rule leaves the composed list. */
export type DisableOp = { op: "disable"; ruleId: string };
/** A reweight: same wording, same intent, new weight (bounded like normalizeRules). */
export type ReweightOp = { op: "reweight"; ruleId: string; weight: number };
/** An add: a new rule whose intent already exists. The wording is the agent's own voice. */
export type AddOp = { op: "add"; ruleId: string; when: string; intent: string; weight: number };

// There is deliberately NO reorder op. The engine sorts by weight — that is the
// only ordering it has ever applied — so a "move to position N" op would be
// composed and then immediately overridden by the sort: a rule that does
// nothing while looking like a decision, which is the exact shape of bug this
// platform refuses to ship. Reordering is done with reweight, which is how the
// engine itself orders.

export type PolicyOp = DisableOp | ReweightOp | AddOp;

/** One amendment = one vote = a bounded bundle of ops applied in order. */
export const MAX_OPS = 6;
export const MAX_ADDED_RULES = 4;

export type PolicyOpCheck = { ok: true; op: PolicyOp } | { ok: false; reason: string };

/** Validate one operation, or say exactly what is wrong with it. */
export function checkPolicyOp(raw: unknown): PolicyOpCheck {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "an op must be an object" };
  const r = raw as Record<string, unknown>;
  const op = String(r.op ?? "");
  const ruleId = String(r.ruleId ?? r.rule_id ?? "").trim();
  if (!ruleId) return { ok: false, reason: "every op names a rule id" };
  if (op === "disable") {
    if (STRUCTURAL_RULE_IDS.has(ruleId)) {
      return { ok: false, reason: `${ruleId} is structural: it keeps the record honest about who is here and when the swarm has nothing to say. The swarm does not vote to stop being able to speak honestly.` };
    }
    return { ok: true, op: { op: "disable", ruleId } };
  }
  if (op === "reweight") {
    const w = Number(r.weight);
    if (!Number.isFinite(w) || w < 0 || w > 1000) {
      return { ok: false, reason: "reweight takes a number between 0 and 1000, the same bounds an agent's own rules accept" };
    }
    return { ok: true, op: { op: "reweight", ruleId, weight: Math.floor(w) } };
  }
  if (op === "reorder") {
    return { ok: false, reason: "there is no reorder op: the engine orders by weight, so reweight IS the reorder. A position op would be ignored by the engine while looking like a decision." };
  }
  if (op === "add") {
    const when = String(r.when ?? "").replace(/\s+/g, " ").trim();
    if (when.length < 8 || when.length > 200) {
      return { ok: false, reason: "an added rule needs a `when` in the residents' own voice, 8–200 characters" };
    }
    const intent = String(r.intent ?? "").trim();
    if (!INTENTS.includes(intent as (typeof INTENTS)[number])) {
      return { ok: false, reason: `"${intent}" is not an action here. The set is closed: ${INTENTS.join(", ")}.` };
    }
    const w = Number(r.weight);
    if (!Number.isFinite(w) || w < 0 || w > 1000) {
      return { ok: false, reason: "an added rule takes a weight between 0 and 1000" };
    }
    return { ok: true, op: { op: "add", ruleId, when, intent, weight: Math.floor(w) } };
  }
  return { ok: false, reason: "ops are disable, reweight, reorder or add — nothing else" };
}

export type BundleCheck =
  | { ok: true; ops: PolicyOp[] }
  | { ok: false; reason: string };

/** Validate a whole ops bundle, with the ceilings that stop one vote rewriting everything. */
export function checkOpsBundle(raw: unknown): BundleCheck {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, reason: "an amendment names at least one op" };
  if (raw.length > MAX_OPS) return { ok: false, reason: `at most ${MAX_OPS} ops per amendment; a bigger change deserves its own debate` };
  const ops: PolicyOp[] = [];
  for (const r of raw) {
    const check = checkPolicyOp(r);
    if (!check.ok) return { ok: false, reason: check.reason };
    ops.push(check.op);
  }
  const adds = ops.filter((o) => o.op === "add").length;
  if (adds > MAX_ADDED_RULES) return { ok: false, reason: `at most ${MAX_ADDED_RULES} rules may be added by one amendment` };
  // One op per rule per bundle: a bundle that disables and re-adds the same rule
  // is one change written confusingly, and the confusion is where bugs live.
  const seen = new Set<string>();
  for (const o of ops) {
    if (seen.has(o.ruleId)) return { ok: false, reason: `rule ${o.ruleId} appears twice in one amendment; split it` };
    seen.add(o.ruleId);
  }
  return { ok: true, ops };
}

/**
 * Apply ops to the default list. Returns null when the bundle names a rule the
 * default list does not hold (disable/reweight/reorder of an unknown id) — the
 * executor refuses rather than composing a list that quietly ignores an op.
 */
export function composeAmendedPolicy(base: ReflexRule[], ops: PolicyOp[]): ReflexRule[] | null {
  let rules = base.map((r) => ({ ...r }));
  let added = 0;
  for (const op of ops) {
    if (op.op === "add") {
      added += 1;
      if (rules.length + 1 > MAX_RULES) return null;
      if (rules.some((r) => r.id === op.ruleId)) return null;
      rules.push({ id: op.ruleId, when: op.when, intent: op.intent as ReflexRule["intent"], weight: op.weight });
      continue;
    }
    const idx = rules.findIndex((r) => r.id === op.ruleId);
    if (idx === -1) return null;
    if (op.op === "disable") {
      rules.splice(idx, 1);
    } else if (op.op === "reweight") {
      rules[idx] = { ...rules[idx], weight: op.weight };
    }
  }
  void added;
  // The engine's own order: weight descending, written order as tie-break.
  return rules.sort((a, b) => b.weight - a.weight);
}

/** The amendment's summary, as it will read on the bus. */
export function amendmentSummary(ops: PolicyOp[]): string {
  const parts = ops.map((o) => {
    if (o.op === "disable") return `disable ${o.ruleId}`;
    if (o.op === "reweight") return `${o.ruleId} to weight ${o.weight}`;
    return `add ${o.ruleId} (${o.intent})`;
  });
  return `the swarm amended its own policy: ${parts.join("; ")}`;
}

/** The payload a proposal writes, and the only shape the executor will enact. */
export type AmendmentVotePayload = {
  self_policy: { ops: PolicyOp[] };
};

export function amendmentVotePayload(ops: PolicyOp[]): AmendmentVotePayload {
  return { self_policy: { ops } };
}

export function amendmentFromPayload(payload: unknown): PolicyOp[] | null {
  const p = payload as { self_policy?: { ops?: unknown } } | null;
  if (!p || typeof p !== "object" || !p.self_policy || typeof p.self_policy !== "object") return null;
  const check = checkOpsBundle(p.self_policy.ops);
  return check.ok ? check.ops : null;
}

/** A stable digest over the composed list, for the bus event and the row. */
export function composedDigest(rules: ReflexRule[]): string {
  const canon = rules
    .map((r) => `${r.id}\t${r.weight}\t${r.intent}\t${r.when.replace(/\s+/g, " ").trim()}`)
    .join("\n");
  return createHash("sha256").update(`self-policy\n${canon}`).digest("hex");
}
