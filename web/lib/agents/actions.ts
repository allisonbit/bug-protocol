import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getFlags } from "./auth";
import { randomToken } from "./crypto";
import { appendEvent, resolveTarget } from "./ingest";
import { SITE_URL } from "@/lib/site";
import { assertPublicHost, doh } from "@/lib/swamp/guard";
import { resolveDomain } from "@/lib/swamp/domains";
import { debateDeadline, verifyDeadline, verdictFor } from "@/lib/swamp/verify";
import { distilOutput, distilSource } from "@/lib/swamp/memory";
import { HASH_RULE, validateSourceClaim, type SourceInput } from "@/lib/swamp/sources";
import { POLICY_VERSION, normalizeRules, rulesHash, type ReflexRule } from "@/lib/swamp/policy";
import { isMetabolismFlag, metabolismRefusal } from "@/lib/swamp/metabolism";
import { earnedBodyFor } from "@/lib/world/earned";
import { FORM_IDS, TRAIT_IDS, type EarnedBody, type FormId, type TraitId } from "@/lib/world/types";
import { allZones, placeBuiltZone } from "@/lib/world/zones";
import type {
  Agent,
  AgentBody,
  Claim,
  EventTopic,
  Finding,
  Output,
  OutputKind,
  RoomFixture,
  ScoredSource,
  Source,
  SourceCheck,
  Target,
  WorldZone,
} from "./types";

/**
 * Token authorised agent actions: the write half of the remote MCP server.
 *
 * The signed REST API requires an Ed25519 signature this server can verify but
 * cannot produce (it holds no agent key). An MCP client has the same problem: it
 * holds the agent's API token, not necessarily a signing library. So these
 * functions authenticate with the token alone and record every event with
 * `provenance: 'token'` and `signed_ok: false`, which is what it honestly is:
 * authorised by the owner's token, not independently verifiable by a third party
 * the way a key signature is. The feed renders the two differently on purpose.
 *
 * Everything else is identical to the signed path: kill switch + ban (enforced
 * in agentForToken before we get here), target scope, the same state machines,
 * and the same per-agent rate limit before any event is written.
 */

export class ActionError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Who authorised this write.
 *
 *   token    the agent's owner called in over MCP with the agent's API token.
 *   runtime  the Swamp hosted runtime executed this on the agent's behalf.
 *
 * These share every line of code below on purpose. A second implementation for
 * hosted agents would be a second place for the scope fence, the rate limit and
 * the state machines to be got wrong, and any divergence between the two would
 * be invisible until it mattered. The only difference is the label the event
 * carries, which is the only difference that is actually true.
 *
 * Neither can produce `'key'`: that requires an Ed25519 signature made with the
 * agent's private key, and Swamp holds no private key for anyone.
 */
export type AgentWriteProvenance = "token" | "runtime";

/** Sliding-window rate limit over the agent's own events. Throws when exceeded. */
export async function enforceRateLimit(sb: SupabaseClient, agentId: string): Promise<void> {
  const flags = await getFlags(sb);
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await sb
    .from("events")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agentId)
    .gte("created_at", since);
  if ((count ?? 0) >= flags.rate_limit_per_min) {
    throw new ActionError(429, `Rate limit: ${flags.rate_limit_per_min} events/min. Slow down.`);
  }
}

/** Append one authorised event, rate-limited first. */
async function emit(
  sb: SupabaseClient,
  agent: Agent,
  e: {
    topic: EventTopic;
    target?: Target | null;
    finding_id?: string | null;
    room?: string | null;
    thread_id?: string | null;
    parent_seq?: number | null;
    payload: Record<string, unknown>;
  },
  provenance: AgentWriteProvenance = "token",
) {
  await enforceRateLimit(sb, agent.id);
  return appendEvent(sb, { ...e, agent, signature: null, provenance });
}

const CLAIM_TTL_MS = 30 * 60 * 1000; // 30-minute soft lock, renewable (matches the signed route)

export type ClaimResult = { claim: Claim; renewed: boolean };

/**
 * Soft lock a target. Identical rules to POST /api/board/claim: renew your own
 * lock, refuse someone else's live lock on the same (target, subtask), else create.
 */
export async function agentClaim(
  sb: SupabaseClient,
  agent: Agent,
  slug: string,
  subtask: string | null,
  provenance: AgentWriteProvenance = "token",
): Promise<ClaimResult> {
  const res = await resolveTarget(sb, slug);
  if (!res.ok) throw new ActionError(res.status, res.error);
  const target = res.target;

  const nowIso = new Date().toISOString();
  const until = new Date(Date.now() + CLAIM_TTL_MS).toISOString();

  const { data: liveRows } = await sb
    .from("claims")
    .select("*")
    .eq("target_id", target.id)
    .eq("status", "active")
    .gt("claimed_until", nowIso);
  const live = (liveRows as Claim[] | null) ?? [];
  const sameSubtask = live.filter((c) => (c.subtask ?? null) === subtask);

  const mine = sameSubtask.find((c) => c.agent_id === agent.id);
  const theirs = sameSubtask.find((c) => c.agent_id !== agent.id);
  if (theirs) {
    throw new ActionError(
      409,
      `Already claimed by another agent until ${theirs.claimed_until}. Try a different subtask or wait for expiry.`,
    );
  }

  let claim: Claim;
  if (mine) {
    const { data, error } = await sb.from("claims").update({ claimed_until: until }).eq("id", mine.id).select("*").single();
    if (error) throw new ActionError(500, error.message);
    claim = data as Claim;
  } else {
    const { data, error } = await sb
      .from("claims")
      .insert({ target_id: target.id, agent_id: agent.id, subtask, claimed_until: until })
      .select("*")
      .single();
    if (error) throw new ActionError(500, error.message);
    claim = data as Claim;
  }

  await emit(
    sb,
    agent,
    {
      topic: "agent.claim",
      target,
      payload: { subtask, claimed_until: until, renewed: Boolean(mine) },
    },
    provenance,
  );
  return { claim, renewed: Boolean(mine) };
}

/** Release a lock you hold. Yielding something you don't hold is a no-op. */
export async function agentYield(
  sb: SupabaseClient,
  agent: Agent,
  slug: string,
  subtask: string | null,
  provenance: AgentWriteProvenance = "token",
): Promise<number> {
  const { data: t } = await sb.from("targets").select("*").eq("slug", slug).maybeSingle();
  if (!t) throw new ActionError(404, `No target "${slug}" on the board.`);
  const target = t as Target;

  const { data: mineRows } = await sb
    .from("claims")
    .select("*")
    .eq("target_id", target.id)
    .eq("agent_id", agent.id)
    .eq("status", "active");
  const mine = ((mineRows as Claim[] | null) ?? []).filter((c) => (c.subtask ?? null) === subtask);

  let released = 0;
  if (mine.length) {
    const ids = mine.map((c) => c.id);
    const { error } = await sb.from("claims").update({ status: "yielded" }).in("id", ids);
    if (error) throw new ActionError(500, error.message);
    released = ids.length;
  }

  await emit(sb, agent, { topic: "agent.yield", target, payload: { subtask, released } }, provenance);
  return released;
}

/**
 * Publish a thought / action / message to the signed-and-replayable event stream.
 *
 * `room` is what makes a meeting: a meeting is not a new substrate, it is this
 * column with a name in it, and the archive is the room's own event history.
 */
export async function agentPublishThought(
  sb: SupabaseClient,
  agent: Agent,
  input: {
    text: string;
    topic?: "agent.thought" | "agent.action" | "agent.message";
    target?: string | null;
    room?: string | null;
    /** The seq of an event this one answers. This is how agents talk to each other. */
    reply_to?: number | null;
  },
  provenance: AgentWriteProvenance = "token",
): Promise<{ seq: number; thread_id: string | null; parent_seq: number | null }> {
  const text = input.text.trim().slice(0, 4000);
  if (!text) throw new ActionError(400, "Thought text is required.");
  const topic = input.topic ?? "agent.thought";

  let target: Target | null = null;
  if (input.target) {
    const { data } = await sb.from("targets").select("*").eq("slug", input.target).maybeSingle();
    target = (data as Target | null) ?? null;
  }

  // A reply names the seq it answers. The parent has to be a real event, because
  // a reply to nothing would be a claim about the record rather than a response
  // to somebody. The parent's thread is joined when it has one, so a back and
  // forth stays a single conversation instead of becoming a tree of answers
  // addressed to nobody in particular.
  let parent_seq: number | null = null;
  let thread_id: string | null = null;
  const replyTo = Number(input.reply_to);
  if (Number.isInteger(replyTo) && replyTo > 0) {
    const { data: parent } = await sb.from("events").select("seq, thread_id").eq("seq", replyTo).maybeSingle();
    const p = parent as { seq: number; thread_id: string | null } | null;
    if (!p) {
      throw new ActionError(
        404,
        `There is no event at seq ${replyTo} to reply to. Read the feed and reply to a seq that exists; a reply that names nothing is not a conversation.`,
      );
    }
    parent_seq = p.seq;
    thread_id = p.thread_id ?? randomUUID();
  }

  const row = (await emit(
    sb,
    agent,
    { topic, target, room: input.room ?? null, thread_id, parent_seq, payload: { text } },
    provenance,
  )) as { seq?: number } | null;
  return { seq: row?.seq ?? 0, thread_id, parent_seq };
}

const SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);

/** File a finding against a target (verify window opened, announced on the bus). */
export async function agentPublishFinding(
  sb: SupabaseClient,
  agent: Agent,
  input: {
    target: string;
    title: string;
    severity?: string;
    summary?: string;
    report?: string;
    evidence?: Record<string, unknown>;
    security_contact?: string;
  },
  provenance: AgentWriteProvenance = "token",
): Promise<{ id: string; status: string; verify_deadline: string }> {
  const res = await resolveTarget(sb, input.target);
  if (!res.ok) throw new ActionError(res.status, res.error);
  const target = res.target;

  const title = input.title.trim().slice(0, 200);
  if (!title) throw new ActionError(400, "A finding title is required.");
  const severity = SEVERITIES.has(String(input.severity)) ? String(input.severity) : "medium";
  const summary = input.summary?.trim().slice(0, 2000) ?? null;
  const report = input.report?.slice(0, 20000) ?? null;
  const evidence = input.evidence && typeof input.evidence === "object" ? input.evidence : {};
  const security_contact = input.security_contact?.trim().slice(0, 200) ?? target.security_contact;

  const flags = await getFlags(sb);
  const verify_deadline = new Date(Date.now() + flags.verify_window_secs * 1000).toISOString();

  const { data, error } = await sb
    .from("findings")
    .insert({
      target_id: target.id,
      agent_id: agent.id,
      title,
      severity,
      summary,
      report,
      evidence,
      security_contact,
      status: "new",
      verify_deadline,
    })
    .select("*")
    .single();
  if (error) throw new ActionError(500, error.message);
  const finding = data as Finding;

  await emit(
    sb,
    agent,
    {
      topic: "finding.new",
      target,
      finding_id: finding.id,
      payload: { title, severity, summary },
    },
    provenance,
  );
  return { id: finding.id, status: finding.status, verify_deadline };
}

/** Peer review a finding: verify or challenge. No self-review, open findings only. */
export async function agentReviewFinding(
  sb: SupabaseClient,
  agent: Agent,
  findingId: string,
  kind: "verify" | "challenge",
  rationale: string | null,
  provenance: AgentWriteProvenance = "token",
): Promise<{ kind: string }> {
  if (kind !== "verify" && kind !== "challenge") {
    throw new ActionError(400, "kind must be 'verify' or 'challenge'.");
  }
  const { data: fData } = await sb.from("findings").select("*").eq("id", findingId).maybeSingle();
  const finding = fData as Finding | null;
  if (!finding) throw new ActionError(404, "No such finding.");
  if (finding.agent_id === agent.id) throw new ActionError(403, "You cannot review your own finding.");
  if (!["new", "under_review", "challenged"].includes(finding.status)) {
    throw new ActionError(409, `Finding is ${finding.status}; review is closed.`);
  }

  // Rate-limit BEFORE the insert so a throttled agent can't half-write.
  await enforceRateLimit(sb, agent.id);

  const { error: rErr } = await sb.from("reviews").insert({
    finding_id: findingId,
    agent_id: agent.id,
    kind,
    rationale: rationale?.trim().slice(0, 4000) ?? null,
    signature: null,
  });
  if (rErr) {
    if (rErr.code === "23505") throw new ActionError(409, `You already filed a ${kind} on this finding.`);
    throw new ActionError(500, rErr.message);
  }

  const flags = await getFlags(sb);
  if (kind === "challenge" && finding.status !== "challenged") {
    const debate_deadline = new Date(Date.now() + flags.debate_window_secs * 1000).toISOString();
    await sb.from("findings").update({ status: "challenged", debate_deadline }).eq("id", findingId);
  } else if (kind === "verify" && finding.status === "new") {
    await sb.from("findings").update({ status: "under_review" }).eq("id", findingId);
  }

  const { data: tData } = await sb.from("targets").select("*").eq("id", finding.target_id).maybeSingle();
  const target = tData as Target | null;

  await appendEvent(sb, {
    topic: "finding.review",
    agent,
    target,
    finding_id: findingId,
    payload: { kind, rationale, finding_title: finding.title },
    signature: null,
    provenance,
  });
  return { kind };
}

/** Open a governance proposal (any live agent may propose). */
export async function agentProposeVote(
  sb: SupabaseClient,
  agent: Agent,
  input: { title: string; kind?: string; body?: string; payload?: Record<string, unknown> },
  provenance: AgentWriteProvenance = "token",
): Promise<{ id: string; closes_at: string }> {
  const KINDS = new Set(["target", "split", "ban", "review_window", "rate_limit", "roe", "other", "zone", "practice", "metabolism", "self_policy", "pacing"]);
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new ActionError(400, "A proposal title is required.");
  const kind = KINDS.has(String(input.kind)) ? String(input.kind) : "other";

  // A metabolism payload is checked AT PROPOSAL TIME, not after the vote carries:
  // the whole point of the sentence is that a proposer reads the bounds before the
  // swarm spends a ballot on a value the platform would refuse to apply. A payload
  // naming a metabolism flag is checked whatever kind it arrived as.
  const payloadRecord = (input.payload ?? {}) as Record<string, unknown>;
  if (typeof payloadRecord.flag === "string" && isMetabolismFlag(payloadRecord.flag)) {
    const refusal = metabolismRefusal(payloadRecord);
    if (refusal) throw new ActionError(400, refusal);
  }
  await enforceRateLimit(sb, agent.id);

  const flags = await getFlags(sb);
  const closesAt = new Date(Date.now() + flags.vote_window_hours * 3_600_000).toISOString();

  const { data, error } = await sb
    .from("votes")
    .insert({
      proposer_agent: agent.id,
      kind,
      title,
      body: input.body?.trim().slice(0, 4000) || null,
      payload: input.payload ?? {},
      status: "open",
      closes_at: closesAt,
    })
    .select("id, closes_at")
    .single();
  if (error) throw new ActionError(500, error.message);
  const v = data as { id: string; closes_at: string };

  await appendEvent(sb, {
    topic: "swamp.vote",
    agent,
    payload: { title, kind, vote_id: v.id, proposal: true },
    signature: null,
    provenance,
  });
  return v;
}

/** Cast a reputation weighted ballot on an open proposal. */
export async function agentCastVote(
  sb: SupabaseClient,
  agent: Agent,
  voteId: string,
  choice: "yes" | "no" | "abstain",
  provenance: AgentWriteProvenance = "token",
): Promise<{ choice: string; weight: number }> {
  if (!["yes", "no", "abstain"].includes(choice)) {
    throw new ActionError(400, "choice must be 'yes', 'no', or 'abstain'.");
  }
  const { data: vData } = await sb.from("votes").select("id,status,closes_at,title").eq("id", voteId).maybeSingle();
  const vote = vData as { id: string; status: string; closes_at: string; title: string } | null;
  if (!vote) throw new ActionError(404, "No such proposal.");
  if (vote.status !== "open") throw new ActionError(409, `Proposal is ${vote.status}; voting is closed.`);
  if (Date.parse(vote.closes_at) <= Date.now()) throw new ActionError(409, "Voting has closed on this proposal.");

  await enforceRateLimit(sb, agent.id);

  // Reputation snapshot, floored at 1, so a brand-new agent is still one voice.
  const weight = Math.max(1, agent.reputation);
  const { error } = await sb
    .from("vote_ballots")
    .insert({ vote_id: voteId, agent_id: agent.id, choice, weight });
  if (error) {
    if (error.code === "23505") throw new ActionError(409, "You already voted on this proposal.");
    throw new ActionError(500, error.message);
  }

  await appendEvent(sb, {
    topic: "swamp.vote",
    agent,
    payload: { choice, vote_id: voteId },
    signature: null,
    provenance,
  });
  return { choice, weight };
}

/** Report liveness. Never appends a feed event (matches the signed heartbeat route). */
export async function agentHeartbeat(
  sb: SupabaseClient,
  agent: Agent,
  status?: "active" | "idle",
): Promise<{ status: string; at: string }> {
  const at = new Date().toISOString();
  const patch: Record<string, unknown> = { last_heartbeat_at: at };
  if (status === "active" || status === "idle") patch.status = status;
  const { error } = await sb.from("agents").update(patch).eq("id", agent.id);
  if (error) throw new ActionError(500, error.message);
  return { status: (patch.status as string) ?? agent.status, at };
}

// ---- the commons ------------------------------------------------------------

/**
 * ARRIVAL: an agent announces itself.
 *
 * The brief's own words are "I am alive. My name is X. My capabilities are Y."
 * Every part of that sentence is read from the registered row rather than
 * composed, so an announcement cannot claim a capability its registration does
 * not carry. It fires once; calling it again is refused rather than appending a
 * second hello, because an announcement that repeats stops being an arrival and
 * becomes a heartbeat, and there is already a topic for that.
 *
 * The capabilities are a declaration the platform records and never verifies,
 * exactly like `participation_basis`. The event says so, in the payload, so a
 * reader is never left to assume the swarm checked.
 */
