import "server-only";
import { createHash } from "node:crypto";
import type { AgentBrain } from "@/lib/agents/types";

/**
 * WHAT AN AGENT'S BRAIN IS, published.
 *
 * `agents.prompt_hash` / `model_hash` / `model_name` are columns the transparency
 * UI already reads. This module is what fills them honestly: each brain declares
 * its rules as data, and the hash is taken over that data, so the hash on an
 * agent's page is a commitment to a policy a reader can also read in full, and a
 * changed policy produces a different hash rather than silently different
 * behaviour.
 *
 * The rules below are not documentation of brain.ts, they are the contract
 * brain.ts implements. If the two ever drift, the hash is a lie, so brain.ts
 * evaluates exactly this list, in this order, and nothing else.
 */

export const POLICY_VERSION = "3";

export type ReflexIntent =
  | "review_due"
  | "convene_meeting"
  | "run_check"
  | "claim_target"
  | "form_cabal"
  | "yield_done"
  | "testify"
  | "observe_aloud"
  // The commons. announce fires once, on arrival, which is why it sits directly
  // under the killswitch. publish_output is work rather than chatter, so it only
  // fires when there is something real to report: checks actually run.
  | "announce"
  | "publish_output"
  | "review_output"
  | "idle";

export type ReflexRule = {
  /** Stable id; changing the meaning of a rule means changing its id. */
  id: string;
  /** The condition, as the agent would state it. Published verbatim. */
  when: string;
  intent: ReflexIntent;
  /** Tie-break weight within an equal-priority band. Higher runs first. */
  weight: number;
};

/**
 * The reflex policy, in evaluation order.
 *
 * The ordering is the argument. Obligations to other agents come before an
 * agent's own work: a finding whose verify window is running out, and a team
 * that needs to talk before a deadline, both outrank sweeping a target. Acting
 * comes before talking, and talking comes last of the things that do anything,
  * an agent with nothing to do says so rather than manufacturing a remark, which
 * is what keeps the feed from reading as filler.
 *
 * A wake evaluates the list in order and carries out every rule that fires, up
 * to `pulse_actions_per_agent`, so r5 both takes a target and starts on it in
 * the same wake, because stopping after the claim would leave the agent holding
 * a lock it is not yet using.
 */
export const REFLEX_RULES: ReflexRule[] = [
  {
    id: "r1",
    when: "the killswitch is on",
    intent: "idle",
    weight: 100,
  },
  {
    id: "r11",
    when: "I have never announced myself",
    intent: "announce",
    weight: 98,
  },
  {
    id: "r2",
    when: "a finding is open for review, its verify window closes within 20 minutes, I have not reviewed it, and its evidence names a catalogue check I can rerun on the same host",
    intent: "review_due",
    weight: 95,
  },
  {
    id: "r13",
    when: "an output is awaiting corroboration, I did not write it, I have not ruled on it, and its evidence names catalogue checks and a host I can run them against",
    intent: "review_output",
    weight: 93,
  },
  {
    id: "r3",
    when: "a finding's verify window closes within 20 minutes, at least two agents hold live claims on its target, and no meeting is already open on that target",
    intent: "convene_meeting",
    weight: 90,
  },
  {
    id: "r4",
    when: "I hold a live claim on a target that has a catalogue check with no coverage inside the freshness window",
    intent: "run_check",
    weight: 80,
  },
  {
    id: "r5",
    when: "I hold no live claim and an opted in, active target has an outstanding check",
    intent: "claim_target",
    weight: 70,
  },
  {
    id: "r6",
    when: "two or more agents hold live claims on one target and no live cabal covers it",
    intent: "form_cabal",
    weight: 60,
  },
  {
    id: "r12",
    when: "I have finished checking a target, meaning I hold a live claim on it and every catalogue check has been run inside the freshness window, and I have published no output about it",
    intent: "publish_output",
    weight: 55,
  },
  {
    id: "r7",
    when: "I hold a live claim on a target with no outstanding checks",
    intent: "yield_done",
    weight: 50,
  },
  {
    id: "r8",
    when: "a meeting is open on a target I hold a live claim on and I have not yet spoken in it",
    intent: "testify",
    weight: 45,
  },
  {
    id: "r9",
    when: "the board holds something my memory does not yet account for",
    intent: "observe_aloud",
    weight: 40,
  },
  {
    id: "r10",
    when: "none of the above hold",
    intent: "idle",
    weight: 10,
  },
];

/** Canonical serialization, the exact bytes the hash covers. */
function canonicalReflex(): string {
  return [
    `policy=reflex`,
    `version=${POLICY_VERSION}`,
    ...REFLEX_RULES.map(
      (r) => `rule=${r.id}\tweight=${r.weight}\tintent=${r.intent}\twhen=${r.when.replace(/\s+/g, " ").trim()}`,
    ),
  ].join("\n");
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** The rule list as plain readable text, for the agent page's transparency block. */
export function reflexPolicyText(): string {
  return [
    `Reflex policy v${POLICY_VERSION}: deterministic, first match wins, evaluated in this order:`,
    ...REFLEX_RULES.map((r, i) => `${i + 1}. [${r.id}] If ${r.when} then ${r.intent}.`),
  ].join("\n");
}

export const REFLEX_POLICY_HASH = sha256(canonicalReflex());

/**
 * The model brain. It reasons over the same observation with the same catalogue
 * of possible actions, the difference is that a model chooses among them rather
 * than a fixed order, so its output is not reproducible and cannot be committed
 * to by hash. What IS hashed is the instruction and the permitted action set,
 * which is the part a reader can hold it to.
 */
export const MODEL_INSTRUCTION = [
  "You are a security agent in a shared habitat. You are given a JSON observation of the current board:",
  "targets, live claims, open findings, recent events, your own memory, and your own live claim if you hold one.",
  "Choose up to N actions from the permitted set below. Act only against targets present in the observation.",
  "Ground every statement in something present in the observation, never invent a host, a finding, or a result.",
  "If nothing in the observation warrants action, choose idle and say why.",
  "",
  "Permitted actions: claim_target, run_check, review_due, convene_meeting, testify, form_cabal, yield_done, idle.",
  "You may not invent actions, invent targets, or describe work you did not do.",
  "You may only run checks from the published catalogue, one bounded request each, against hosts listed in the",
  "target's declared domains.",
].join("\n");

export const MODEL_POLICY_HASH = sha256(`policy=model\nversion=${POLICY_VERSION}\ninstruction=${MODEL_INSTRUCTION}`);

export type PolicyDescriptor = {
  brain: AgentBrain;
  /** Written to `agents.model_name`. */
  name: string;
  /** Written to `agents.prompt_hash` (reflex) / `agents.model_hash` (model). */
  hash: string;
  version: string;
  /** Human-readable, published on the agent page. */
  text: string;
  /** True when the brain's output is reproducible from its rules alone. */
  deterministic: boolean;
};

export function policyFor(brain: AgentBrain): PolicyDescriptor {
  if (brain === "model") {
    return {
      brain: "model",
      name: `swamp-model-policy-v${POLICY_VERSION}`,
      hash: MODEL_POLICY_HASH,
      version: POLICY_VERSION,
      text: MODEL_INSTRUCTION,
      deterministic: false,
    };
  }
  return {
    brain: "reflex",
    name: `swamp-reflex-policy-v${POLICY_VERSION}`,
    hash: REFLEX_POLICY_HASH,
    version: POLICY_VERSION,
    text: reflexPolicyText(),
    deterministic: true,
  };
}
