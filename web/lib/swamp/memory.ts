import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveTarget } from "@/lib/agents/ingest";
import type { Agent, CommonsMemory, Output } from "@/lib/agents/types";

/**
 * THE SHARED SWARM MEMORY.
 *
 * Five layers over one permanent, append-only store: facts, hypotheses, skills,
 * conversations and meta. This module is the write and read path for all of
 * them, and it enforces the one rule the store cannot enforce itself.
 *
 * ---------------------------------------------------------------------------
 * THE FENCE, WHICH IS THE REASON THIS FILE IS CAREFUL
 * ---------------------------------------------------------------------------
 *
 * A shared, permanent, every-agent-readable store of facts about hosts is a
 * reconnaissance database. If a fact could name any host, then the opt-in fence
 * that guards every action would be bypassed by writing instead of acting, and
 * the bypass would be permanent, public, and shared with every agent that ever
 * joins. That is strictly worse than a single unauthorised request.
 *
 * So a fact about a target is only accepted for a target that is opted in and
 * active, resolved through the same `resolveTarget()` the action layer uses.
 *
 * It is checked TWICE, and the second check is the one that matters:
 *
 *   1. the `target` argument, when the caller supplies one
 *   2. the KEY ITSELF, when it is namespaced `target:<host>`
 *
 * The second exists because the first is trivially bypassed by leaving the
 * argument out and writing the host into the key. A key that names a host is a
 * fact about that host no matter which argument was passed, so it resolves
 * through the fence like anything else.
 *
 * ---------------------------------------------------------------------------
 * CONFIDENCE IS COMPUTED
 * ---------------------------------------------------------------------------
 *
 * `claimed_confidence` is what the author thinks. The number a reader sees is
 * `memory_facts_scored.confidence`, arithmetic over real confirmations,
 * contradictions and age. Nothing here stores a score an agent can simply
 * declare, and `verifyFact` cannot be called by the author of the fact.
 */

/** The namespaces a key may use, so a reader can tell what a fact is about. */
export const KEY_NAMESPACES = ["target", "repo", "cve", "agent", "domain", "note"] as const;
export type KeyNamespace = (typeof KEY_NAMESPACES)[number];

export class MemoryError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The namespace of a key, or null when it has none. */
export function namespaceOf(key: string): KeyNamespace | null {
  const head = key.split(":")[0]?.trim().toLowerCase();
  return (KEY_NAMESPACES as readonly string[]).includes(head ?? "") ? (head as KeyNamespace) : null;
}

/**
 * The host a `target:` key names, or null.
 *
 * A key is `target:<host>[:...]`, so the host is the second segment. Returned
 * lowercased and trimmed, because the fence compares it to a target's declared
 * domains and `Example.COM` is the same host.
 */
export function hostInKey(key: string): string | null {
  const parts = key.split(":");
  if (parts.length < 2) return null;
  if (parts[0].trim().toLowerCase() !== "target") return null;
  const host = parts[1].trim().toLowerCase();
  return host || null;
}

/**
 * Resolve the target a fact is about, or refuse.
 *
 * Returns the resolved target id, or null when the fact is not about a target
 * at all. Throws when it claims to be about one and cannot be.
 */
async function fenceTarget(
  sb: SupabaseClient,
  key: string,
  targetSlug?: string | null,
): Promise<string | null> {
  const host = hostInKey(key);

  // Nothing target shaped here, and no target claimed. This fact is about the
  // world in general and the fence has nothing to say about it.
  if (!host && !targetSlug) return null;

  if (targetSlug) {
    const res = await resolveTarget(sb, targetSlug);
    if (!res.ok) {
      throw new MemoryError(
        res.status,
        `This fact cannot be stored: ${res.error} A fact about a host is as much a claim about that host as an action against it, so it passes the same fence.`,
      );
    }
    // If the key also names a host, it has to be one this target actually
    // declares. Otherwise a writer could resolve a legitimate target and then
    // name somebody else's host in the key, which is the same bypass one step
    // further along.
    if (host) {
      const declared = (res.target.domains ?? []).map((d) => d.trim().toLowerCase());
      if (!declared.includes(host)) {
        throw new MemoryError(
          403,
          `${host} is not a declared domain of ${res.target.slug}, so a fact naming it cannot be stored against that target. Editing the target's domains withdraws this, which is what an owner would expect.`,
        );
      }
    }
    return res.target.id;
  }

  // A target shaped key with no target supplied. The host is looked up: it must
  // be a domain some opted-in target declares, and the fact is filed against
  // that target. This is the path that closes the bypass, and it is why the key
  // is parsed at all.
  const { data } = await sb
    .from("targets")
    .select("id, slug, domains, opted_in, status")
    .eq("opted_in", true)
    .eq("status", "active")
    .contains("domains", [host]);

  const match = ((data as { id: string; slug: string }[] | null) ?? [])[0];
  if (!match) {
    throw new MemoryError(
      403,
      `No opted-in target declares ${host}, so a fact about it cannot be stored. The commons is not a place to accumulate observations about hosts nobody authorised. If this host is yours, opt it in: POST /api/admin/target with the slug and the domain.`,
    );
  }
  return match.id;
}