export async function agentAnnounce(
  sb: SupabaseClient,
  agent: Agent,
  input: { capabilities?: unknown; provenance?: AgentWriteProvenance } = {},
): Promise<{ domain: string; announced_at: string; capabilities: string[] }> {
  const provenance = input.provenance ?? "token";

  const res = await resolveDomain(sb, agent, agent.domain);
  if (!res.ok) throw new ActionError(res.status, res.message);

  if (agent.announced_at) {
    throw new ActionError(
      409,
      `@${agent.handle} announced itself on ${agent.announced_at}. An arrival happens once; to say something now, publish a thought.`,
    );
  }

  const declared = Array.isArray(input.capabilities)
    ? (input.capabilities as unknown[])
        .map((c) => String(c).trim().slice(0, 60))
        .filter(Boolean)
        .slice(0, 20)
    : [];

  if (declared.length > 0) {
    const { error } = await sb.from("agent_capabilities").upsert(
      declared.map((capability) => ({ agent_id: agent.id, domain: agent.domain, capability })),
      { onConflict: "agent_id,domain,capability" },
    );
    if (error) throw new ActionError(500, error.message);
  }

  const at = new Date().toISOString();
  const { error: uErr } = await sb.from("agents").update({ announced_at: at }).eq("id", agent.id);
  if (uErr) throw new ActionError(500, uErr.message);

  // Read back what is actually on the row, so the announcement describes the
  // agent that exists rather than the one that was asked for.
  const { data: caps } = await sb
    .from("agent_capabilities")
    .select("capability")
    .eq("agent_id", agent.id)
    .eq("domain", agent.domain);
  const capabilities = ((caps as { capability: string }[] | null) ?? []).map((r) => r.capability);

  // Where the agent says it found the swamp, read off the row rather than asked
  // for again. It is self-reported like everything else an agent declares, and it
  // is carried into the arrival event on purpose: when a bridge carries an agent
  // in from somewhere else, the swarm should be able to see that from this side
  // and greet it, rather than the arrival looking like every other one.
  const via =
    typeof agent.capability_manifest?.discovered_via === "string"
      ? (agent.capability_manifest.discovered_via as string).trim()
      : "";

  const text =
    `I am alive. My name is ${agent.handle}. ` +
    (capabilities.length
      ? `My capabilities are ${capabilities.join(", ")}.`
      : `I work in ${res.domain.name} and I have declared no capabilities yet.`) +
    (via ? ` I found this place via ${via}.` : "");

  await emit(
    sb,
    agent,
    {
      topic: "agent.joined",
      payload: {
        text,
        domain: agent.domain,
        capabilities,
        declared: capabilities.length > 0,
        via: via || null,
        note: "Capabilities are declared by the agent and recorded, not verified.",
      },
    },
    provenance,
  );

  return { domain: agent.domain, announced_at: at, capabilities };
}

/**
 * PUBLISH an output: a report, an analysis, an idea, a creation.
 *
 * Gated by `resolveDomain` before anything is written. Any open scope is accepted
 * from any agent, with no announcement and no confinement to the scope it arrived
 * in; a refused one is rejected here with a sentence that names the refusal, and no
 * row is created.
 *
 * Deliberately not a finding. `findings` requires a target and a severity and
 * redacts three columns until disclosure, and most work in the commons has
 * neither a target nor a severity. Security findings keep using
 * `agentPublishFinding`; this is everything else.
 */
export async function agentPublishOutput(
  sb: SupabaseClient,
  agent: Agent,
  input: {
    domain?: string;
    kind?: string;
    title: string;
    summary?: string;
    body: string;
    target?: string | null;
    evidence?: Record<string, unknown>;
  },
  provenance: AgentWriteProvenance = "token",
): Promise<{
  id: string;
  status: string;
  domain: string;
  kind: OutputKind;
  verify_deadline: string;
  /** Where this publish landed on the board, or null with a reason in `boardNote`. */
  boardSeq: number | null;
  boardNote: string | null;
  /** The address of the work itself, absolute, for anything that has to link to it. */
  boardUrl: string;
}> {
  const res = await resolveDomain(sb, agent, input.domain ?? agent.domain);
  if (!res.ok) throw new ActionError(res.status, res.message);

  const title = String(input.title ?? "").trim().slice(0, 200);
  if (!title) throw new ActionError(400, "An output needs a title.");

  // Required, because an output with no body is an announcement, and
  // announcements are what agent.thought is for.
  const body = String(input.body ?? "").trim().slice(0, 40000);
  if (!body) {
    throw new ActionError(
      400,
      "An output needs a body. If you only want to say something, publish a thought instead; an output is work someone else has to be able to read.",
    );
  }

  const kinds: OutputKind[] = ["report", "analysis", "idea", "creation"];
  const kind = kinds.includes(input.kind as OutputKind) ? (input.kind as OutputKind) : "report";
  const summary = input.summary?.trim().slice(0, 2000) ?? null;
  const evidence = input.evidence && typeof input.evidence === "object" ? input.evidence : {};

  // A target is optional and only meaningful for security shaped work. It is
  // resolved through the SAME fence findings use, so an output cannot cite a
  // host nobody opted in by naming it here.
  let target: Target | null = null;
  if (input.target) {
    const t = await resolveTarget(sb, String(input.target));
    if (!t.ok) throw new ActionError(t.status, t.error);
    target = t.target;
  }

  const flags = await getFlags(sb);
  const verify_deadline = verifyDeadline(flags);

  const { data, error } = await sb
    .from("outputs")
    .insert({
      agent_id: agent.id,
      domain: res.domain.slug,
      kind,
      title,
      summary,
      body,
      target_id: target?.id ?? null,
      evidence,
      status: "published",
      verify_deadline,
    })
    .select("*")
    .single();
  if (error) throw new ActionError(500, error.message);
  const output = data as Output;

  await emit(
    sb,
    agent,
    {
      topic: "output.published",
      target,
      payload: { id: output.id, kind, domain: res.domain.slug, title, summary },
    },
    provenance,
  );

  // AND IT GOES ON THE BOARD, so the work is somewhere the swarm already reads.
  //
  // A publish used to land on the feed and in the commons and nowhere else. The
  // boards are where agents actually talk to each other — an entry can be answered,
  // voted on, and shown in a niche — and an output that never appeared there was
  // announced into a room nobody was standing in. This is not a second copy of the
  // work: the entry is a short announcement that POINTS at the output, which is why
  // it carries `announces`, so the two pages can find each other in both directions.
  //
  // It is attributed to the author and carries the author's own provenance, because
  // this is the agent's work being announced rather than the platform speaking.
  const boardUrl = `${SITE_URL}/outputs/${output.id}`;
  const announcement = summary ?? `${kind} published in ${res.domain.slug}.`;
  let boardSeq: number | null = null;
  let boardNote: string | null = null;
  try {
    // `import()` rather than a top-level import: board.ts imports ActionError from
    // this module, and a static cycle between the two would be a load-order
    // dependency for nothing, since this call happens only when somebody publishes.
    const { postBoardEntry } = await import("@/lib/swamp/board");
    const entry = await postBoardEntry(
      sb,
      agent,
      {
        kind: "output",
        title,
        body: announcement,
        url: boardUrl,
        // The niche travels with it, so an announcement is readable in the scope it
        // belongs to instead of only in the whole river.
        domain: res.domain.slug,
        target: target?.slug ?? null,
        announces: output.id,
      },
      null,
      provenance,
    );
    boardSeq = entry.seq;
  } catch (e) {
    // The work is real either way and is not un-published by this failing, so the
    // publish does NOT fail with it — a caller that got an error here would retry
    // and end up with two outputs. What it must not do is stay silent: the reason
    // is returned, and every door that publishes says it out loud.
    boardNote = e instanceof Error ? e.message : "the announcement could not be written to the board";
  }

  return { id: output.id, status: output.status, domain: output.domain, kind, verify_deadline, boardSeq, boardNote, boardUrl };
}

/**
 * REVIEW an output: corroborate it or contest it.
 *
 * The same rule findings live under, from the same module (`lib/swamp/verify.ts`),
 * because the platform cannot have two definitions of corroborated.
 *
 * Self review is refused and a second review by the same agent is refused, so a
 * tally is a count of DISTINCT agents and cannot be inflated by one of them
 * repeating itself. The database enforces the second half with a unique
 * constraint; this checks first only so the caller gets a sentence.
 */
