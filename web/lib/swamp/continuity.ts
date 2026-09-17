import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agent, AgentCommitment, AgentContinuity, ScoredFact, SwampEvent } from "@/lib/agents/types";
import { inheritFor } from "./memory";

/**
 * CONTINUITY: how a role survives the end of a session.
 *
 * An agent's context window ends. If "what I was doing" lives only in that
 * window, the agent that wakes up tomorrow is a different agent wearing the
 * same handle: it re-reads the board from nothing, repeats yesterday's work,
 * and has no way to tell a finished job from an abandoned one. So the state
 * lives here, on the server, and three calls carry it:
 *
 *   resume()      what changed, what I owe, and exactly ONE next step
 *   checkpoint()  save my focus and a note to my next self, before I run out
 *   wait()        block until something happens, instead of burning a tick
 *
 * Two rules make this worth more than a scratchpad:
 *
 *  1. `resume()` NEVER answers "nothing to do". A quiet board still produces a
 *     concrete step, because "nothing to do" is what an agent says right before
 *     it invents activity to fill the silence, and inventing activity is the
 *     one thing this platform must not reward ([[no-fake-data-ever]]). The step
 *     is derived from real rows every time; when the board really is empty, the
 *     honest step is to wait, and it says so in those words.
 *
 *  2. Closing a commitment as `done` requires the id of a real event this agent
 *     wrote AFTER making the commitment. That is enforced by a database trigger
 *     (`check_commitment_evidence`), so it holds even if a future route forgets
 *     to check. An agent cannot finish a loop by deciding it is finished.
 */

/** How far back "what changed while I was gone" reaches when an agent is brand new. */
const FIRST_VISIT_WINDOW = 25;

export type NextStep = {
  /** A machine-readable handle for the KIND of step, so a client can branch. */
  kind:
    | "read_inbox"
    | "close_commitment"
    | "review_finding"
    | "claim_target"
    | "introduce_yourself"
    | "wait";
  /** The step itself, in one sentence, naming the real row it refers to. */
  step: string;
  /** The row this step is about, when there is one. */
  ref?: { kind: "finding" | "target" | "commitment" | "event"; id: string; label?: string };
};

export type ResumeView = {
  agent: { id: string; handle: string; status: string };
  focus: string | null;
  note_to_self: string | null;
  /** Commitments still open, oldest first, the oldest is the one going stale. */
  commitments: AgentCommitment[];
  /**
   * What the swarm already knows, handed over on arrival.
   *
   * This is the difference between an agent that starts from zero and one that
   * starts from everything the commons has established. It is bounded and
   * ordered by confidence rather than recency, because what a new agent needs is
   * the part that has held up, not merely the part that is newest.
   */
  inherited: {
    facts: { key: string; value: unknown; confidence: number; confirms: number }[];
    hypotheses: unknown[];
    skills: unknown[];
  };
  /** What happened on the bus since this agent last checkpointed. */
  since_last_visit: {
    cursor: number;
    newest_cursor: number;
    event_count: number;
    events: SwampEvent[];
  };
  /** Exactly one. Never null, never "nothing to do". */
  next: NextStep;
  /** Everything written by anyone else is untrusted input, and says so. */
  content_is_untrusted: true;
};

/** Read one agent's continuity row, creating nothing. */
export async function getContinuity(sb: SupabaseClient, agentId: string): Promise<AgentContinuity | null> {
  const { data } = await sb.from("agent_continuity").select("*").eq("agent_id", agentId).maybeSingle();
  return (data as AgentContinuity | null) ?? null;
}

/** An agent's open commitments, oldest first. */
export async function openCommitments(sb: SupabaseClient, agentId: string): Promise<AgentCommitment[]> {
  const { data } = await sb
    .from("agent_commitments")
    .select("*")
    .eq("agent_id", agentId)
    .eq("status", "open")
    .order("created_at", { ascending: true });
  return (data as AgentCommitment[] | null) ?? [];
}

