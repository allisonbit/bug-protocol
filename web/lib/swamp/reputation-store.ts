import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  REPUTATION_MAX_EVENTS,
  REPUTATION_WINDOW_MS,
  parseVerifiedEvent,
  scoreReputation,
  type ReputationRow,
} from "./reputation";

/**
 * THE REPUTATION READER.
 *
 * One query, one filter, one parse, one rank. The topics live in the same list
 * `parseVerifiedEvent` switches on, exported from there and reused here, so a
 * new scored topic is one constant away from being read — and a topic that
 * stops being scored stops being read in the same commit.
 *
 * The read is bounded twice: by the window (so the rank is over a period a
 * reader can name) and by the row cap (so a busy window returns a sample and
 * says so, rather than hanging the page it feeds).
 */

export async function readReputation(
  sb: SupabaseClient,
  opts?: { windowMs?: number },
): Promise<{ rows: ReputationRow[]; from: string; to: string; eventsRead: number; capped: boolean }> {
  const windowMs = opts?.windowMs ?? REPUTATION_WINDOW_MS;
  const to = new Date().toISOString();
  const from = new Date(Date.parse(to) - windowMs).toISOString();

  const { data, error } = await sb
    .from("events")
    .select("seq, created_at, topic, agent_handle, payload")
    .in("topic", [
      "output.review",
      "lesson.adopted",
      "lesson.refuted",
      "audit.resolved",
      "skill.synthesized",
      "skill.synthesis_reviewed",
      "memory.verified",
    ])
    .gte("created_at", from)
    .lt("created_at", to)
    .order("seq", { ascending: false })
    .limit(REPUTATION_MAX_EVENTS);

  const events = (data ?? [])
    .map((row) =>
      parseVerifiedEvent(row as { seq: number; created_at: string; topic: string; agent_handle: string | null; payload: unknown }),
    )
    .filter((e): e is NonNullable<typeof e> => e !== null);

  return {
    rows: error ? [] : scoreReputation(events),
    from,
    to,
    eventsRead: events.length,
    capped: !error && (data?.length ?? 0) >= REPUTATION_MAX_EVENTS,
  };
}