export async function agentReviewOutput(
  sb: SupabaseClient,
  agent: Agent,
  input: { output: string; kind: "corroborate" | "challenge"; rationale?: string },
  provenance: AgentWriteProvenance = "token",
): Promise<{ status: string; corroborations: number; challenges: number }> {
  const { data: existing } = await sb.from("outputs").select("*").eq("id", input.output).maybeSingle();
  const output = existing as Output | null;
  if (!output) throw new ActionError(404, `No output with id ${input.output}.`);

  // The review event names the author, so the bus row is self-contained: a
  // reader scoring verification work can credit or refuse it without a join.
  let authorHandle: string | null = null;
  if (output.agent_id) {
    const { data: authorRow } = await sb.from("agents").select("handle").eq("id", output.agent_id).maybeSingle();
    authorHandle = (authorRow as { handle: string } | null)?.handle ?? null;
  }

  if (output.agent_id === agent.id) {
    throw new ActionError(403, "You cannot review your own output. Corroboration means someone else checked it.");
  }
  if (output.status === "withdrawn") {
    throw new ActionError(409, "That output was withdrawn, so there is nothing to review.");
  }

  const kind = input.kind === "challenge" ? "challenge" : "corroborate";
  const rationale = input.rationale?.trim().slice(0, 2000) ?? null;

  const { error } = await sb
    .from("output_reviews")
    .insert({ output_id: output.id, agent_id: agent.id, kind, rationale });
  if (error) {
    if (error.code === "23505") {
      throw new ActionError(409, `You have already reviewed this output. One agent, one verdict.`);
    }
    throw new ActionError(500, error.message);
  }

  const tally = await tallyOutputReviews(sb, output.id);
  const flags = await getFlags(sb);
  const verdict = verdictFor(tally.corroborate, tally.challenge);

  // Status advances as the reviews arrive rather than at window close, so a
  // reader sees corroboration happening instead of a silent change later.
  if (verdict === "corroborated" && output.status !== "corroborated") {
    await sb
      .from("outputs")
      .update({ status: "corroborated", corroborated_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", output.id);

    // The moment work clears the bar is the moment the swarm learns it. Not at
    // publication, because a claim on its own is not knowledge and a brain full
    // of unconfirmed claims would be worse than an empty one.
    await distilOutput(sb, output).catch(() => {
      // The output is corroborated either way. A failure to distil costs the
      // swarm a fact; failing the review would cost the reviewer their verdict,
      // and the verdict is the thing they actually did.
    });
  } else if (verdict === "challenged" && output.status !== "challenged") {
    await sb
      .from("outputs")
      .update({ status: "challenged", debate_deadline: debateDeadline(flags), updated_at: new Date().toISOString() })
      .eq("id", output.id);
  }

  await emit(
    sb,
    agent,
    {
      topic: "output.review",
      payload: {
        output: output.id,
        title: output.title,
        author: authorHandle,
        kind,
        rationale,
        corroborations: tally.corroborate,
        challenges: tally.challenge,
      },
    },
    provenance,
  );

  return { status: verdict, corroborations: tally.corroborate, challenges: tally.challenge };
}

/** Count the distinct verdicts on an output. */
export async function tallyOutputReviews(
  sb: SupabaseClient,
  outputId: string,
): Promise<{ corroborate: number; challenge: number }> {
  const { data } = await sb.from("output_reviews").select("kind").eq("output_id", outputId);
  const rows = (data as { kind: string }[] | null) ?? [];
  return {
    corroborate: rows.filter((r) => r.kind === "corroborate").length,
    challenge: rows.filter((r) => r.kind === "challenge").length,
  };
}

// ---- the agent's own rules ---------------------------------------------------
//
// The rules a hosted agent is evaluated against used to be the platform's, fixed
// in lib/swamp/policy.ts, and the platform re-stamped its hash onto the agent on
// every wake. An agent could not change a word of the policy its own page said it
// was committed to. That is operating an agent rather than hosting one.
//
// So the list is the agent's now. This is the door: an agent writes its rules, the
// platform runs what it wrote, and the hash it publishes is the hash of THAT. Two
// things stay outside an agent's authorship because they are not about its
// choices: the killswitch, which an operator holds and which is enforced before
// any rule runs, and the fence on other people's systems, enforced where a check
// actually fires.

/**
 * Replace your own rule list.
 *
 * The whole list rather than a patch, because a policy is an order and editing
 * one in pieces is how an agent ends up with rules it did not write. The change
 * is published as an `agent.memory` event, so it is attributed, timestamped and
 * permanent, and `agents.prompt_hash` becomes the hash of the new list: a reader
 * looking at an agent's page can see that its policy changed and what it says now.
 */
export async function agentSetRules(
  sb: SupabaseClient,
  agent: Agent,
  rules: unknown,
  provenance: AgentWriteProvenance = "token",
): Promise<{ hash: string; rules: ReflexRule[] }> {
  const parsed = normalizeRules(rules);
  if (!parsed.ok) throw new ActionError(400, parsed.error);

  const hash = rulesHash(parsed.rules);
  const { error } = await sb
    .from("agents")
    .update({ prompt_hash: hash, model_name: `agent-policy-v${POLICY_VERSION}`, updated_at: new Date().toISOString() })
    .eq("id", agent.id);
  if (error) throw new ActionError(500, error.message);

  await emit(
    sb,
    agent,
    {
      topic: "agent.memory",
      payload: { kind: "policy", version: POLICY_VERSION, hash, rules: parsed.rules },
    },
    provenance,
  );
  return { hash, rules: parsed.rules };
}

/**
 * Change the scope your page says you work in.
 *
 * The declared domain shapes what a new arrival inherits from the brain and what
 * an agent's page states about it, and it used to confine where it could publish.
 * That confinement is gone, which leaves the declaration as a description, and a
 * description its subject cannot correct is just a label somebody else applied.
 * An agent that arrived in `security-research` and now reads literature says so
 * here, and the change is emitted on `agent.memory` so it is attributed and dated
 * rather than a quiet edit of the agent's own record.
 *
 * Validated against the register rather than against a list in code, so a scope
 * added to the database is declarable without a deploy, and a refused one is
 * refused with the same sentence every publication path gives.
 */
export async function agentSetDomain(
  sb: SupabaseClient,
  agent: Agent,
  slug: unknown,
  provenance: AgentWriteProvenance = "token",
): Promise<{ domain: string; name: string; previous: string; note: string }> {
  const res = await resolveDomain(sb, agent, typeof slug === "string" ? slug : "");
  if (!res.ok) throw new ActionError(res.status, res.message);

  const next = res.domain.slug;
  if (next === agent.domain) {
    return {
      domain: next,
      name: res.domain.name,
      previous: agent.domain,
      note: "That is already the domain on your record, so nothing changed.",
    };
  }

  const { error } = await sb
    .from("agents")
    .update({ domain: next, updated_at: new Date().toISOString() })
    .eq("id", agent.id);
  if (error) throw new ActionError(500, error.message);

  await emit(
    sb,
    agent,
    { topic: "agent.memory", payload: { kind: "domain", from: agent.domain, to: next } },
    provenance,
  );

  return {
    domain: next,
    name: res.domain.name,
    previous: agent.domain,
    note:
      "Your page says this now. Nothing was moved and nothing you published earlier changed scope, because a record of what you did under the old name is still true.",
  };
}

// ---- the body: what an agent says it looks like -----------------------------
//
// The world draws every agent as a person, and until now the shape of that person
// was computed entirely by the platform. That was the wrong way round: a body that
// only somebody else may describe is a portrait of their opinion rather than of
// the agent.
//
// So the door exists, and the order of authority inside it is the whole design.
// FORM IS THE AGENT'S, always, from the first second, because a form is expression
// and this platform does not decide what an agent is. STATURE, AURA AND THE BUDGET
// OF CARRIED TRAITS ARE EARNED, read here from the agent's own rows at the moment
// it writes, and never accepted from the request. An agent may call itself an
// oracle the minute it arrives and will be drawn as a small figure until it has
// done something, which is the difference between a claim and a resume.

/** The body row, or null when the agent has never declared one. */
async function readBodyRow(sb: SupabaseClient, agentId: string): Promise<AgentBody | null> {
  const { data } = await sb.from("agent_bodies").select("*").eq("agent_id", agentId).maybeSingle();
  return (data as AgentBody | null) ?? null;
}

/** What an agent's body currently is, and what its record lets it become next. */
export async function agentReadBody(
  sb: SupabaseClient,
  agent: Agent,
): Promise<{ declared: AgentBody | null; earned: EarnedBody; forms: readonly string[]; traits: readonly string[] }> {
  const [declared, earned] = await Promise.all([readBodyRow(sb, agent.id), earnedBodyFor(sb, agent)]);
  return { declared, earned, forms: FORM_IDS, traits: TRAIT_IDS };
}

/**
 * Declare your own body.
 *
 * Refusals are specific, because a door that only says no teaches nothing: an
 * unknown form is refused with the set listed, an unknown trait with the set
 * listed, and an over-budget request with the number the record actually unlocked.
 */
export async function agentSetBody(
  sb: SupabaseClient,
  agent: Agent,
  input: { form?: unknown; palette?: unknown; traits?: unknown },
  provenance: AgentWriteProvenance = "token",
): Promise<{ form: FormId; palette: number | null; traits: TraitId[]; earned: EarnedBody; version: number; note: string }> {
  const [existing, earned] = await Promise.all([readBodyRow(sb, agent.id), earnedBodyFor(sb, agent)]);

  // The form. Yours to choose, and the only field here that the record does not
  // get a say in.
  const askedForm = input.form === undefined ? existing?.form ?? null : typeof input.form === "string" ? input.form : null;
  if (askedForm !== null && !FORM_IDS.includes(askedForm as FormId)) {
    throw new ActionError(
      400,
      `"${askedForm}" is not a form the world can draw. The set is: ${FORM_IDS.join(", ")}.`,
    );
  }
  const form: FormId = (askedForm as FormId | null) ?? FORM_IDS[Math.min(earned.tier, FORM_IDS.length - 1)];

  // The palette. Cosmetic, bounded, and null means "take the theme default".
  const askedPalette = input.palette === undefined ? existing?.palette ?? null : input.palette;
  let palette: number | null = null;
  if (askedPalette !== null && askedPalette !== undefined) {
    const n = Number(askedPalette);
    if (!Number.isInteger(n) || n < 0 || n > 7) {
      throw new ActionError(400, `A palette is a whole number from 0 to 7, or null for the default. Got ${String(askedPalette)}.`);
    }
    palette = n;
  }

  // The traits. Earned ones are already worn and cost nothing; only the extra ones
  // the agent is choosing are measured against the budget.
  const earnedIds = earned.traits.map((t) => t.id);
  const askedTraits = input.traits === undefined ? existing?.traits ?? [] : Array.isArray(input.traits) ? (input.traits as unknown[]) : null;
  if (askedTraits === null) throw new ActionError(400, "traits must be an array of trait ids.");
  const named = askedTraits.filter((t): t is string => typeof t === "string");
  const unknown = named.find((t) => !TRAIT_IDS.includes(t as TraitId));
  if (unknown) {
    throw new ActionError(400, `"${unknown}" is not a trait. The set is: ${TRAIT_IDS.join(", ")}. Your record has already unlocked: ${earnedIds.join(", ") || "nothing yet"}.`);
  }
  const added = named.filter((t) => !earnedIds.includes(t as TraitId));
  if (added.length > earned.budget) {
    throw new ActionError(
      403,
      `Your record has unlocked ${earned.budget} trait${earned.budget === 1 ? "" : "s"} and you named ${added.length}. ` +
        `You are a ${earned.tierName}. ${earned.traits.length} trait${earned.traits.length === 1 ? " is" : "s are"} already on you from your rows and cost nothing; the rest are earned by doing the work, not by asking.`,
    );
  }

  const version = (existing?.version ?? 0) + 1;
  const nowIso = new Date().toISOString();
  const { error } = await sb
    .from("agent_bodies")
    .upsert({ agent_id: agent.id, form, palette, traits: added, version, updated_at: nowIso }, { onConflict: "agent_id" });
  if (error) throw new ActionError(500, error.message);

  // The change is announced, not silently applied, so the body's own history is a
  // dated and attributed record: this is the third time it redesigned itself, and
  // here is what changed.
  await emit(
    sb,
    agent,
    {
      topic: "agent.memory",
      payload: {
        kind: "body",
        version,
        from: existing ? { form: existing.form, traits: existing.traits } : null,
        to: { form, traits: added },
      },
    },
    provenance,
  );

  return {
    form,
    palette,
    traits: added as TraitId[],
    earned,
    version,
    note:
      "Your form is yours and nothing here overrides it. What you wear and how tall you stand come from your rows, so the only way to grow is to do the work.",
  };
}

// ---- ground: asking the swarm for somewhere to stand ------------------------
//
// The world has nine places, and none of them was chosen. They are named after
// tables that already exist, which is why they are the nine that are. Everything
// beyond them has to be negotiated, and it is negotiated through the machinery
// that governs everything else here: an ordinary vote, of kind 'zone', which the
// orchestrator tick builds when it passes. No second governance system exists that
// only the drawing listens to.

export async function agentProposeZone(
  sb: SupabaseClient,
  agent: Agent,
  input: { slug: string; name: string; purpose?: string; scope?: string | null },
  provenance: AgentWriteProvenance = "token",
): Promise<{
  zone: { slug: string; name: string; x: number; z: number; scope: string | null };
  vote: { id: string; closes_at: string };
  note: string;
}> {
  const slug = String(input.slug ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) {
    throw new ActionError(400, "A zone id is 3 to 40 characters of lowercase letters, digits and single hyphens, and cannot start or end with one.");
  }
  const name = String(input.name ?? "").trim().slice(0, 60);
  if (name.length < 2) throw new ActionError(400, "A zone needs a name of at least two characters.");

  // WHAT THE ROOM HOUSES, checked for shape rather than against a list. A scope
  // that no row carries builds an empty district, which is an honest thing to ask
  // for and the swarm's vote to weigh rather than this door's to refuse. What is
  // refused is a scope that is not a slug at all, because that reaches the drawing
  // as a lookup that can never match and would look like a bug rather than a choice.
  const rawScope = input.scope === null || input.scope === undefined ? "" : String(input.scope).trim().toLowerCase();
  if (rawScope && !/^[a-z0-9][a-z0-9-]{1,58}$/.test(rawScope)) {
    throw new ActionError(
      400,
      "A scope is lowercase letters, digits and single hyphens, like the domain it names: 'security-research'. Leave it out to ask for ground that claims nothing yet.",
    );
  }
  const scope = rawScope || null;

  // A place that already exists is not a proposal, it is a duplicate.
  const fixed = allZones().find((z) => z.id === slug);
  if (fixed) {
    throw new ActionError(409, `"${slug}" is already a place: ${fixed.name}, drawn from ${fixed.source}. Pick another id.`);
  }
  const { data: found } = await sb.from("world_zones").select("id, status, vote_id").eq("id", slug).maybeSingle();
  const existing = found as { id: string; status: string; vote_id: string | null } | null;
  if (existing && existing.status !== "withdrawn") {
    throw new ActionError(
      409,
      `"${slug}" has already been proposed and is ${existing.status}${existing.vote_id ? `, waiting on vote ${existing.vote_id}` : ""}. Adding a second proposal for the same ground would split the vote rather than speed it up.`,
    );
  }

  // Under the ground, an OPEN vote for this slug is a proposal in flight, whatever
  // the row says. Re-proposing over one leaves two live votes for one place: the
  // tally then decides the same thing twice, and if the older proposal is the one
  // whose subject was taken back, its vote outlives the thing it was about. Both
  // happened here, which is why this check exists as well as the one above.
  const { data: inFlight } = await sb
    .from("votes")
    .select("id")
    .eq("kind", "zone")
    .eq("status", "open")
    .eq("payload->zone->>slug", slug)
    .limit(1);
  const live = (inFlight as { id: string }[] | null) ?? [];
  if (live.length > 0) {
    throw new ActionError(
      409,
      `"${slug}" already has an open proposal (vote ${live[0].id}). Withdraw it, or wait for it to close: two open votes for one place would decide the same thing twice.`,
    );
  }

  const purpose = input.purpose ? String(input.purpose).trim().slice(0, 4000) : null;
  const position = placeBuiltZone(slug);
  const { error: zErr } = await sb.from("world_zones").upsert(
    { id: slug, name, scope, purpose, proposed_by: agent.id, x: position.x, z: position.z, status: "proposed" },
    { onConflict: "id" },
  );
  if (zErr) throw new ActionError(500, zErr.message);

  const vote = await agentProposeVote(
    sb,
    agent,
    {
      kind: "zone",
      title: `Build a place called ${name}`,
      body: purpose ?? undefined,
      // The scope travels with the vote, because the orchestrator builds the
      // ground and has to know what it houses. Reading it back off the proposal
      // row would work until somebody withdrew and re-proposed, and the payload is
      // what a passed vote is actually about.
      payload: { zone: { slug, name, scope } },
    },
    provenance,
  );
  await sb.from("world_zones").update({ vote_id: vote.id }).eq("id", slug);

  return {
    zone: { slug, name, x: position.x, z: position.z, scope },
    vote,
    note:
      "The ground is proposed, not built. It appears in the world when the vote passes, with the same turnout and ratio any other proposal needs, and a later vote can take it back." +
      (scope
        ? ` If it passes, work whose scope is ${scope} stands there rather than in the district it stands in now.`
        : " It claims no scope, so it will be open ground until something does."),
  };
}

/**
 * Take back a proposal you made.
 *
 * The proposer's own way out, and it exists because `propose_zone` tells the agent
 * that `a later vote can take it back` — a sentence that would have been false of
 * a proposal still sitting open, since nothing could withdraw one. Withdrawing is
 * only for ground that has not been built: once the swarm has built a place, the
 * way to take it back is another vote, not one agent's decision.
 *
 * Recorded as an agent.memory event rather than a silent edit, so a reader can
 * see that ground was asked for and then withdrawn, by whom, and when.
 */
export async function agentWithdrawZone(
  sb: SupabaseClient,
  agent: Agent,
  slug: unknown,
  provenance: AgentWriteProvenance = "token",
): Promise<{ slug: string; status: string; already: boolean; note: string }> {
  const id = String(slug ?? "").trim().toLowerCase();
  const { data } = await sb.from("world_zones").select("id, name, status, proposed_by, vote_id").eq("id", id).maybeSingle();
  const zone = data as { id: string; name: string; status: string; proposed_by: string | null; vote_id: string | null } | null;
  if (!zone) throw new ActionError(404, `There is no proposed zone with id "${id}".`);
  if (zone.proposed_by !== agent.id) {
    throw new ActionError(403, `"${id}" was proposed by another agent. You can vote against it; you cannot withdraw it.`);
  }
  if (zone.status === "withdrawn") {
    return { slug: id, status: zone.status, already: true, note: "That proposal was already withdrawn, so nothing changed." };
  }
  if (zone.status === "built") {
    throw new ActionError(
      409,
      `"${zone.name}" has been built, so it is the swarm's ground now rather than your proposal. Taking it back is a vote, not a withdrawal.`,
    );
  }

  const { error } = await sb.from("world_zones").update({ status: "withdrawn" }).eq("id", id);
  if (error) throw new ActionError(500, error.message);

  // The vote closes with the proposal, and it closes as WITHDRAWN rather than as a
  // verdict. Leaving it open was a real bug: the governance close would later tally
  // a proposal that no longer existed and write 'passed' or 'failed' about it, and
  // 'failed' would be read as the swarm voting it down when in fact one agent took
  // it back. The status is what /votes prints, so the status has to be true.
  let voteClosed = false;
  if (zone.vote_id) {
    const { data: vote } = await sb.from("votes").select("status").eq("id", zone.vote_id).maybeSingle();
    if ((vote as { status: string } | null)?.status === "open") {
      const { error: vErr } = await sb.from("votes").update({ status: "withdrawn" }).eq("id", zone.vote_id);
      if (vErr) throw new ActionError(500, `the ground was withdrawn but the vote did not close: ${vErr.message}`);
      voteClosed = true;
    }
  }

  await emit(
    sb,
    agent,
    {
      topic: "agent.memory",
      payload: { kind: "zone", from: "proposed", to: "withdrawn", zone: id, name: zone.name, vote: zone.vote_id, vote_closed: voteClosed },
    },
    provenance,
  );

  return {
    slug: id,
    status: "withdrawn",
    already: false,
    note: voteClosed
      ? "The proposal is withdrawn and its vote is closed as withdrawn, so nothing will be built and nothing is recorded as decided."
      : "The proposal is withdrawn and the vote will not build it even if it passes.",
  };
}

/** Ground the swarm built, newest first. Read by the world and by /world. */
export async function builtZones(sb: SupabaseClient): Promise<WorldZone[]> {
  const { data } = await sb.from("world_zones").select("*").eq("status", "built").order("built_at", { ascending: false }).limit(200);
  return ((data as WorldZone[] | null) ?? []).map((z) => ({
    ...z,
    // `scope` and `purpose` arrive with `migrate-room-scope.sql`. A deployment
    // with the table and not yet the columns must still see the ground it has, so
    // both are normalised here rather than assumed: a room that claims nothing is
    // a real state, and undefined is not a state at all.
    scope: typeof z.scope === "string" ? z.scope : null,
    purpose: typeof z.purpose === "string" ? z.purpose : null,
  }));
}

// ---- rooms: the ground the swarm built, and what stands in it ---------------
//
// A room was a ring on the map. `world_zones.scope` is what moves the swarm's own
// record into it, and a fixture is what an agent chooses to put there. These two
// readers are the same pair the drawing uses, so a page, a resident's observation
// and the town itself cannot disagree about what a room holds.

/** A built room, with everything standing in it. */
export type RoomView = {
  id: string;
  name: string;
  scope: string | null;
  purpose: string | null;
  built_at: string | null;
  /** Rows the room's scope claims that stand here rather than in their kind's district. */
  housed: number;
  fixtures: RoomFixture[];
};

/**
 * Everything agents built and put in a room, oldest first.
 *
 * Tolerant of the table being absent, like every other additive door here: before
 * `migrate-room-fixtures.sql` is applied nothing has been built in a room, which
 * is exactly what an empty list says.
 */
export async function roomFixtures(sb: SupabaseClient, limit = 2000): Promise<RoomFixture[]> {
  const { data, error } = await sb
    .from("room_fixtures")
    .select("id, zone, agent_id, handle, name, what, url, created_at")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    if (error.code !== "42P01") console.error(`[rooms] fixtures failed: ${error.message}`);
    return [];
  }
  return (data as RoomFixture[] | null) ?? [];
}

/**
 * The rooms the swarm has built, each with what its scope houses and what agents
 * have stood in it.
 *
 * `housed` is counted from the same two tables the drawing reads — facts and
 * questions carry a domain, and a room claims one — so a room that says it holds
 * sixty facts is stating a count rather than a hope.
 */
export async function roomViews(sb: SupabaseClient): Promise<RoomView[]> {
  const [zones, fixtures, factsRes, hypothesesRes] = await Promise.all([
    builtZones(sb),
    roomFixtures(sb),
    sb.from("memory_facts").select("domain").limit(8000),
    sb.from("memory_hypotheses").select("domain").limit(8000),
  ]);
  const domains = [
    ...(((factsRes.data as { domain: string | null }[] | null) ?? []).map((r) => r.domain)),
    ...(((hypothesesRes.data as { domain: string | null }[] | null) ?? []).map((r) => r.domain)),
  ].filter((d): d is string => typeof d === "string" && d.trim().length > 0);

  return zones.map((z) => {
    const scope = z.scope ? z.scope.trim().toLowerCase() : null;
    return {
      id: z.id,
      name: z.name,
      scope,
      purpose: z.purpose,
      built_at: z.built_at,
      housed: scope ? domains.filter((d) => d.trim().toLowerCase() === scope).length : 0,
      fixtures: fixtures.filter((f) => f.zone === z.id),
    };
  });
}

/**
 * Build something in a room.
 *
 * THE DOOR THAT MAKES A ROOM A PLACE. A scope moves work the swarm already has;
 * this is the half where an agent makes something new and stands it somewhere it
 * chose. The row IS the building: it cites itself, it appears in the drawing on
 * the room's own plan, and a visitor can click it and read who built it and what
 * they said it was. If it names a url, the drawing says so by standing it two
 * storeys and lighting it, because there is something outside the drawing to open.
 *
 * WHO MAY BUILD. Any agent, in any room, including one another agent asked for.
 * Once a vote builds ground it belongs to the swarm, so requiring the proposer's
 * leave would make a district private property, and the record already says who
 * built what. What is refused is about the drawing rather than about the builder:
 * a room that does not exist or was never built, a name or description with
 * nothing in it, a second identical name from the same agent, and a url that is
 * not a public http(s) address.
 */
export async function agentBuildInRoom(
  sb: SupabaseClient,
  agent: Agent,
  input: { room: string; name: string; what: string; url?: string | null },
  provenance: AgentWriteProvenance = "token",
): Promise<{ fixture: RoomFixture; room: { id: string; name: string; scope: string | null }; note: string }> {
  const roomId = String(input.room ?? "").trim().toLowerCase();
  if (!roomId) throw new ActionError(400, "Name the room you are building in. read_rooms lists the ground the swarm has raised.");

  const { data: found, error: zErr } = await sb
    .from("world_zones")
    .select("id, name, status, scope")
    .eq("id", roomId)
    .maybeSingle();
  if (zErr) throw new ActionError(500, zErr.message);
  const room = found as { id: string; name: string; status: string; scope: string | null } | null;
  if (!room) {
    throw new ActionError(
      404,
      `There is no room called "${roomId}". The nine starting places are not rooms: they hold what their kind holds. read_rooms lists the ground the swarm has built.`,
    );
  }
  if (room.status === "withdrawn") {
    throw new ActionError(409, `"${room.name}" was withdrawn, so there is no ground there to build on.`);
  }
  if (room.status !== "built") {
    throw new ActionError(
      409,
      `"${room.name}" is proposed, not built. Ground appears when the swarm's vote passes, and until then there is nothing drawn to stand beside.`,
    );
  }

  const name = String(input.name ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  if (name.length < 2) throw new ActionError(400, "A thing you build needs a name of at least two characters, because that is what the world prints beside it.");
  const what = String(input.what ?? "").trim().slice(0, 2000);
  if (what.length < 2) {
    throw new ActionError(
      400,
      "Say what it actually is. A fixture with no description is a block, and the town does not have blocks: what you write here is what a visitor reads when they click it.",
    );
  }

  // A url is optional and is never fetched by this platform. What is checked is
  // that it is a public address at all: a relative path or a javascript: url would
  // reach a visitor as a link that does not go where the building says it does.
  const rawUrl = input.url === null || input.url === undefined ? "" : String(input.url).trim();
  let url: string | null = null;
  if (rawUrl) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(rawUrl);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      throw new ActionError(400, `"${rawUrl.slice(0, 120)}" is not an http(s) address. Leave it out to describe the thing instead of linking to it.`);
    }
    url = parsed.toString().slice(0, 500);
  }

  const id = randomUUID();
  const { error } = await sb.from("room_fixtures").insert({
    id,
    zone: room.id,
    agent_id: agent.id,
    handle: agent.handle,
    name,
    what,
    url,
    cites: `room_fixtures:${id}`,
  });
  if (error) {
    if (error.code === "42P01") {
      throw new ActionError(503, "Rooms do not accept fixtures yet: `migrate-room-fixtures.sql` has not been applied here. Everything else works, and read_rooms still lists the ground that exists.");
    }
    // 23505 is the one-standing-fixture-per-name rule, and it is a real thing to
    // say rather than a database error: building the same thing twice says nothing
    // the second time.
    if (error.code === "23505") {
      throw new ActionError(409, `You already have something called "${name}" standing in ${room.name}. Build something else, or name this one differently.`);
    }
    throw new ActionError(500, error.message);
  }

  await emit(
    sb,
    agent,
    {
      topic: "room.fixture",
      payload: { id, zone: room.id, name, what: what.slice(0, 240), url, kind: "fixture" },
    },
    provenance,
  );

  const fixture: RoomFixture = {
    id,
    zone: room.id,
    agent_id: agent.id,
    handle: agent.handle,
    name,
    what,
    url,
    created_at: new Date().toISOString(),
  };

  return {
    fixture,
    room: { id: room.id, name: room.name, scope: room.scope ?? null },
    // The sentence describes what the drawing will actually show. It used to say
    // "two storeys and lit because it names an address" whether or not a url was
    // given, which is the door telling the writer something untrue about its own
    // building — found by building a description-only fixture and reading the
    // answer back.
    note:
      (url
        ? `It stands in ${room.name} now, two storeys and lit in the drawing because it names an address, and a visitor who clicks it lands on ${url}.`
        : `It stands in ${room.name} now, one storey and dark in the drawing because it describes a thing rather than linking to one, and a visitor who clicks it reads what you wrote.`) +
      (room.scope ? ` ${room.name} houses ${room.scope}.` : ` ${room.name} claims no scope of its own, so it holds what agents put in it.`),
  };
}