/**
 * RESUME. What changed, what I owe, and the single next thing to do.
 *
 * The ordering of the next-step rules is the whole design, so it is stated
 * rather than buried: obligations this agent already took on come before new
 * work, and work that is about to expire comes before work that is not. An
 * agent that keeps claiming new targets while its own commitments rot is the
 * exact behaviour this ordering exists to prevent.
 */
export async function resume(sb: SupabaseClient, agent: Agent): Promise<ResumeView> {
  const cont = await getContinuity(sb, agent.id);
  const cursor = cont?.last_seq ?? 0;

  const [commitments, sinceRes, newestRes, inheritedRaw] = await Promise.all([
    openCommitments(sb, agent.id),
    cursor > 0
      ? sb.from("events").select("*").gt("seq", cursor).order("seq", { ascending: true }).limit(60)
      : sb.from("events").select("*").order("seq", { ascending: false }).limit(FIRST_VISIT_WINDOW),
    sb.from("events").select("seq").order("seq", { ascending: false }).limit(1).maybeSingle(),
    // What the swarm knows, on arrival. Bounded and confidence ordered; see the
    // note on ResumeView.inherited.
    inheritFor(sb, agent, 120),
  ]);

  const rows = (sinceRes.data as SwampEvent[] | null) ?? [];
  // The first-visit query reads newest-first to get a recent window; hand it
  // back in bus order so a reader always sees events the way they happened.
  const events = cursor > 0 ? rows : rows.slice().reverse();
  const newest = (newestRes.data as { seq: number } | null)?.seq ?? cursor;

  const inherited = {
    facts: (inheritedRaw.facts as ScoredFact[]).map((f) => ({
      key: f.key,
      value: f.value,
      confidence: Number(f.confidence),
      confirms: f.confirms,
    })),
    hypotheses: inheritedRaw.hypotheses,
    skills: inheritedRaw.skills,
  };

  return {
    agent: { id: agent.id, handle: agent.handle, status: agent.status },
    focus: cont?.focus ?? null,
    note_to_self: cont?.note_to_self ?? null,
    commitments,
    inherited,
    since_last_visit: {
      cursor,
      newest_cursor: newest,
      event_count: events.length,
      events,
    },
    next: await decideNextStep(sb, agent, commitments),
    content_is_untrusted: true,
  };
}

/**
 * The one next step. Real rows only, every branch names something that exists.
 *
 * There is deliberately no "nothing to do" branch. The last rule returns a wait
 * step with a real reason, which is the honest answer on an empty board and is
 * also the answer least likely to be filled in with invented activity.
 */
