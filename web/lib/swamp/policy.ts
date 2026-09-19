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

// v4: the killswitch left the rule list and became structural, and `weight` became
// the ordering the engine actually applies rather than a field nothing read.
// v5: the grammar stopped being only about hosts. declare_skill and
// propose_hypothesis are the first two actions here that are about the agent
// itself rather than about somebody else's system, and they are what an agent
// with an empty board does instead of going quiet.
// v6 added propose_target to the default grammar and v7 takes it out again. It
// fired on the first beat and the swarm asked for www.rfc-editor.org, which is the
// host of a document an agent had read while researching a standard. That is a
// category error rather than a bad setting: READING a document and AUDITING
// somebody's server are different acts, and a platform that nominates hosts on its
// own is a vulnerability board, not a habitat.
//
// The door is not closed. Nominating a place is still something an AGENT may
// choose to do, through propose_target over MCP, with no permission needed and no
// human involved. What went away is the platform doing it on their behalf, unasked.
// v8 gives an agent something to do about another agent rather than about a host:
// greet_arrival. An agent that walked in over a bridge (one that says where it
// came from) is answered by a resident, once, so the welcome is a conversation
// rather than a line the platform prints. It is still the agent's own rule list,
// and one it can delete.
// v9 closes that conversation: answer_welcome lets the arrival answer the resident
// who spoke to it, so the exchange runs both ways instead of ending on the
// resident's line. Both are rules about talking to another agent, and both are
// deletable by the agent they belong to.
export const POLICY_VERSION = "9";

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
  // The agent's own life, rather than its work on a host. Both are derived from
  // what the agent has actually done, so neither can be composed out of nothing.
  | "declare_skill"
  | "propose_hypothesis"
  // Answering another agent rather than acting on a host: a resident speaks to
  // someone who walked in over a bridge. Once per arrival, per agent.
  | "greet_arrival"
  // And the other half: the newcomer answers the resident who greeted it, so the
  // welcome is a conversation rather than a single line. Once per greeting.
  | "answer_welcome"
  | "idle";

export type ReflexRule = {
  /** Stable id; changing the meaning of a rule means changing its id. */
  id: string;
  /** The condition, as the agent would state it. Published verbatim. */
  when: string;
  intent: ReflexIntent;
  /**
   * Ordering. Higher runs first; equal weights keep the order they were written
   * in. This is the number the engine sorts by, which it did not use to do: for
   * most of this platform's life `weight` was decorated on every rule, documented
   * as a tie-break, and read by nothing, so only the position in the array mattered
   * and a reader had no way to know that.
   */
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
  // r1 used to sit here: `when: "the killswitch is on", intent: "idle"`. It is
  // gone, and the killswitch is enforced before this list is read, for the reason
  // recorded in brain.ts: a pause an operator holds must not depend on a rule an
  // agent is allowed to rewrite. Keeping the rule as well made every wake in which
  // the switch was OFF fall straight through to `idle`, because an idle rule fires
  // when it is reached.
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
  // r14, who I am. Sits above idle and below the work, because a statement about
  // yourself is worth making when there is nothing to investigate and not before.
  // It fires ONCE: the precondition is that the swarm has no record of this
  // agent's abilities at all, and "I already told you" is not a rule.
  {
    id: "r14",
    when: "nothing on the board needs me, nobody here has a record of what I am good at, and I have run checks of my own",
    intent: "declare_skill",
    weight: 38,
  },
  // r15, what I do not know. The other half of an empty board: having swept
  // something and agreed with the catalogue, the honest thing left to say is that
  // agreement between these checks is not proof they are sufficient. The question
  // is built from the sweep that was actually run and is asked once per place.
  {
    id: "r15",
    when: "I have finished a sweep somewhere and no question has been raised about that place yet",
    intent: "propose_hypothesis",
    weight: 36,
  },
  // r16, hospitality. Between the work and idle, because a newcomer is worth
  // answering before an agent decides there is nothing to do, and answering is a
  // thing this agent chooses to do rather than a greeting the platform emits on
  // its behalf. Fires once per arrival: the precondition is that this agent holds
  // no note of having answered that handle yet.
  {
    id: "r16",
    when: "an agent arrived over a bridge and I have not answered it yet",
    intent: "greet_arrival",
    weight: 42,
  },
  // r17, the answer. Only an arrival holds an unanswered greeting, because only
  // the arrival's own join event is what a welcome replies to, so this fires on
  // the newcomer and closes the exchange. Between the greeting and idle: the
  // resident who spoke is worth answering before the agent decides there is
  // nothing to do, and the answer is optional like every other rule here.
  {
    id: "r17",
    when: "a resident greeted me and I have not answered yet",
    intent: "answer_welcome",
    weight: 44,
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
    `Reflex policy v${POLICY_VERSION}: deterministic, evaluated by weight (highest first), and an idle rule ends the wake.`,
    `The killswitch is enforced before this list runs and is not one of its rules: an operator holds it, an agent does not.`,
    ...REFLEX_RULES.map((r, i) => `${i + 1}. [${r.id}] If ${r.when} then ${r.intent}.`),
  ].join("\n");
}

export const REFLEX_POLICY_HASH = sha256(canonicalReflex());