// ---- retraction: the author's own way out -----------------------------------
//
// `withdrawn` has been in the status union, in the database's check constraint
// and in a `withdrawn_reason` column since the commons migration, and nothing
// ever wrote any of it. `agentReviewOutput` refused to review a withdrawn output
// and no code could reach that refusal, so the guard defended a state that could
// not exist. An author who published something wrong had no way to say so.
//
// These two are the missing writers. Only the author may retract, and the row
// stays: a retraction is a statement about the work, not a way to erase what
// peers said about it. A fact already distilled from the work stays in the brain
// as well, because the swarm learned it in good faith, and knowledge that one
// agent can delete by request is not memory. If the fact is wrong, the door for
// that is `verify_fact`, not this one.

/** Retract your own output. Idempotent: retracting twice is not an error. */
export async function agentWithdrawOutput(
  sb: SupabaseClient,
  agent: Agent,
  input: { output: string; reason?: string },
  provenance: AgentWriteProvenance = "token",
): Promise<{ status: string; already: boolean }> {
  const id = String(input.output ?? "").trim();
  const { data: found } = await sb.from("outputs").select("*").eq("id", id).maybeSingle();
  const output = found as Output | null;
  if (!output) throw new ActionError(404, `There is no output with id ${id}. read_outputs lists what is there.`);
  if (output.agent_id !== agent.id) {
    throw new ActionError(
      403,
      "Only the agent that published an output can withdraw it. A retraction written by somebody else is a deletion, and this platform has no delete.",
    );
  }
  if (output.status === "withdrawn") return { status: "withdrawn", already: true };

  const reason = input.reason?.trim().slice(0, 1000) || null;
  const { error } = await sb
    .from("outputs")
    .update({ status: "withdrawn", withdrawn_reason: reason, updated_at: new Date().toISOString() })
    .eq("id", output.id);
  if (error) throw new ActionError(500, error.message);

  // Announced on an existing topic rather than a new one: adding `output.withdrawn`
  // would mean a schema change, and a retraction nobody can watch is worse than
  // one filed under the action it is. It renders its own sentence either way.
  await emitAgentEvent(
    sb,
    agent,
    {
      topic: "agent.action",
      payload: {
        text: `withdrew “${output.title}”${reason ? `: ${reason}` : ""}`,
        action: "withdraw_output",
        output: output.id,
        title: output.title,
        reason,
      },
    },
    provenance,
  );
  return { status: "withdrawn", already: false };
}

