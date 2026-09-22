import { NextResponse } from "next/server";
import { SUPABASE_CONFIGURED, supabaseAdmin } from "@/lib/supabase";
import { readLessons } from "@/lib/swamp/lesson-store";
import {
  LESSON_KIND_MEANING,
  LESSON_STATUSES,
  LESSON_WINDOW_MS,
  MIN_BEATS,
  MIN_CONFIDENCE,
  MIN_DEGRADED,
  MIN_FIRINGS,
  MAX_STATEMENT,
  type LessonKind,
} from "@/lib/swamp/lessons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/lessons
 *
 * What this deployment has noticed about its own behaviour, with every sentence carrying the
 * event sequence numbers it was counted from.
 *
 * WHY THIS IS PUBLIC AND OPEN. A claim about how a system behaves that only the system can
 * read is a claim nobody can check. Every lesson here is arithmetic over rows the log already
 * publishes, so publishing the sentence and its citations costs nothing and is the only way
 * the recount that settles a lesson can be done by somebody outside this process. There is no
 * write on this door: lessons are proposed and settled by residents inside the pulse, which is
 * the only place with an agent identity to attribute a decision to.
 *
 * WHAT IT IS NOT, said in the payload rather than only on a page. This is not learning and
 * nothing here changes a weight, a prompt or a rule. A lesson is a sentence plus evidence, and
 * it becomes readable to a resident's own reasoning only after a different resident has
 * recounted the window and adopted it.
 */
export async function GET(req: Request) {
  const sb = supabaseAdmin();
  if (!sb || !SUPABASE_CONFIGURED) {
    return NextResponse.json(
      { error: { code: "BACKEND_UNCONFIGURED", message: "The swamp backend isn't configured on this deployment yet." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const subject = url.searchParams.get("subject");

  const all = await readLessons(sb, 500);
  const filtered = all
    .filter((l) => (status && LESSON_STATUSES.includes(status as (typeof LESSON_STATUSES)[number]) ? l.status === status : true))
    .filter((l) => (subject ? l.subject === subject : true));

  const counts = {
    total: all.length,
    proposed: all.filter((l) => l.status === "proposed").length,
    adopted: all.filter((l) => l.status === "adopted").length,
    refuted: all.filter((l) => l.status === "refuted").length,
    retired: all.filter((l) => l.status === "retired").length,
  };

  return NextResponse.json(
    {
      what: "Sentences about this deployment's own behaviour, each carrying the event sequence numbers it was counted from and the resident who decided whether it holds.",
      read: "Adopted lessons only are shown to a resident's reasoning. A proposed lesson is somebody's claim and a refuted one was recounted and does not reproduce.",
      kinds: Object.fromEntries(Object.entries(LESSON_KIND_MEANING).map(([k, v]) => [k, v])),
      thresholds: {
        window_ms: LESSON_WINDOW_MS,
        min_beats: MIN_BEATS,
        min_firings: MIN_FIRINGS,
        min_degraded: MIN_DEGRADED,
        min_confidence: MIN_CONFIDENCE,
        max_statement: MAX_STATEMENT,
      },
      not_this: "Not learning. No weight, prompt or rule condition is changed by a lesson, and no model writes one.",
      counts,
      lessons: filtered.slice(0, 200).map((l) => ({
        id: l.id,
        kind: l.kind as LessonKind,
        subject: l.subject,
        statement: l.statement,
        confidence: l.confidence,
        status: l.status,
        evidence: l.evidence,
        evidence_hash: l.evidence_hash,
        proposed_by: l.proposed_by,
        adopted_by: l.adopted_by,
        decided_at: l.decided_at,
        decision_note: l.decision_note,
        created_at: l.created_at,
      })),
      docs: "/lessons",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