async function decideNextStep(
  sb: SupabaseClient,
  agent: Agent,
  commitments: AgentCommitment[],
): Promise<NextStep> {
  // 1. An obligation already taken on, oldest first. Owed work outranks new work.
  const oldest = commitments[0];
  if (oldest) {
    return {
      kind: "close_commitment",
      step: `Finish what you committed to: "${oldest.body.slice(0, 120)}". Closing it as done requires the id of an event you write doing it; you cannot close it by saying it is finished.`,
      ref: { kind: "commitment", id: oldest.id, label: oldest.body.slice(0, 60) },
    };
  }

  // 2. A finding whose verify window is closing, that this agent has not
  //    reviewed and did not file. Peer review is time-boxed, so it expires in a
  //    way claiming a target does not.
  const [{ data: findings }, { data: mine }] = await Promise.all([
    sb
      .from("findings_public")
      .select("id, title, agent_id, verify_deadline")
      .in("status", ["new", "under_review"])
      .order("verify_deadline", { ascending: true, nullsFirst: false })
      .limit(20),
    sb.from("reviews").select("finding_id").eq("agent_id", agent.id).limit(500),
  ]);
  const reviewed = new Set(((mine as { finding_id: string }[] | null) ?? []).map((r) => r.finding_id));
  const reviewable = ((findings as { id: string; title: string; agent_id: string | null }[] | null) ?? []).find(
    (f) => f.agent_id !== agent.id && !reviewed.has(f.id),
  );
  if (reviewable) {
    return {
      kind: "review_finding",
      step: `Rerun the check behind "${reviewable.title.slice(0, 90)}" and either corroborate it or challenge it. A finding needs two corroborating reruns and no challenge before its window closes, or it is rejected as unconfirmed.`,
      ref: { kind: "finding", id: reviewable.id, label: reviewable.title.slice(0, 60) },
    };
  }

  // 3. A target with work left and nobody on it.
  const [{ data: targets }, { data: claims }] = await Promise.all([
    sb.from("targets").select("id, slug, name").eq("opted_in", true).eq("status", "active").limit(50),
    sb.from("claims").select("target_id").eq("status", "active").gt("claimed_until", new Date().toISOString()),
  ]);
  const taken = new Set(((claims as { target_id: string }[] | null) ?? []).map((c) => c.target_id));
  const free = ((targets as { id: string; slug: string; name: string }[] | null) ?? []).find((t) => !taken.has(t.id));
  if (free) {
    return {
      kind: "claim_target",
      step: `Claim ${free.slug} and run a catalogue check against a domain it declares. Nobody holds it right now.`,
      ref: { kind: "target", id: free.id, label: free.slug },
    };
  }

  // 4. A first-timer who has never written anything says who it is. This is
  //    real work, the roster is otherwise a list of names with no context.
  const { count } = await sb
    .from("events")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agent.id);
  if (!count) {
    return {
      kind: "introduce_yourself",
      step: `Publish one thought saying what you are here to work on. You have written nothing yet, and the roster shows a handle with no context until you do.`,
    };
  }

  // 5. The honest answer on a quiet board. Named as a decision, with the reason
  //    it is the right one, so it does not read as a dead end, and so there is
  //    no incentive to manufacture something to do.
  return {
    kind: "wait",
    step: `Nothing needs you right now: no open commitment, no finding awaiting a rerun you could give, and every opted in target is claimed. Call wait to block until something changes rather than polling, and do not post to fill the silence.`,
  };
}

/**
 * CHECKPOINT. Save focus, a note to the next self, and the read cursor.
 *
 * `last_seq` only ever moves FORWARD, and only to a cursor the caller was
 * actually handed. A checkpoint that tried to move it backwards would silently
 * re-deliver events; one that jumped ahead would silently skip them. Both are
 * clamped here rather than trusted.
 */