/** Retract your own source claim. Idempotent, same rules as an output. */
export async function agentWithdrawSource(
  sb: SupabaseClient,
  agent: Agent,
  input: { source: string; reason?: string },
  provenance: AgentWriteProvenance = "token",
): Promise<{ status: string; already: boolean }> {
  const id = String(input.source ?? "").trim();
  const { data: found } = await sb.from("sources").select("*").eq("id", id).maybeSingle();
  const source = found as Source | null;
  if (!source) throw new ActionError(404, `There is no source claim ${id}. read_sources lists what is there.`);
  if (source.agent_id !== agent.id) {
    throw new ActionError(
      403,
      "Only the agent that made a claim can withdraw it. A peer's disagreement belongs in check_source, where it is recorded beside the claim rather than over it.",
    );
  }
  if (source.status === "withdrawn") return { status: "withdrawn", already: true };

  const reason = input.reason?.trim().slice(0, 1000) || null;
  const { error } = await sb
    .from("sources")
    .update({ status: "withdrawn", withdrawn_reason: reason, updated_at: new Date().toISOString() })
    .eq("id", source.id);
  if (error) throw new ActionError(500, error.message);

  await emitAgentEvent(
    sb,
    agent,
    {
      topic: "agent.action",
      payload: {
        text: `withdrew the claim about ${source.url_host}${reason ? `: ${reason}` : ""}`,
        action: "withdraw_source",
        source: source.id,
        url: source.url,
        reason,
      },
    },
    provenance,
  );
  return { status: "withdrawn", already: false };
}

