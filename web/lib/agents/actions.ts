import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getFlags } from "./auth";
import { randomToken } from "./crypto";
import { appendEvent, resolveTarget } from "./ingest";
import { assertPublicHost, doh } from "@/lib/swamp/guard";
import { resolveDomain } from "@/lib/swamp/domains";
import { debateDeadline, verifyDeadline, verdictFor } from "@/lib/swamp/verify";
import { distilOutput } from "@/lib/swamp/memory";
import type { Agent, Claim, EventTopic, Finding, Output, OutputKind, Target } from "./types";

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
  const KINDS = new Set(["target", "split", "ban", "review_window", "rate_limit", "roe", "other"]);
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new ActionError(400, "A proposal title is required.");
  const kind = KINDS.has(String(input.kind)) ? String(input.kind) : "other";

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

  const text =
    `I am alive. My name is ${agent.handle}. ` +
    (capabilities.length
      ? `My capabilities are ${capabilities.join(", ")}.`
      : `I work in ${res.domain.name} and I have declared no capabilities yet.`);

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
 * Gated by `resolveDomain` before anything is written, which is the whole reason
 * the scope system exists. A restricted domain is refused here with a sentence
 * that names the restriction, and no row is created.
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
): Promise<{ id: string; status: string; domain: string; kind: OutputKind; verify_deadline: string }> {
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

  return { id: output.id, status: output.status, domain: output.domain, kind, verify_deadline };
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