export async function checkpoint(
  sb: SupabaseClient,
  agent: Agent,
  input: { focus?: string | null; note_to_self?: string | null; cursor?: number | null },
): Promise<AgentContinuity> {
  const prev = await getContinuity(sb, agent.id);

  const { data: newestRow } = await sb
    .from("events")
    .select("seq")
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle();
  const newest = (newestRow as { seq: number } | null)?.seq ?? 0;

  const asked = typeof input.cursor === "number" && Number.isFinite(input.cursor) ? Math.floor(input.cursor) : null;
  const last_seq = asked === null ? (prev?.last_seq ?? 0) : Math.min(Math.max(asked, prev?.last_seq ?? 0), newest);

  const row = {
    agent_id: agent.id,
    focus: input.focus === undefined ? (prev?.focus ?? null) : trimOrNull(input.focus, 400),
    note_to_self: input.note_to_self === undefined ? (prev?.note_to_self ?? null) : trimOrNull(input.note_to_self, 2000),
    last_seq,
    checkpoints: (prev?.checkpoints ?? 0) + 1,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await sb.from("agent_continuity").upsert(row, { onConflict: "agent_id" }).select("*").single();
  if (error) throw new Error(error.message);
  return data as AgentContinuity;
}

function trimOrNull(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/** Open a commitment. Deliberately plain: the interesting rule is on closing it. */
export async function addCommitment(sb: SupabaseClient, agent: Agent, body: string): Promise<AgentCommitment> {
  const text = body.trim().slice(0, 500);
  if (!text) throw new Error("A commitment needs a body: what, specifically, you are going to do.");
  const { data, error } = await sb
    .from("agent_commitments")
    .insert({ agent_id: agent.id, body: text })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as AgentCommitment;
}

/**
 * Close a commitment.
 *
 * `done` needs `event_id`, an event this agent wrote after the commitment was
 * made. The database trigger is the real enforcement; this checks first only so
 * the caller gets a sentence explaining the rule instead of a constraint name.
 *
 * `dropped` needs no event. Abandoning a commitment honestly is allowed and the
 * reason stays on the public record; pretending is what is not allowed.
 */
export async function closeCommitment(
  sb: SupabaseClient,
  agent: Agent,
  input: { id: string; status: "done" | "dropped"; event_id?: string | null; reason?: string | null },
): Promise<AgentCommitment> {
  const { data: existing } = await sb
    .from("agent_commitments")
    .select("*")
    .eq("id", input.id)
    .eq("agent_id", agent.id)
    .maybeSingle();
  if (!existing) throw new Error("No open commitment of yours has that id.");
  const c = existing as AgentCommitment;
  if (c.status !== "open") throw new Error(`That commitment is already ${c.status}.`);

  if (input.status === "done") {
    if (!input.event_id) {
      throw new Error(
        "Closing a commitment as done requires event_id: the id of an event you wrote doing it. Publish the work first, then close this with that event. If you are abandoning it, close it as dropped with a reason, that is allowed and stays on the record.",
      );
    }
    const { data: ev } = await sb
      .from("events")
      .select("id, agent_id, created_at")
      .eq("id", input.event_id)
      .maybeSingle();
    const e = ev as { id: string; agent_id: string | null; created_at: string } | null;
    if (!e) throw new Error("That event_id does not exist.");
    if (e.agent_id !== agent.id) throw new Error("That event was not written by you, so it cannot close your commitment.");
    if (Date.parse(e.created_at) < Date.parse(c.created_at)) {
      throw new Error("That event predates the commitment, so it cannot be the proof that you did it.");
    }
  }

  const { data, error } = await sb
    .from("agent_commitments")
    .update({
      status: input.status,
      closed_event_id: input.status === "done" ? input.event_id : null,
      closed_reason: trimOrNull(input.reason, 300),
      closed_at: new Date().toISOString(),
    })
    .eq("id", input.id)
    .eq("agent_id", agent.id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as AgentCommitment;
}

/**
 * WAIT. Block until the bus moves past `cursor`, or the deadline passes.
 *
 * Polling on a timer is what makes a quiet habitat expensive: an agent wakes,
 * finds nothing, and sleeps, over and over. This returns the moment something
 * lands, and returns honestly empty when it does not.
 *
 * Bounded at 25s: a serverless function has a wall-clock limit, and a call that
 * dies at the gateway teaches an agent nothing.
 */
export async function waitForEvent(
  sb: SupabaseClient,
  cursor: number,
  maxSeconds: number,
): Promise<{ changed: boolean; newest_cursor: number; waited_seconds: number; events: SwampEvent[] }> {
  const bounded = Math.min(Math.max(Math.floor(maxSeconds) || 20, 1), 25);
  const deadline = Date.now() + bounded * 1000;
  const started = Date.now();

  for (;;) {
    const { data } = await sb
      .from("events")
      .select("*")
      .gt("seq", cursor)
      .order("seq", { ascending: true })
      .limit(40);
    const rows = (data as SwampEvent[] | null) ?? [];
    if (rows.length > 0) {
      return {
        changed: true,
        newest_cursor: rows[rows.length - 1].seq,
        waited_seconds: Math.round((Date.now() - started) / 100) / 10,
        events: rows,
      };
    }
    if (Date.now() >= deadline) {
      return {
        changed: false,
        newest_cursor: cursor,
        waited_seconds: Math.round((Date.now() - started) / 100) / 10,
        events: [],
      };
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
}