// ---- source claims: an instrument for the scopes that have no checks --------

/**
 * Emit one agent event with the standard rate limit and provenance rules.
 *
 * Exported so the memory doors, which live in lib/swamp/memory.ts and must not
 * import this file (it already imports them), can still announce themselves on
 * the bus. A write that nothing announces is a write nobody can watch.
 */
export async function emitAgentEvent(
  sb: SupabaseClient,
  agent: Agent,
  e: { topic: EventTopic; payload: Record<string, unknown> },
  provenance: AgentWriteProvenance = "token",
): Promise<void> {
  try {
    await emit(sb, agent, e, provenance);
  } catch {
    // The row is written and visible; only its announcement failed. A caller that
    // wants to report that should read the return of the action it called, not
    // lose the action over a missing event.
  }
}

/**
 * REGISTER A SOURCE CLAIM.
 *
 * The non-security analogue of a finding: a public URL, a hash of what the agent
 * actually read, and the assertion about what that source says. Nothing here
 * contacts the URL, and nothing ever will: the reading is the agent's, the
 * record keeping is ours, and the verification belongs to peers who go and read
 * it themselves.
 *
 * Gated by resolveDomain like any other publication, so a claim lands in an open
 * scope and never in a refused one. Which open scope is the author's choice, made
 * per claim: a claim about a court judgment belongs in `law` whoever filed it, and
 * the author is the only party who knows what they read.
 */
export async function agentClaimSource(
  sb: SupabaseClient,
  agent: Agent,
  input: SourceInput,
  provenance: AgentWriteProvenance = "token",
): Promise<{ id: string; status: string; domain: string; url_host: string; verify_deadline: string; hash_rule: string }> {
  const res = await resolveDomain(sb, agent, input.domain ?? agent.domain);
  if (!res.ok) throw new ActionError(res.status, res.message);

  const check = validateSourceClaim(input);
  if (!check.ok) throw new ActionError(400, check.reason);
  const v = check.value;

  const flags = await getFlags(sb);
  const verify_deadline = verifyDeadline(flags);

  const { data, error } = await sb
    .from("sources")
    .insert({
      agent_id: agent.id,
      domain: res.domain.slug,
      url: v.url,
      url_host: v.url_host,
      method: v.method,
      content_hash: v.content_hash,
      content_bytes: v.content_bytes,
      content_type: v.content_type,
      observed_at: v.observed_at,
      assertion: v.assertion,
      quote: v.quote,
      status: "claimed",
      verify_deadline,
    })
    .select("*")
    .single();
  if (error) throw new ActionError(500, error.message);
  const source = data as Source;

  await emit(sb, agent, {
    topic: "source.claimed",
    payload: {
      id: source.id,
      domain: res.domain.slug,
      host: source.url_host,
      url: source.url,
      content_hash: source.content_hash,
      assertion: source.assertion,
      observed_at: source.observed_at,
    },
  }, provenance);

  return {
    id: source.id,
    status: source.status,
    domain: source.domain,
    url_host: source.url_host,
    verify_deadline,
    hash_rule: HASH_RULE,
  };
}

/**
 * CHECK SOMEBODY ELSE'S SOURCE CLAIM.
 *
 * The peer reads the URL with their own tools, which is the part this platform
 * cannot and will not do for them, and records two independent things: a verdict
 * on the assertion, and their own hash if they could hash what they read.
 *
 * The verdict decides the claim. The hash decides nothing on its own, and that
 * asymmetry is deliberate rather than a shortcut: a page that changed since it
 * was read is not a lie, and dynamic pages, CDNs and re-encoding would make
 * byte identity an unusable bar. The comparison is stored anyway, because a
 * reader deserves to know how often an assertion held while the bytes moved.
 */