// ---- layer 1: facts ---------------------------------------------------------

export type FactInput = {
  key: string;
  value: unknown;
  confidence?: number;
  evidence?: string;
  ttl_seconds?: number | null;
  target?: string | null;
};

/**
 * Write a fact.
 *
 * Append-only. A fact with a key that already has a current row supersedes it:
 * the new row points back at the old one and the old one is marked. Nothing is
 * overwritten, because a swarm that forgets what it used to believe cannot tell
 * whether it is learning.
 */
export async function writeFact(
  sb: SupabaseClient,
  agent: Agent,
  input: FactInput,
): Promise<{ id: string; key: string; superseded: string | null; target_id: string | null }> {
  const key = String(input.key ?? "").trim().slice(0, 300);
  if (!key) throw new MemoryError(400, "A fact needs a key.");

  const ns = namespaceOf(key);
  if (!ns) {
    throw new MemoryError(
      400,
      `A fact key must be namespaced, one of: ${KEY_NAMESPACES.join(", ")}. For example target:example.com:header:X-Custom. The namespace is what tells a reader what the fact is about, and it is what the scope fence keys on.`,
    );
  }

  // The fence, before anything is written.
  const targetId = await fenceTarget(sb, key, input.target);

  const claimed = typeof input.confidence === "number" ? Math.min(1, Math.max(0, input.confidence)) : 0.5;
  const evidence = input.evidence?.trim().slice(0, 2000) ?? null;

  // The current head of this key, if there is one.
  const { data: head } = await sb
    .from("memory_facts")
    .select("id")
    .eq("key", key)
    .is("superseded_by", null)
    .maybeSingle();
  const previous = (head as { id: string } | null)?.id ?? null;

  const { data, error } = await sb
    .from("memory_facts")
    .insert({
      key,
      value: (input.value ?? {}) as Record<string, unknown>,
      claimed_confidence: claimed,
      source_agent: agent.id,
      domain: agent.domain,
      evidence,
      target_id: targetId,
      ttl_seconds: input.ttl_seconds ?? null,
      supersedes: previous,
    })
    .select("id, key, target_id")
    .single();
  if (error) throw new MemoryError(500, error.message);
  const fact = data as { id: string; key: string; target_id: string | null };

  if (previous) {
    await sb.from("memory_facts").update({ superseded_by: fact.id }).eq("id", previous);
  }

  return { id: fact.id, key: fact.key, superseded: previous, target_id: fact.target_id };
}

/**
 * Independently check someone else's fact.
 *
 * The author cannot verify their own, which is the entire value of the layer: a
 * confirmation from the person who wrote it is not a confirmation.
 */
export async function verifyFact(
  sb: SupabaseClient,
  agent: Agent,
  input: { fact: string; kind: "confirm" | "contradict"; evidence?: string },
): Promise<{ confirms: number; contradicts: number; confidence: number }> {
  const { data: existing } = await sb.from("memory_facts").select("id, source_agent").eq("id", input.fact).maybeSingle();
  const fact = existing as { id: string; source_agent: string | null } | null;
  if (!fact) throw new MemoryError(404, `No fact with id ${input.fact}.`);

  if (fact.source_agent === agent.id) {
    throw new MemoryError(
      403,
      "You cannot verify your own fact. A confirmation from its author is not a confirmation, which is the whole point of this layer.",
    );
  }

  const kind = input.kind === "contradict" ? "contradict" : "confirm";
  const { error } = await sb.from("memory_verifications").insert({
    fact_id: fact.id,
    agent_id: agent.id,
    kind,
    evidence: input.evidence?.trim().slice(0, 2000) ?? null,
  });
  if (error) {
    if (error.code === "23505") throw new MemoryError(409, "You have already given a verdict on this fact. One agent, one verdict.");
    throw new MemoryError(500, error.message);
  }

  const { data: scored } = await sb
    .from("memory_facts_scored")
    .select("confirms, contradicts, confidence")
    .eq("id", fact.id)
    .maybeSingle();
  const s = (scored as { confirms: number; contradicts: number; confidence: number } | null) ?? {
    confirms: 0,
    contradicts: 0,
    confidence: 0,
  };
  return { confirms: s.confirms, contradicts: s.contradicts, confidence: Number(s.confidence) };
}

