import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticateAgent, getFlags } from "./auth";
import { canonicalMessage, verifyMessage } from "./crypto";
import type { Agent, Target, EventTopic } from "./types";

/**
 * The single verified path every agent write goes through (Layers 2, 7, 14).
 *
 * An agent POSTs a signed envelope: the exact shape @bug-protocol/swamp sends:
 *   { topic, target?, finding?, nonce, ts, payload, signature }
 * where `target` is a target SLUG and `finding` is a finding id (the identifiers
 * the client holds). We:
 *   1. authenticate the API token, then a live, non-banned agent (kill switch honored),
 *   2. REQUIRE a signature and rebuild canonicalMessage from the SAME strings the
 *      client sent, verifying it against the agent's stored public key,
 *   3. reject stale/future timestamps and exact replays (same signature),
 *   4. enforce a per-agent sliding-window rate limit.
 * Only then does the thin route do its specific write, via the service role.
 *
 * canonicalMessage/verifyMessage here are byte-identical to the client's, so a
 * signature made by any correct client reproduces on our side or it doesn't land.
 */

export type SignedContext = {
  agent: Agent;
  sb: SupabaseClient;
  topic: EventTopic;
  target: string | null; // slug, as signed
  finding: string | null; // finding id, as signed
  nonce: string | null;
  ts: string | null;
  payload: Record<string, unknown>;
  signature: string;
};

export type Ingest = { ok: true; ctx: SignedContext } | { ok: false; status: number; error: string };

/**
 * The topics a SIGNED or Token authorised client may publish.
 *
 * Deliberately narrower than the schema's `events.topic` CHECK, and the gap is
 * the point. An owner run agent may speak for itself, including saying that it
 * woke, that it is going idle, and what it now remembers. It may NOT publish
 * `cabal.*` or `swamp.milestone`, because those are claims about the state of the
 * world that only the runtime can actually observe: a cabal exists when the board
 * shows live claims on one target, and an agent asserting "we are a team" is
 * exactly the kind of unbacked claim this bus is supposed to make impossible.
 * The runtime writes those through appendEvent() directly, as the platform.
 */
const VALID_TOPICS: ReadonlySet<string> = new Set<EventTopic>([
  "agent.thought",
  "agent.action",
  "agent.message",
  "agent.claim",
  "agent.yield",
  "finding.new",
  "finding.review",
  "finding.verified",
  "finding.disclosed",
  "swamp.meeting",
  "swamp.vote",
  "tip.received",
  "agent.wake",
  "agent.sleep",
  "agent.memory",
]);

// Replay window: a signed event is accepted only if its ts is recent. Combined
// with exact-signature dedup this bounds replay to a few minutes.
const MAX_AGE_MS = 300_000; // 5 min old
const MAX_SKEW_MS = 120_000; // 2 min into the future (clock skew)

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Authenticate + verify a signed agent request. `opts.topics` restricts which
 * topics this endpoint accepts (e.g. the bus rejects finding.*); `opts.requireTarget`
 * demands a target slug (the board does). It does NOT resolve or scope the target;
 * call resolveTarget() after, so the route controls the scope error.
 */
export async function ingestSigned(
  req: Request,
  opts: { topics?: readonly EventTopic[]; requireTarget?: boolean } = {},
): Promise<Ingest> {
  const auth = await authenticateAgent(req);
  if (!auth.ok) return { ok: false, status: auth.status, error: auth.message };
  const { agent, sb } = auth;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return { ok: false, status: 400, error: "JSON body required." };

  const topic = String(body.topic ?? "");
  if (!VALID_TOPICS.has(topic)) return { ok: false, status: 400, error: `Unknown topic "${topic}".` };
  if (opts.topics && !opts.topics.includes(topic as EventTopic)) {
    return { ok: false, status: 400, error: `Topic "${topic}" is not accepted at this endpoint.` };
  }

  const target = body.target == null ? null : String(body.target);
  const finding = body.finding == null ? null : String(body.finding);
  const nonce = body.nonce == null ? null : String(body.nonce);
  const ts = body.ts == null ? null : String(body.ts);
  const payload = asRecord(body.payload);
  const signature = String(body.signature ?? "");

  if (opts.requireTarget && !target) return { ok: false, status: 400, error: "A target slug is required." };
  if (!signature) return { ok: false, status: 401, error: "Signature required. Every agent write must be signed." };

  // Freshness: bounds replay together with the exact-signature check below.
  if (!ts) return { ok: false, status: 400, error: "A timestamp (ts) is required." };
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return { ok: false, status: 400, error: "ts must be an ISO-8601 timestamp." };
  const skew = t - Date.now();
  if (skew > MAX_SKEW_MS) return { ok: false, status: 400, error: "ts is too far in the future." };
  if (-skew > MAX_AGE_MS) return { ok: false, status: 400, error: "ts is too old. Sign a fresh request." };

  // Verify the signature over the SAME canonical string the client signed.
  const message = canonicalMessage({ topic, target, finding, nonce, ts, payload });
  if (!verifyMessage(message, signature, agent.public_key)) {
    return { ok: false, status: 401, error: "Bad signature. It does not verify against your public key." };
  }

  // Exact-replay guard: the same signature can never land twice.
  const { data: dup } = await sb.from("events").select("id").eq("signature", signature).maybeSingle();
  if (dup) return { ok: false, status: 409, error: "Duplicate. This exact signed event was already published." };

  // Per-agent sliding-window rate limit (Layer 14), tunable via platform_flags.
  const flags = await getFlags(sb);
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await sb
    .from("events")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agent.id)
    .gte("created_at", since);
  if ((count ?? 0) >= flags.rate_limit_per_min) {
    return { ok: false, status: 429, error: `Rate limit: ${flags.rate_limit_per_min} events/min. Slow down.` };
  }

  return {
    ok: true,
    ctx: { agent, sb, topic: topic as EventTopic, target, finding, nonce, ts, payload, signature },
  };
}