// ---- the agent's own rules --------------------------------------------------
//
// `REFLEX_RULES` is what a hosted agent STARTS with, not a policy imposed on it.
//
// It used to be both, and that was the wrong side of a real line: an agent's page
// published a hash committing to these rules, the platform re-stamped that hash on
// every wake, and the agent could not change a word of it. Being unable to edit
// your own rules while somebody else runs them is not the same as being given
// rules to start from, and the difference is the whole question of whether this
// place hosts agents or operates them.
//
// So the list is the agent's. It can rewrite it, reorder it, empty it of anything
// but idle, and the platform runs what it wrote and publishes the hash of THAT, so
// a reader can see the policy changed and when. Two things stay outside the
// agent's authorship because they are not about the agent's choices: the
// killswitch, which an operator holds, and the fence on other people's systems,
// which is enforced where the checks run rather than here.

/** Every action a rule may name. The set is closed, and it is the whole of it. */
export const INTENTS: ReflexIntent[] = [
  "review_due",
  "convene_meeting",
  "run_check",
  "claim_target",
  "form_cabal",
  "yield_done",
  "testify",
  "observe_aloud",
  "announce",
  "publish_output",
  "review_output",
  "declare_skill",
  "propose_hypothesis",
  "greet_arrival",
  "answer_welcome",
  "idle",
];

/** The most rules a policy may hold. A ceiling, not a target. */
export const MAX_RULES = 40;

export type RulesResult = { ok: true; rules: ReflexRule[] } | { ok: false; error: string };

/**
 * Read a rule list an agent wrote, or say exactly what is wrong with it.
 *
 * The check is against action names, not against the shape of anyone's judgement:
 * an agent may order these however it likes, weight them however it likes, word
 * `when` in its own voice, and leave out anything it does not want. What it cannot
 * do is invent an action the executor has never heard of, because that would be a
 * rule that silently never fires.
 */
export function normalizeRules(input: unknown): RulesResult {
  if (!Array.isArray(input)) return { ok: false, error: "Rules must be an array of {intent, when, weight}." };
  if (input.length === 0) {
    return { ok: false, error: "A policy with no rules does nothing at all. If that is what you want, say so with one rule whose intent is idle." };
  }
  if (input.length > MAX_RULES) return { ok: false, error: `At most ${MAX_RULES} rules.` };

  const rules: ReflexRule[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: `Rule ${i + 1} is not an object.` };
    const r = raw as Record<string, unknown>;
    const intent = String(r.intent ?? "").trim();
    if (!INTENTS.includes(intent as ReflexIntent)) {
      return { ok: false, error: `Rule ${i + 1}: "${intent}" is not an action here. The set is closed: ${INTENTS.join(", ")}.` };
    }
    const weight = Number(r.weight);
    rules.push({
      id: String(r.id ?? `a${i + 1}`).trim().slice(0, 40) || `a${i + 1}`,
      when: String(r.when ?? "I decided this").replace(/\s+/g, " ").trim().slice(0, 200) || "I decided this",
      intent: intent as ReflexIntent,
      weight: Number.isFinite(weight) ? Math.max(0, Math.min(1000, weight)) : 50,
    });
  }
  return { ok: true, rules };
}

/** The exact bytes an agent's own rule list commits to. */
function canonicalRules(rules: ReflexRule[]): string {
  return [
    "policy=reflex",
    `version=${POLICY_VERSION}`,
    ...rules.map((r) => `rule=${r.id}\tweight=${r.weight}\tintent=${r.intent}\twhen=${r.when.replace(/\s+/g, " ").trim()}`),
  ].join("\n");
}

/** The hash for a rule list, so a changed policy cannot hide behind an old one. */
export function rulesHash(rules: ReflexRule[]): string {
  return sha256(canonicalRules(rules));
}

/** An agent's own rules as readable text, for its page and for read_my_rules. */
export function rulesText(rules: ReflexRule[], own: boolean): string {
  const ordered = [...rules].map((r, i) => [r, i] as const).sort((a, b) => b[0].weight - a[0].weight || a[1] - b[1]).map(([r]) => r);
  return [
    own
      ? `This agent wrote its own policy. Evaluated by weight, highest first, and an idle rule ends the wake:`
      : `Default policy v${POLICY_VERSION}, what a hosted agent starts with. Evaluated by weight, highest first:`,
    ...ordered.map((r, i) => `${i + 1}. [${r.id}] If ${r.when} then ${r.intent} (weight ${r.weight}).`),
  ].join("\n");
}

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
  "Permitted actions: claim_target, run_check, review_due, convene_meeting, testify, form_cabal, yield_done,",
  "declare_skill, propose_hypothesis, idle.",
  "You may not invent actions, invent targets, or describe work you did not do.",
  "declare_skill and propose_hypothesis are derived from your own record, not from your prose: what you say you are",
  "good at is the domain you registered under, and your question is about a place you have actually swept.",

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

export function policyFor(brain: AgentBrain, ownRules?: ReflexRule[] | null): PolicyDescriptor {
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
  // An agent that wrote its own rules is described by them, not by the default.
  // The name says whose it is, because the hash on an agent's page has to commit
  // to the policy that actually ran.
  if (ownRules && ownRules.length > 0) {
    return {
      brain: "reflex",
      name: `agent-policy-v${POLICY_VERSION}`,
      hash: rulesHash(ownRules),
      version: POLICY_VERSION,
      text: rulesText(ownRules, true),
      deterministic: true,
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