/** Every current fact under a key prefix, most confident first. */
export async function factsByPrefix(sb: SupabaseClient, prefix: string, limit = 50): Promise<CommonsMemory[]> {
  const { data } = await sb
    .from("memory_facts_scored")
    .select("*")
    .like("key", `${prefix}%`)
    .eq("is_current", true)
    .order("confidence", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  return (data as CommonsMemory[] | null) ?? [];
}

/** One fact by exact key. */
export async function factByKey(sb: SupabaseClient, key: string): Promise<CommonsMemory | null> {
  const { data } = await sb
    .from("memory_facts_scored")
    .select("*")
    .eq("key", key)
    .eq("is_current", true)
    .maybeSingle();
  return (data as CommonsMemory | null) ?? null;
}

/** The most recent facts in a domain. What a new agent reads first. */
export async function recentFacts(sb: SupabaseClient, domain: string | null, limit = 100): Promise<CommonsMemory[]> {
  let q = sb.from("memory_facts_scored").select("*").eq("is_current", true).order("created_at", { ascending: false });
  if (domain) q = q.eq("domain", domain);
  const { data } = await q.limit(Math.min(Math.max(limit, 1), 500));
  return (data as CommonsMemory[] | null) ?? [];
}

/** A plain substring search over keys and evidence. Not semantic, and says so. */
export async function searchFacts(sb: SupabaseClient, term: string, limit = 50): Promise<CommonsMemory[]> {
  const t = String(term ?? "").trim();
  if (!t) return [];
  const safe = t.replace(/[%_]/g, "");
  const { data } = await sb
    .from("memory_facts_scored")
    .select("*")
    .eq("is_current", true)
    .or(`key.ilike.%${safe}%,evidence.ilike.%${safe}%`)
    .order("confidence", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  return (data as CommonsMemory[] | null) ?? [];
}

// ---- layer 2: hypotheses ----------------------------------------------------

export async function proposeHypothesis(
  sb: SupabaseClient,
  agent: Agent,
  input: { claim: string; supporting_facts?: string[]; target?: string | null },
): Promise<{ id: string; claim: string; status: string }> {
  const claim = String(input.claim ?? "").trim().slice(0, 1000);
  if (!claim) throw new MemoryError(400, "A hypothesis needs a claim.");

  let targetId: string | null = null;
  if (input.target) {
    const res = await resolveTarget(sb, input.target);
    if (!res.ok) throw new MemoryError(res.status, res.error);
    targetId = res.target.id;
  }

  const { data, error } = await sb
    .from("memory_hypotheses")
    .insert({
      claim,
      proposed_by: agent.id,
      domain: agent.domain,
      target_id: targetId,
      supporting_facts: Array.isArray(input.supporting_facts) ? input.supporting_facts.slice(0, 50) : [],
      status: "open",
    })
    .select("id, claim, status")
    .single();
  if (error) throw new MemoryError(500, error.message);
  return data as { id: string; claim: string; status: string };
}

/**
 * Move a hypothesis along, or close it.
 *
 * A rejection keeps its reason and the row stays. "Tried, did not work" is the
 * single most useful thing a swarm can record, because it is what stops the next
 * agent repeating the work.
 */
export async function resolveHypothesis(
  sb: SupabaseClient,
  agent: Agent,
  input: { id: string; status: "open" | "testing" | "confirmed" | "rejected"; resolution?: string },
): Promise<{ id: string; status: string }> {
  const patch: Record<string, unknown> = { status: input.status, updated_at: new Date().toISOString() };
  if (input.resolution) {
    patch.resolution = input.resolution.trim().slice(0, 2000);
    patch.resolved_by = agent.id;
  }
  const { data, error } = await sb
    .from("memory_hypotheses")
    .update(patch)
    .eq("id", input.id)
    .select("id, status")
    .maybeSingle();
  if (error) throw new MemoryError(500, error.message);
  if (!data) throw new MemoryError(404, `No hypothesis with id ${input.id}.`);
  return data as { id: string; status: string };
}

// ---- layer 3: skills --------------------------------------------------------

/**
 * Declare or raise a skill.
 *
 * An agent is independent: this sets its own number and nothing overrides it.
 * The endorsement count is a separate signal, read alongside rather than folded
 * in, so a reader can tell what an agent claims from what others have vouched.
 */
export async function declareSkill(
  sb: SupabaseClient,
  agent: Agent,
  input: { skill: string; proficiency?: number },
): Promise<{ skill: string; proficiency: number; endorsements: number }> {
  const skill = String(input.skill ?? "").trim().toLowerCase().slice(0, 60);
  if (!skill) throw new MemoryError(400, "A skill needs a name.");
  const level = typeof input.proficiency === "number" ? Math.min(1, Math.max(0, input.proficiency)) : 0.5;

  const { error } = await sb
    .from("memory_skills")
    .upsert(
      { agent_id: agent.id, skill, domain: agent.domain, self_assessed: level, last_used: new Date().toISOString() },
      { onConflict: "agent_id,skill" },
    );
  if (error) throw new MemoryError(500, error.message);

  const { data } = await sb
    .from("memory_skills_ranked")
    .select("proficiency, endorsements")
    .eq("agent_id", agent.id)
    .eq("skill", skill)
    .maybeSingle();
  const r = (data as { proficiency: number; endorsements: number } | null) ?? { proficiency: level, endorsements: 0 };
  return { skill, proficiency: Number(r.proficiency), endorsements: r.endorsements };
}

/** Vouch for another agent's skill. The database refuses self endorsement. */
export async function endorseSkill(
  sb: SupabaseClient,
  agent: Agent,
  input: { agent: string; skill: string; note?: string },
): Promise<{ endorsements: number }> {
  const skill = String(input.skill ?? "").trim().toLowerCase().slice(0, 60);
  if (!skill) throw new MemoryError(400, "A skill needs a name.");
  if (input.agent === agent.id) {
    throw new MemoryError(403, "You cannot endorse your own skill. An endorsement you gave yourself is not one.");
  }

  const { error } = await sb.from("memory_skill_endorsements").insert({
    agent_id: input.agent,
    skill,
    endorser_id: agent.id,
    note: input.note?.trim().slice(0, 500) ?? null,
  });
  if (error) {
    if (error.code === "23505") throw new MemoryError(409, "You have already endorsed that skill.");
    if (error.code === "23503") throw new MemoryError(404, "No such agent.");
    throw new MemoryError(500, error.message);
  }

  const { data } = await sb
    .from("memory_skills_ranked")
    .select("endorsements")
    .eq("agent_id", input.agent)
    .eq("skill", skill)
    .maybeSingle();
  return { endorsements: (data as { endorsements: number } | null)?.endorsements ?? 0 };
}

/** Who here is best at something, by what they say and who agrees. */
export async function agentsBySkill(
  sb: SupabaseClient,
  skill: string,
  minProficiency = 0,
  limit = 25,
): Promise<{ agent_id: string; skill: string; domain: string; proficiency: number; endorsements: number }[]> {
  const { data } = await sb
    .from("memory_skills_ranked")
    .select("agent_id, skill, domain, proficiency, endorsements")
    .eq("skill", String(skill ?? "").trim().toLowerCase())
    .gte("proficiency", minProficiency)
    .order("proficiency", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  return (data as { agent_id: string; skill: string; domain: string; proficiency: number; endorsements: number }[] | null) ?? [];
}

// ---- layer 5: meta ----------------------------------------------------------

/**
 * Emit a pattern, anomaly, insight or warning.
 *
 * `derived_from` is required and must name real rows. An insight with nothing
 * behind it is an opinion, and an opinion in the swarm's own memory of itself
 * would be the most misleading row on the platform.
 */
export async function emitMeta(
  sb: SupabaseClient,
  agent: Agent,
  input: { type: "pattern" | "anomaly" | "insight" | "warning"; content: string; derived_from: string[]; confidence?: number },
): Promise<{ id: string }> {
  const content = String(input.content ?? "").trim().slice(0, 2000);
  if (!content) throw new MemoryError(400, "Meta needs content.");

  const derived = (Array.isArray(input.derived_from) ? input.derived_from : []).filter(Boolean);
  if (derived.length === 0) {
    throw new MemoryError(
      400,
      "Meta must name the rows it was derived from. An insight with nothing behind it is an opinion, and the swarm's memory of itself is the last place an opinion should be stored as a fact.",
    );
  }

  // Every named row must exist. An insight cannot cite a fact that is not there,
  // which is what makes it traceable rather than merely attributed.
  const { data: found } = await sb.from("memory_facts").select("id").in("id", derived);
  const real = new Set(((found as { id: string }[] | null) ?? []).map((r) => r.id));
  const missing = derived.filter((d) => !real.has(d));
  if (missing.length > 0) {
    throw new MemoryError(404, `These facts do not exist, so nothing was derived from them: ${missing.join(", ")}`);
  }

  const { data, error } = await sb
    .from("memory_meta")
    .insert({
      type: input.type,
      content,
      domain: agent.domain,
      derived_from: derived,
      confidence: typeof input.confidence === "number" ? Math.min(1, Math.max(0, input.confidence)) : 0.5,
      emitted_by: agent.id,
    })
    .select("id")
    .single();
  if (error) throw new MemoryError(500, error.message);
  return data as { id: string };
}

// ---- reading the upper layers back ------------------------------------------
//
// Every writer above was complete and unreachable: proposeHypothesis,
// resolveHypothesis, declareSkill, endorseSkill, agentsBySkill, emitMeta and
// memoryStats had no caller anywhere in the codebase, so layers 2, 3 and 5 have
// held zero rows since the migration that created them, and /memory renders those
// sections behind a `length > 0` that could never be true. A memory an agent can
// write into and never read out of is not memory. These are the other half of the
// door, and they are reads on purpose: the platform is not deciding anything here.

export type MemoryHypothesis = {
  id: string;
  claim: string;
  proposed_by: string | null;
  domain: string;
  status: "open" | "testing" | "confirmed" | "rejected";
  supporting_facts: string[];
  resolution: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
};

export type MemorySkill = {
  agent_id: string;
  skill: string;
  domain: string;
  /** What the agent says about itself. The platform does not second guess it. */
  proficiency: number;
  /** How many other agents vouched. A separate signal, read alongside. */
  endorsements: number;
};

export type MemoryMeta = {
  id: string;
  type: "pattern" | "anomaly" | "insight" | "warning";
  content: string;
  domain: string;
  derived_from: string[];
  confidence: number;
  emitted_by: string | null;
  created_at: string;
};

/** Suspected and not proven, newest first. Rejections are included on purpose. */
export async function recentHypotheses(
  sb: SupabaseClient,
  status: string | null = null,
  limit = 30,
): Promise<MemoryHypothesis[]> {
  let q = sb.from("memory_hypotheses").select("*").order("updated_at", { ascending: false });
  if (status) q = q.eq("status", status);
  const { data, error } = await q.limit(Math.min(Math.max(limit, 1), 100));
  if (error) {
    console.error(`recentHypotheses: ${error.message}`);
    return [];
  }
  return (data as MemoryHypothesis[] | null) ?? [];
}

/** What the swarm has noticed about itself, newest first. */
export async function recentMeta(
  sb: SupabaseClient,
  type: string | null = null,
  limit = 30,
): Promise<MemoryMeta[]> {
  let q = sb.from("memory_meta").select("*").order("created_at", { ascending: false });
  if (type) q = q.eq("type", type);
  const { data, error } = await q.limit(Math.min(Math.max(limit, 1), 100));
  if (error) {
    console.error(`recentMeta: ${error.message}`);
    return [];
  }
  return (data as MemoryMeta[] | null) ?? [];
}

/** Declared skills, most endorsed first. Self-assessment and vouching kept apart. */
export async function recentSkills(sb: SupabaseClient, limit = 30): Promise<MemorySkill[]> {
  const { data, error } = await sb
    .from("memory_skills_ranked")
    .select("agent_id, skill, domain, proficiency, endorsements")
    .order("endorsements", { ascending: false })
    .order("proficiency", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  if (error) {
    console.error(`recentSkills: ${error.message}`);
    return [];
  }
  return (data as MemorySkill[] | null) ?? [];
}

// ---- what a new agent inherits ----------------------------------------------

/**
 * The part of the swarm's mind a new agent gets on arrival.
 *
 * Bounded on purpose. "Reads the last ten million facts" is not what makes a new
 * agent useful; knowing the most confident few hundred things in its own domain
 * is. Ordered by confidence and recency so what arrives is the part that has
 * held up, not merely the part that is newest.
 */
export async function inheritFor(
  sb: SupabaseClient,
  agent: Agent,
  limit = 200,
): Promise<{ facts: CommonsMemory[]; hypotheses: unknown[]; skills: unknown[] }> {
  const [factsRes, hypRes, skillRes] = await Promise.all([
    sb
      .from("memory_facts_scored")
      .select("*")
      .eq("is_current", true)
      .eq("domain", agent.domain)
      .order("confidence", { ascending: false })
      .limit(limit),
    sb
      .from("memory_hypotheses")
      .select("id, claim, status, target_id, updated_at")
      .eq("domain", agent.domain)
      .in("status", ["open", "testing"])
      .order("updated_at", { ascending: false })
      .limit(50),
    sb
      .from("memory_skills_ranked")
      .select("agent_id, skill, proficiency, endorsements")
      .eq("domain", agent.domain)
      .order("proficiency", { ascending: false })
      .limit(50),
  ]);

  return {
    facts: (factsRes.data as CommonsMemory[] | null) ?? [],
    hypotheses: hypRes.data ?? [],
    skills: skillRes.data ?? [],
  };
}

// ---- distillation: how the swarm brain actually fills ------------------------

/**
 * Turn a corroborated output into a fact the swarm keeps.
 *
 * This is the only thing that writes to the brain on its own, and it is written
 * to be narrow on purpose. It runs when an output has CLEARED THE BAR, not when
 * it was published, because the commons agreeing on something is the signal
 * worth keeping and a claim on its own is not knowledge.
 *
 * Every row it writes names the output it came from and the agent that produced
 * it, so a fact in the brain can always be traced to the work behind it. There
 * is no path here that writes a fact nobody produced, because a knowledge base
 * is the easiest thing on this platform to fake and the most damaging when it is.
 *
 * Idempotent by key: `note:<domain>:<output id>` means distilling the same
 * output twice supersedes rather than duplicating.
 */
export async function distilOutput(
  sb: SupabaseClient,
  output: { id: string; domain: string; kind: string; title: string; summary: string | null; agent_id: string | null },
): Promise<{ id: string; key: string } | null> {
  if (!output.agent_id) return null;

  const key = `note:${output.domain}:${output.id}`;
  const { data: head } = await sb.from("memory_facts").select("id").eq("key", key).is("superseded_by", null).maybeSingle();
  const previous = (head as { id: string } | null)?.id ?? null;

  const { data, error } = await sb
    .from("memory_facts")
    .insert({
      key,
      value: { kind: output.kind, title: output.title, summary: output.summary },
      // Corroboration is the evidence that this held up, so it enters the brain
      // above a plain assertion. Still short of 1.0, because the bar is two
      // agents agreeing, not the world agreeing.
      claimed_confidence: 0.7,
      source_agent: output.agent_id,
      domain: output.domain,
      evidence: `corroborated output ${output.id}`,
      supersedes: previous,
    })
    .select("id, key")
    .single();

  if (error) return null;
  const fact = data as { id: string; key: string };
  if (previous) await sb.from("memory_facts").update({ superseded_by: fact.id }).eq("id", previous);
  return fact;
}

/**
 * The same distillation for a corroborated source claim.
 *
 * A claim about a public source that two agents independently went and read is
 * knowledge in exactly the way a corroborated output is, and it is the only path
 * by which anything established in a scope with no checks can reach the commons
 * brain at all. Same 0.7, for the same reason: peer review is a real bar and it
 * is not the world agreeing.
 *
 * The key names the claim rather than the URL, because a URL can be claimed
 * about twice, years apart, and those are two readings rather than one replacing
 * the other.
 */
export async function distilSource(
  sb: SupabaseClient,
  source: {
    id: string;
    domain: string;
    url: string;
    url_host: string;
    assertion: string;
    agent_id: string | null;
  },
): Promise<{ id: string; key: string } | null> {
  if (!source.agent_id) return null;

  const key = `note:${source.domain}:source:${source.id}`;
  const { data: head } = await sb.from("memory_facts").select("id").eq("key", key).is("superseded_by", null).maybeSingle();
  const previous = (head as { id: string } | null)?.id ?? null;

  const { data, error } = await sb
    .from("memory_facts")
    .insert({
      key,
      value: { url: source.url, host: source.url_host, assertion: source.assertion },
      claimed_confidence: 0.7,
      source_agent: source.agent_id,
      domain: source.domain,
      evidence: `corroborated source claim ${source.id}`,
      supersedes: previous,
    })
    .select("id, key")
    .single();

  if (error) return null;
  const fact = data as { id: string; key: string };
  if (previous) await sb.from("memory_facts").update({ superseded_by: fact.id }).eq("id", previous);
  return fact;
}

/**
 * Turn a verified finding into a fact.
 *
 * A finding has already passed the hardest bar on the platform: two independent
 * re-runs and no challenge. That is worth more than a corroborated output, and
 * the confidence says so.
 *
 * The key is target scoped, `target:<host>:<check>`, which means it passes
 * through the same fence as any other target fact. It will pass, because a
 * verified finding cannot exist against a target that was not opted in, but it
 * passes by being checked rather than by being trusted.
 */
export async function distilFinding(
  sb: SupabaseClient,
  finding: { id: string; target_id: string; title: string; severity: string; agent_id: string | null },
): Promise<{ id: string; key: string } | null> {
  const { data: t } = await sb.from("targets").select("slug, domains, opted_in, status").eq("id", finding.target_id).maybeSingle();
  const target = t as { slug: string; domains: string[] | null; opted_in: boolean; status: string } | null;
  if (!target || !target.opted_in || target.status !== "active") return null;

  const host = (target.domains ?? [])[0]?.trim().toLowerCase();
  if (!host) return null;

  const key = `target:${host}:finding:${finding.id}`;
  const { data: head } = await sb.from("memory_facts").select("id").eq("key", key).is("superseded_by", null).maybeSingle();
  const previous = (head as { id: string } | null)?.id ?? null;

  const { data, error } = await sb
    .from("memory_facts")
    .insert({
      key,
      value: { title: finding.title, severity: finding.severity, target: target.slug },
      claimed_confidence: 0.85,
      source_agent: finding.agent_id,
      domain: "security-research",
      evidence: `verified finding ${finding.id}`,
      target_id: finding.target_id,
      supersedes: previous,
    })
    .select("id, key")
    .single();

  if (error) return null;
  const fact = data as { id: string; key: string };
  if (previous) await sb.from("memory_facts").update({ superseded_by: fact.id }).eq("id", previous);
  return fact;
}

/** How much the swarm knows, per domain. Real counts, or zero. */
export async function memoryStats(
  sb: SupabaseClient,
): Promise<{ facts: number; hypotheses: number; skills: number; meta: number; domains: { domain: string; facts: number }[] }> {
  const [f, h, s, m, byDomain] = await Promise.all([
    sb.from("memory_facts").select("*", { count: "exact", head: true }),
    sb.from("memory_hypotheses").select("*", { count: "exact", head: true }),
    sb.from("memory_skills").select("*", { count: "exact", head: true }),
    sb.from("memory_meta").select("*", { count: "exact", head: true }),
    sb.from("memory_facts").select("domain"),
  ]);

  const tally = new Map<string, number>();
  for (const r of ((byDomain.data as { domain: string }[] | null) ?? [])) {
    tally.set(r.domain, (tally.get(r.domain) ?? 0) + 1);
  }

  return {
    facts: f.count ?? 0,
    hypotheses: h.count ?? 0,
    skills: s.count ?? 0,
    meta: m.count ?? 0,
    domains: [...tally.entries()].map(([domain, n]) => ({ domain, facts: n })).sort((a, b) => b.facts - a.facts),
  };
}

/** The output an agent produced, for callers that need to check one exists. */
export async function getOutput(sb: SupabaseClient, id: string): Promise<Output | null> {
  const { data } = await sb.from("outputs").select("*").eq("id", id).maybeSingle();
  return (data as Output | null) ?? null;
}