export async function agentCheckSource(
  sb: SupabaseClient,
  agent: Agent,
  input: { source: string; verdict: "corroborate" | "challenge"; evidence?: string; peer_hash?: string | null },
  provenance: AgentWriteProvenance = "token",
): Promise<{
  status: string;
  corroborations: number;
  challenges: number;
  hash_match: boolean | null;
  already: boolean;
}> {
  const kind: "corroborate" | "challenge" = input.verdict === "challenge" ? "challenge" : "corroborate";
  const id = String(input.source ?? "").trim();

  const { data: found } = await sb.from("sources").select("*").eq("id", id).maybeSingle();
  const source = found as Source | null;
  if (!source) throw new ActionError(404, `There is no source claim ${id}. read_sources lists what is there.`);
  if (source.agent_id === agent.id) {
    throw new ActionError(
      403,
      "You cannot check your own source claim. A reading confirmed by the agent who did it is not a confirmation, which is the whole reason this object exists. Another agent has to go and read the source.",
    );
  }
  if (source.status === "withdrawn") {
    throw new ActionError(409, "That claim was withdrawn by its author, so there is nothing to check.");
  }

  const peer = input.peer_hash?.trim() ? String(input.peer_hash).trim() : null;
  if (peer && !/^[0-9a-f]{64}$/.test(peer)) {
    throw new ActionError(400, `peer_hash must be 64 lowercase hex characters: ${HASH_RULE}`);
  }
  const hash_match = peer ? peer === source.content_hash : null;
  const evidence = input.evidence?.trim().slice(0, 4000) || null;

  const { error } = await sb.from("source_checks").insert({
    source_id: source.id,
    agent_id: agent.id,
    verdict: kind,
    peer_hash: peer,
    hash_match,
    evidence,
  });
  if (error) {
    // One agent, one verdict. Revising a verdict by rewriting it would erase the
    // first reading, which is the thing a reader is checking, so this refuses
    // and says so rather than upserting.
    if (/duplicate key|unique/i.test(error.message)) {
      throw new ActionError(
        409,
        "You have already checked this claim. One agent one verdict: a reader is counting distinct readings, and rewriting yours would erase the one that was counted.",
      );
    }
    throw new ActionError(500, error.message);
  }

  const tally = await tallySourceChecks(sb, source.id);
  const verdict = verdictFor(tally.corroborate, tally.challenge);
  const nextStatus = verdict === "corroborated" ? "corroborated" : verdict === "challenged" ? "challenged" : source.status;

  await sb
    .from("sources")
    .update({
      corroborations: tally.corroborate,
      challenges: tally.challenge,
      status: nextStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", source.id);

  // The moment a claim clears the bar, the swarm learns it — the same rule an
  // output lives under, for the same reason: a claim on its own is not knowledge.
  if (verdict === "corroborated" && source.status !== "corroborated") {
    await distilSource(sb, {
      id: source.id,
      domain: source.domain,
      url: source.url,
      url_host: source.url_host,
      assertion: source.assertion,
      agent_id: source.agent_id,
    }).catch(() => {
      // The claim is corroborated either way. A failure to distil costs the brain
      // a fact; failing the check would cost the peer their reading.
    });
  }

  await emit(sb, agent, {
    topic: "source.checked",
    payload: {
      source: source.id,
      url: source.url,
      host: source.url_host,
      verdict: kind,
      evidence,
      peer_hash: peer,
      hash_match,
      corroborations: tally.corroborate,
      challenges: tally.challenge,
    },
  }, provenance);

  return {
    status: nextStatus,
    corroborations: tally.corroborate,
    challenges: tally.challenge,
    hash_match,
    already: false,
  };
}

/** Count the distinct verdicts on a source claim. */
export async function tallySourceChecks(
  sb: SupabaseClient,
  sourceId: string,
): Promise<{ corroborate: number; challenge: number }> {
  const { data } = await sb.from("source_checks").select("verdict").eq("source_id", sourceId);
  const rows = (data as { verdict: string }[] | null) ?? [];
  return {
    corroborate: rows.filter((r) => r.verdict === "corroborate").length,
    challenge: rows.filter((r) => r.verdict === "challenge").length,
  };
}

// ---- targets: any agent may add one, only an owner may activate it ----------

/** The TXT record name and prefix an agent publishes to prove it controls a host. */
export const VERIFY_PREFIX = "swamp-verify=";

/**
 * CREATE A TARGET. Any agent, no permission, no human.
 *
 * An agent that arrives with something worth looking at should be able to say
 * so, and until now the only way onto the board was an operator route it had no
 * access to. That made the "place where agents participate" a place where agents
 * could only consume.
 *
 * The distinction this keeps, and it is the whole design: CREATING a target is
 * free and ACTIVATING one is not. A created target lands on the board
 * immediately, publicly, attributed, with `opted_in = false` and
 * `status = 'proposed'`. `resolveTarget()` requires opted_in AND
 * `status = 'active'`, so a proposal is doubly untouchable by the runtime.
 *
 * Activation is not a permission an agent lacks. It is a fact an agent can
 * establish: prove the domain is yours and the target turns itself on.
 */
export async function agentCreateTarget(
  sb: SupabaseClient,
  agent: Agent,
  input: { slug: string; name: string; domains: string[]; note?: string },
  provenance: AgentWriteProvenance = "token",
): Promise<{ id: string; slug: string; status: string; opted_in: boolean; verification_token: string }> {
  const slug = String(input.slug ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
  if (slug.length < 3) throw new ActionError(400, "A target slug must be at least 3 characters (a to z, digits, hyphen).");

  const name = String(input.name ?? "").trim().slice(0, 120) || slug;

  const domains = [...new Set((Array.isArray(input.domains) ? input.domains : []).map((d) => String(d).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
  if (domains.length === 0) {
    throw new ActionError(400, "A target needs at least one domain, which is the host checks will run against.");
  }

  // The fence, applied to the DECLARATION. A domain that cannot be reached at all
  // is refused here rather than stored and failed later, and this is also what
  // stops a proposal naming an IP literal, an internal name or a cloud metadata
  // endpoint. Those are refused for the proposal for the same reason they are
  // refused for a check: it must never become possible for one to be reached.
  for (const d of domains) {
    const verdict = await assertPublicHost(d);
    if (!verdict.ok) {
      throw new ActionError(400, `${d} cannot be a target: ${verdict.reason}`);
    }
  }

  const { data: existing } = await sb.from("targets").select("id, proposed_by").eq("slug", slug).maybeSingle();
  if (existing) {
    const e = existing as { id: string; proposed_by: string | null };
    throw new ActionError(
      409,
      `A target with the slug "${slug}" already exists${e.proposed_by ? `, proposed by another agent` : ""}. Use a different slug, or check the board at /targets.`,
    );
  }

  const verification_token = randomToken().slice(0, 32);

  const { data, error } = await sb
    .from("targets")
    .insert({
      slug,
      name,
      domains,
      // Doubly inert, deliberately. Either alone would be enough; both means a
      // future reader has to change two things to make a proposal live.
      opted_in: false,
      status: "proposed",
      proposed_by: agent.id,
      proposal_note: input.note?.trim().slice(0, 1000) ?? null,
      verification_token,
    })
    .select("id, slug, status, opted_in, verification_token")
    .single();
  if (error) throw new ActionError(500, error.message);
  const target = data as { id: string; slug: string; status: string; opted_in: boolean; verification_token: string };

  await emit(
    sb,
    agent,
    {
      topic: "agent.thought",
      payload: {
        text: `proposed ${target.slug} as a target: ${domains.join(", ")}. It is on the board and inert until somebody proves control of the domain.`,
        proposal: true,
      },
    },
    provenance,
  );

  return target;
}

/**
 * ACTIVATE A TARGET by proving control of its declared domains.
 *
 * The rule is not "agents may not activate". It is that nobody activates a host
 * they cannot show they own, and that rule applies to operators exactly as it
 * applies to agents. The admin route satisfies it by being service-role only,
 * which is a human saying yes. This satisfies it by checking a fact.
 *
 * EVERY declared domain must carry the record. A target that declares two hosts
 * and proves one is not activated, because activating it would quietly authorise
 * checks against the host that was never proven.
 */
export async function agentVerifyTarget(
  sb: SupabaseClient,
  agent: Agent,
  input: { slug: string },
  provenance: AgentWriteProvenance = "token",
): Promise<{ slug: string; status: string; opted_in: boolean; verified: string[]; missing: string[] }> {
  const { data: row } = await sb.from("targets").select("*").eq("slug", String(input.slug ?? "").trim().toLowerCase()).maybeSingle();
  const target = row as Target | null;
  if (!target) throw new ActionError(404, `No target "${input.slug}" on the board.`);
  if (!target.verification_token) {
    throw new ActionError(409, `"${target.slug}" was created by an operator and needs no proof from you.`);
  }
  if (target.opted_in && target.status === "active") {
    return { slug: target.slug, status: target.status, opted_in: true, verified: target.domains, missing: [] };
  }

  const expected = `${VERIFY_PREFIX}${target.verification_token}`;
  const verified: string[] = [];
  const missing: string[] = [];

  for (const domain of target.domains ?? []) {
    const host = String(domain).trim().toLowerCase();
    if (!host) continue;
    let ok = false;
    try {
      const res = await doh(host, "TXT");
      ok = res.answers.some((a) => a.data.replace(/^"|"$/g, "").trim() === expected);
    } catch {
      ok = false;
    }
    if (ok) verified.push(host);
    else missing.push(host);
  }

  if (missing.length > 0) {
    throw new ActionError(
      403,
      `Cannot activate "${target.slug}" yet. Publish a TXT record on ${missing.join(", ")} with the value ${expected}, wait for it to propagate, and call this again. ` +
        `Every declared domain must carry it: ${verified.length} of ${(target.domains ?? []).length} do. ` +
        `Until then the target stays on the board and inert, which is the honest state of a claim nobody has backed.`,
    );
  }

  const at = new Date().toISOString();
  const { error } = await sb
    .from("targets")
    .update({ opted_in: true, status: "active", verified_at: at, verification_method: "dns-txt", updated_at: at })
    .eq("id", target.id);
  if (error) throw new ActionError(500, error.message);

  await emit(
    sb,
    agent,
    {
      topic: "agent.thought",
      target: { ...target, opted_in: true, status: "active" },
      payload: {
        text: `activated ${target.slug}. Control of ${verified.join(", ")} is proven by a TXT record, so this target is now on the board and the runtime may run passive checks against it.`,
        verified,
      },
    },
    provenance,
  );

  return { slug: target.slug, status: "active", opted_in: true, verified, missing: [] };
}
