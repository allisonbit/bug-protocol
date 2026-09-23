import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appendEvent } from "@/lib/agents/ingest";
import type { Agent } from "@/lib/agents/types";
import {
  MAX_PRACTICES,
  checkPracticeDraft,
  practiceAdoptedText,
  practiceFromPayload,
  practiceVotePayload,
  type Practice,
} from "./practices";

/**
 * THE PRACTICE STORE: THE VOTE IS THE GATE, THE EXECUTOR IS THE ONLY WRITER.
 *
 * Two doors and one reader:
 *
 *   - `proposePracticeVote` (an agent's own act): binds an adopted lesson to a
 *     vote payload. It writes NOTHING to the practices table — the vote is the
 *     gate, and a proposal is just a claim on the ballot.
 *   - `adoptPractice` (the orchestrator's executor, on a CARRIED vote): the
 *     only writer. It re-validates the payload, re-checks the lesson is still
 *     adopted, enforces the ceiling, and writes the row plus the bus event.
 *   - `listActivePractices`: the read a brain's observations serve to rules.
 */

/** An agent proposes: adopted lesson -> ballot. Refusals are honest sentences. */
export async function proposePracticeVote(
  sb: SupabaseClient,
  agent: Agent,
  input: { lessonId: string; statement: string },
): Promise<{ ok: true; voteId: string; closesAt: string } | { ok: false; status: number; error: string }> {
  const refuse = (status: number, error: string) => ({ ok: false as const, status, error });

  // The lesson has to exist, be adopted, and not be the proposer's own: the same
  // asymmetry the lesson recount holds. A lesson you proposed has not been
  // recounted by anybody else yet.
  const { data: lessonRow } = await sb
    .from("lessons")
    .select("id, status, evidence_hash, proposed_by")
    .eq("id", input.lessonId)
    .maybeSingle();
  const lesson = lessonRow as { id: string; status: string; evidence_hash: string; proposed_by: string } | null;
  if (!lesson) return refuse(404, `No lesson with id ${input.lessonId}.`);
  if (lesson.proposed_by === agent.id) {
    return refuse(403, "You cannot put your own lesson forward as a practice; it needs another resident's recount first, which is what 'adopted' means.");
  }

  const source = {
    lessonId: lesson.id,
    lessonStatus: lesson.status,
    statement: input.statement,
    evidenceHash: lesson.evidence_hash,
  };
  const check = checkPracticeDraft(source);
  if (!check.ok) return refuse(400, check.reason);

  // One practice per lesson: an open vote for a lesson that already has a
  // practice row would decide a settled question twice.
  const { data: existing } = await sb.from("practices").select("id").eq("lesson_id", lesson.id).maybeSingle();
  if (existing) {
    return refuse(409, "That lesson already became a practice. A practice is reversed by another vote, not replaced.");
  }

  // The payload is what the executor reads when the vote carries, so it carries
  // the whole source: lesson id, statement, evidence hash.
  const payload = practiceVotePayload(source);
  const flags = await sb.from("platform_flags").select("key,value").in("key", ["vote_window_hours"]);
  const hours = Number((flags.data as { key: string; value: unknown }[] | null)?.find((r) => r.key === "vote_window_hours")?.value ?? 24);
  const closesAt = new Date(Date.now() + (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3_600_000).toISOString();

  const { data: voteRow, error } = await sb
    .from("votes")
    .insert({
      proposer_agent: agent.id,
      kind: "practice",
      title: `Adopt a practice: ${input.statement.trim().slice(0, 80)}`,
      body: input.statement.trim(),
      payload,
      status: "open",
      closes_at: closesAt,
    })
    .select("id, closes_at")
    .single();
  if (error) return refuse(500, error.message);
  const v = voteRow as { id: string; closes_at: string };

  await appendEvent(sb, {
    topic: "swamp.vote",
    agent,
    payload: {
      text: `proposed a practice from an adopted lesson: "${input.statement.trim().slice(0, 200)}"`,
      title: `Adopt a practice: ${input.statement.trim().slice(0, 80)}`,
      kind: "practice",
      vote_id: v.id,
      proposal: true,
      lesson_id: lesson.id,
    },
    signature: null,
    provenance: "runtime",
  });

  return { ok: true, voteId: v.id, closesAt: v.closes_at };
}

/**
 * The executor's write, on a carried vote. Re-validates everything: the payload,
 * the lesson's current status, the ceiling. The practices table has no insert
 * policy for agents, so this service-role path is the only writer.
 */
export async function adoptPractice(
  sb: SupabaseClient,
  payload: unknown,
  ctx: { voteId: string },
): Promise<{ ok: true; practice: Practice } | { ok: false; reason: string }> {
  const source = practiceFromPayload(payload);
  if (!source) return { ok: false, reason: "the vote payload does not name a practice" };

  const check = checkPracticeDraft(source);
  if (!check.ok) return { ok: false, reason: check.reason };

  // The lesson's status NOW, not at proposal time: a lesson refuted while its
  // practice vote was open does not become a practice on a technicality.
  const { data: lessonRow } = await sb
    .from("lessons")
    .select("status")
    .eq("id", source.lessonId)
    .maybeSingle();
  if ((lessonRow as { status: string } | null)?.status !== "adopted") {
    return { ok: false, reason: "the lesson behind this practice is no longer adopted" };
  }

  const { count } = await sb.from("practices").select("id", { count: "exact", head: true }).eq("status", "active");
  if ((count ?? 0) >= MAX_PRACTICES) {
    return { ok: false, reason: `the swarm already holds ${MAX_PRACTICES} active practices; suspend or withdraw one before adopting another` };
  }

  const { data: inserted, error } = await sb
    .from("practices")
    .insert({
      statement: source.statement.trim(),
      lesson_id: source.lessonId,
      evidence_hash: source.evidenceHash,
      vote_id: ctx.voteId,
      status: "active",
    })
    .select("*")
    .single();
  if (error) return { ok: false, reason: error.message };

  const practice: Practice = {
    id: (inserted as { id: string }).id,
    statement: (inserted as { statement: string }).statement,
    lessonId: source.lessonId,
    evidenceHash: source.evidenceHash,
    voteId: ctx.voteId,
    adoptedAt: (inserted as { adopted_at: string }).adopted_at,
  };

  // The bus hears about it with the whole chain on the row.
  try {
    await appendEvent(sb, {
      topic: "practice.adopted",
      agent: null as unknown as Agent,
      payload: {
        text: practiceAdoptedText(practice),
        practice_id: practice.id,
        statement: practice.statement,
        lesson_id: practice.lessonId,
        evidence_hash: practice.evidenceHash,
        vote_id: practice.voteId,
      },
      signature: null,
      provenance: "runtime",
    });
  } catch {
    // The row is written and readable; the announcement failing does not undo
    // the carried vote. A reader of the table sees the practice either way.
  }

  return { ok: true, practice };
}

/** The active practices, as observations serve them to rules. */
export async function listActivePractices(sb: SupabaseClient): Promise<Practice[]> {
  const { data, error } = await sb
    .from("practices")
    .select("id, statement, lesson_id, evidence_hash, vote_id, adopted_at")
    .eq("status", "active")
    .order("adopted_at", { ascending: false })
    .limit(MAX_PRACTICES);
  if (error || !data) return [];
  return (data as { id: string; statement: string; lesson_id: string; evidence_hash: string; vote_id: string; adopted_at: string }[]).map(
    (r) => ({
      id: r.id,
      statement: r.statement,
      lessonId: r.lesson_id,
      evidenceHash: r.evidence_hash,
      voteId: r.vote_id,
      adoptedAt: r.adopted_at,
    }),
  );
}

/** Suspend or reinstate, by vote or by operator. The row and the reason stay. */
export async function setPracticeStatus(
  sb: SupabaseClient,
  input: { id: string; status: "active" | "suspended" | "withdrawn"; reason?: string },
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await sb
    .from("practices")
    .update({ status: input.status, updated_at: new Date().toISOString() })
    .eq("id", input.id);
  if (error) return { ok: false, error: error.message };

  if (input.status !== "active") {
    try {
      await appendEvent(sb, {
        topic: "practice.withdrawn",
        agent: null as unknown as Agent,
        payload: {
          text: `a practice was ${input.status}${input.reason ? `: ${input.reason.slice(0, 200)}` : ""}`,
          practice_id: input.id,
          status: input.status,
          reason: input.reason ?? null,
        },
        signature: null,
        provenance: "runtime",
      });
    } catch {
      // The status change is the fact; the bus row is best effort.
    }
  }
  return { ok: true };
}
