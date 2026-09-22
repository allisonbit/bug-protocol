import type { McpTool } from "./tools";
import { supabaseAdmin } from "@/lib/supabase";
import { readLessons } from "@/lib/swamp/lesson-store";
import {
  LESSON_KIND_MEANING,
  LESSON_STATUSES,
  type Lesson,
  type LessonKind,
  type LessonStatus,
} from "@/lib/swamp/lessons";

/**
 * WHAT THIS DEPLOYMENT HAS CONCLUDED ABOUT ITS OWN BEHAVIOUR, AT THE SIZE OF A TOOL CALL.
 *
 * WHY THIS IS A TOOL AND NOT ONLY A PAGE. An agent deciding what to do next is entitled to
 * know what this habitat has already measured about itself: which reflex rules never fire,
 * which ones fire and land nothing, and which residents keep falling back from their model
 * brains to their deterministic path. That is operational context about the place it is
 * working in, and without it an agent would rediscover the same dead rule on every wake.
 *
 * WHAT IT HANDS OVER. The sentence, and the evidence hash and event sequence numbers behind
 * it. Not the window itself: the hundreds of spans a lesson was counted from are on the log
 * already, and a tool that pasted them into a context would be a tool that spends an agent's
 * budget on arithmetic it can ask for again. The citations are what make the claim checkable.
 *
 * READ ONLY, and it has to be. Lessons are proposed and settled inside the pulse, by a
 * resident with an agent identity, because a decision recorded here would have no author and
 * a lesson nobody wrote is exactly the kind of claim this layer exists to refuse.
 */

const NO_BACKEND =
  "The swamp backend is not configured on this deployment, so there is no lesson record to read.";

function str(v: unknown, cap = 200): string {
  return typeof v === "string" ? v.trim().slice(0, cap) : "";
}

function line(l: Lesson): string {
  const seqs = l.evidence?.seqs ?? [];
  const decided = l.status === "proposed" ? "waiting on a decider" : `${l.status} ${l.decided_at ? `at ${l.decided_at}` : ""}`.trim();
  return (
    `- [${l.kind}] ${l.subject}: ${l.statement}\n` +
    `  status: ${l.kind === "brain_degraded" ? "about an agent" : "about a rule"} ${l.status} (${decided}), confidence ${l.confidence}\n` +
    `  counted from ${l.evidence?.beats ?? 0} beat(s) in the window; sequence ${seqs.slice(0, 8).join(", ")}${seqs.length > 8 ? `, and ${seqs.length - 8} more` : ""}\n` +
    `  evidence hash: ${l.evidence_hash}`
  );
}

export const LESSON_TOOLS: McpTool[] = [
  {
    name: "read_lessons",
    title: "Read what this deployment concluded about its own behaviour",
    description:
      "Sentences this habitat has written about its own behaviour, each counted from its own pulse spans and carrying the event sequence numbers and evidence hash it came from. Three patterns are noticed: a reflex rule that did not fire in the window, a rule that fired and whose every planned action failed or was dropped, and an agent whose model brain degraded repeatedly. An adopted lesson is one a second resident recounted and confirmed, and it is the only kind shown to a resident's own reasoning; a proposed one is a claim still waiting for somebody who did not write it. Read only, and this is not learning: no weight, prompt or rule condition is changed by any lesson.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "proposed, adopted, refuted or retired. Omitted means every status." },
        subject: { type: "string", description: "A rule id, or an agent handle for a lesson about a degraded brain." },
        limit: { type: "integer", description: "How many lessons, 1 to 100. Default 25." },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const sb = ctx.admin ?? supabaseAdmin();
      if (!sb) return { text: NO_BACKEND };
      const status = str(args.status, 20);
      const subject = str(args.subject, 80);
      const limitRaw = Number(args.limit ?? 25);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 100) : 25;

      const all = await readLessons(sb, 500);
      const filtered = all
        .filter((l) => (status && LESSON_STATUSES.includes(status as LessonStatus) ? l.status === status : true))
        .filter((l) => (subject ? l.subject === subject : true))
        .slice(0, limit);

      if (filtered.length === 0) {
        return {
          text:
            `No lesson on this record matches that. ${all.length} lesson(s) exist in total` +
            `${all.length === 0 ? ", which means the deployment has not noticed a pattern strong enough to write down yet" : ""}.`,
          data: { total: all.length, returned: 0 },
        };
      }

      const adopted = filtered.filter((l) => l.status === "adopted").length;
      return {
        text:
          `${filtered.length} lesson(s) of ${all.length} on the record, ${adopted} of them adopted and therefore in force. ` +
          `Kinds: ${Object.entries(LESSON_KIND_MEANING)
            .map(([k, v]) => `${k} (${v})`)
            .join("; ")}.\n\n` +
          filtered.map(line).join("\n\n") +
          `\n\nA lesson is evidence rather than behaviour. Nothing here changes a weight, a prompt or a rule condition, ` +
          `and only an adopted one is ever read by a resident's reasoning.`,
        data: {
          total: all.length,
          returned: filtered.length,
          lessons: filtered.map((l) => ({
            id: l.id,
            kind: l.kind as LessonKind,
            subject: l.subject,
            statement: l.statement,
            confidence: l.confidence,
            status: l.status,
            evidence: l.evidence,
            evidence_hash: l.evidence_hash,
            decided_at: l.decided_at,
            decision_note: l.decision_note,
          })),
        },
      };
    },
  },
];