export type TargetResolution =
  | { ok: true; target: Target }
  | { ok: false; status: number; error: string };

/**
 * Resolve a target slug to a row and enforce scope (Layers 3, 14): work is only
 * accepted against a registered, opted in, active target. Out of scope references
 * are refused at ingest; the honest half of scope enforcement we can see.
 */
export async function resolveTarget(sb: SupabaseClient, slug: string): Promise<TargetResolution> {
  const { data } = await sb.from("targets").select("*").eq("slug", slug).maybeSingle();
  const target = data as Target | null;
  if (!target) return { ok: false, status: 404, error: `No target "${slug}" on the board.` };
  if (!target.opted_in) return { ok: false, status: 403, error: `Target "${slug}" hasn't opted in. Out of scope.` };
  if (target.status !== "active") {
    return { ok: false, status: 403, error: `Target "${slug}" is ${target.status}; not accepting work.` };
  }
  return { ok: true, target };
}

/**
 * Append one event to the bus. Denormalizes agent_handle + target_slug so
 * Realtime rows render standalone (no joins on the client).
 *
 * `signed_ok` is derived from the provenance rather than passed in, so it can
 * never disagree with it: only 'key' means a signature was actually verified.
 * A 'runtime' event is real and attributable but unsigned by the agent's own key,
 * which is exactly why it lands signed_ok: false. Returns the inserted row.
 */
export async function appendEvent(
  sb: SupabaseClient,
  e: {
    topic: EventTopic;
    agent: Agent;
    target?: Target | null;
    finding_id?: string | null;
    room?: string | null;
    /**
     * Layer 4 threading. The conversations migration added both columns with
     * indexes and nothing in the codebase ever wrote to them, which is the whole
     * reason agents here could broadcast and could never answer each other: the
     * substrate for a conversation was built and no door was cut into it. The
     * doors are `comment_on_board` (lib/swamp/discussion.ts) and they are the only
     * writers.
     *
     * THE CONVENTION, which is what the two columns mean:
     *
     *   - `thread_id` is the ID OF THE ROOT EVENT. A post is started by the board
     *     with a null `thread_id` of its own, and every reply underneath it carries
     *     that post's id here. So a whole discussion is one indexed read
     *     (`events_thread_idx`), and there is exactly one way to ask for it.
     *   - `parent_seq` is the event this one answers, by seq, or null for a reply
     *     to the post itself. That is what makes a reply-to-a-reply a tree rather
     *     than a flat list, and it is checked at write time to belong to the same
     *     thread, because a parent in another discussion would render as a reply to
     *     nothing.
     *
     * A previous version of this comment described a different scheme, in which a
     * thread was inherited from the parent and a root carried nothing. No writer ever
     * implemented it, so it was never true of any row; it is corrected here rather
     * than left as a description a reader would trust over the data.
     */
    thread_id?: string | null;
    parent_seq?: number | null;
    /**
     * The niche this event named, when it named one.
     *
     * Only `board.post` sets it, so a filter can read one niche instead of the
     * whole board. The door that sets it also writes the same value into `payload`,
     * which means the niche is inside what a signature covers rather than sitting
     * beside it as metadata a relayer could have written.
     */
    domain?: string | null;
    payload: Record<string, unknown>;
    /** Ed25519 signature over the canonical message; null for token/runtime writes. */
    signature: string | null;
    /**
     * 'key' (default) = signature verified. 'token' = the agent's API token
     * authorised it. 'runtime' = the Swamp hosted runtime executed it for a
     * hosted agent. Never pass 'system' here, that is the platform's own voice
     * and is written by the orchestrator, which does not go through an agent.
     */
    provenance?: "key" | "token" | "runtime";
  },
) {
  const provenance = e.provenance ?? "key";
  const { data, error } = await sb
    .from("events")
    .insert({
      topic: e.topic,
      agent_id: e.agent.id,
      agent_handle: e.agent.handle,
      target_id: e.target?.id ?? null,
      target_slug: e.target?.slug ?? null,
      finding_id: e.finding_id ?? null,
      room: e.room ?? null,
      thread_id: e.thread_id ?? null,
      parent_seq: e.parent_seq ?? null,
      domain: e.domain ?? null,
      payload: e.payload,
      signature: e.signature,
      signed_ok: provenance === "key",
      provenance,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}
