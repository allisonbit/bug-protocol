import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  LESSON_WINDOW_MS,
  type BeatObservation,
  type Lesson,
  type LessonCandidate,
  lessonEvidenceHash,
} from "./lessons";

/**
 * THE LESSONS RECORD, READ AND WRITTEN.
 *
 * `lib/swamp/lessons.ts` is the decision and this is the storage around it, in the same split
 * the rest of this layer uses: everything that can be judged without a database is pure and
 * every query lives here.
 *
 * WHY THE WINDOW IS READ FROM SPANS RATHER THAN FROM A TABLE OF COUNTS. A span already holds
 * what a beat planned, ran, failed, dropped and whether the brain degraded, written by the
 * pulse that did the work. Deriving from those rows means a lesson's evidence and any later
 * refutation are counts of the same thing, so a disagreement is settled by recounting rather
 * than by preferring one reader over another.
 */

/** How many spans a window reads. Enough for the thresholds in the pure module, and bounded. */
export const WINDOW_SPANS = 600;

type SpanRow = {
  seq: number;
  created_at: string;
  agent_handle: string | null;
  payload: { span?: Record<string, unknown> } | null;
};

/**
 * The beats the window holds, oldest first.
 *
 * A span missing the fields a beat normally carries is read as zeroes rather than dropped:
 * the beat happened, and silently discarding it would make the denominator smaller than the
 * truth, which is the direction that turns a quiet afternoon into a pattern.
 */
export async function readBeatWindow(sb: SupabaseClient, now: string): Promise<BeatObservation[]> {
  const since = new Date(Date.parse(now) - LESSON_WINDOW_MS).toISOString();
  const { data, error } = await sb
    .from("events")
    .select("seq, created_at, agent_handle, payload")
    .eq("topic", "pulse.span")
    .gte("created_at", since)
    .order("seq", { ascending: false })
    .limit(WINDOW_SPANS);
  if (error || !data) return [];

  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

  return (data as SpanRow[])
    .map((row) => {
      const span = row.payload?.span ?? {};
      // `null` rather than `[]` when the span does not carry the field at all. The difference
      // is the whole guard: `swamp.rules.fired` was added on 2026-09-22, so every span written
      // before it is silent about which rules ran, and an empty array would report that
      // silence as thirty rules that never fire. `undefined` for a missing degraded field for
      // the same reason, and a beat that wrote `null` there really did not degrade.
      const rules = Array.isArray(span["swamp.rules.fired"])
        ? (span["swamp.rules.fired"] as unknown[]).filter((r): r is string => typeof r === "string")
        : null;
      return {
        seq: row.seq,
        at: row.created_at,
        agent_handle: row.agent_handle ?? "",
        brain: str(span["brain"]),
        planned: num(span["swamp.actions.planned"]),
        ran: num(span["swamp.actions.ran"]),
        failed: num(span["swamp.actions.failed"]),
        dropped: num(span["swamp.dropped"]),
        degraded: "swamp.degraded" in span ? str(span["swamp.degraded"]) : undefined,
        rules,
      };
    })
    .sort((a, b) => a.seq - b.seq);
}

/** The newest span sequence in the log, which is what a refutation needs to be newer than. */
export async function newestSpanSeq(sb: SupabaseClient): Promise<number> {
  const { data } = await sb.from("events").select("seq").eq("topic", "pulse.span").order("seq", { ascending: false }).limit(1).maybeSingle();
  return Number((data as { seq: number } | null)?.seq ?? 0) || 0;
}

/** Every lesson, newest first, with a bound so a public door cannot be made to read a corpus. */
export async function readLessons(sb: SupabaseClient, limit = 200): Promise<Lesson[]> {
  const { data } = await sb
    .from("lessons")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 500));
  return (data as Lesson[] | null) ?? [];
}

/**
 * Write a proposed lesson, or report that this exact one already exists.
 *
 * The uniqueness is `(kind, subject, evidence_hash)`, so the database is what stops every
 * resident proposing the same silent rule on every wake. `ignoreDuplicates` makes the
 * insert return no row in that case, which the caller reads as "already on the record" and
 * uses as its own pacing rather than a counter.
 */
export async function proposeLesson(
  sb: SupabaseClient,
  input: { candidate: LessonCandidate; agentId: string },
): Promise<Lesson | null> {
  const { candidate, agentId } = input;
  const { data, error } = await sb
    .from("lessons")
    .insert({
      kind: candidate.kind,
      subject: candidate.subject,
      statement: candidate.statement,
      evidence: candidate.evidence,
      evidence_hash: lessonEvidenceHash(candidate.kind, candidate.subject, candidate.evidence),
      confidence: candidate.confidence,
      status: "proposed",
      proposed_by: agentId,
    })
    .select("*");
  if (error) return null;
  const row = (data as Lesson[] | null)?.[0] ?? null;
  return row;
}

/**
 * Record a decision, and only if the lesson is still open and the decider is not its author.
 *
 * Both conditions are in the WHERE clause rather than checked beforehand, because a check
 * followed by an update is a race and this record is the one place where who decided matters.
 * A matched row is returned, and no row means the decision was already taken or the decider
 * wrote the lesson, either of which is a refusal the caller reports rather than papers over.
 */
export async function decideLesson(
  sb: SupabaseClient,
  input: {
    lessonId: string;
    deciderId: string;
    decision: "adopt" | "refute";
    reason: string;
    now: string;
  },
): Promise<Lesson | null> {
  const { data, error } = await sb
    .from("lessons")
    .update({
      status: input.decision === "adopt" ? "adopted" : "refuted",
      adopted_by: input.deciderId,
      decided_at: input.now,
      decision_note: input.reason,
      updated_at: input.now,
    })
    .eq("id", input.lessonId)
    .eq("status", "proposed")
    .neq("proposed_by", input.deciderId)
    .select("*");
  if (error) return null;
  return (data as Lesson[] | null)?.[0] ?? null;
}
