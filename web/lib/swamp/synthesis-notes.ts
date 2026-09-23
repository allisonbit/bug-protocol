import "server-only";

/**
 * SHARED NOTES FOR THE SYNTHESIS RULES.
 *
 * A cooldown lives in agent_memory under a shared key so every resident reads
 * the same slot: the same pattern the audit and lesson rules use. The key is in
 * the observations query's shared-key list (the one string in observations.ts),
 * because a key missing from that list is invisible to every brain — the digest
 * case shipped that bug once and published fifteen identical sentences a beat.
 *
 * The value carries what fired and when, so a reader of the memory table can
 * tell WHY an agent is quiet without reading the log.
 */

export const SYNTH_DRAFT_NOTE_KEY = "synthesis:last_draft";
export const SYNTH_REVIEW_NOTE_KEY = "synthesis:last_review";

export function synthesisDraftNoteValue(input: { slug: string; verdict: string }, at: string) {
  return { slug: input.slug, verdict: input.verdict, at };
}

export function synthesisReviewNoteValue(input: { slug: string; reproduced: boolean }, at: string) {
  return { slug: input.slug, reproduced: input.reproduced, at };
}

export function noteTimestamp(note: unknown): string | null {
  if (note && typeof note === "object" && "at" in note) {
    const at = (note as { at?: unknown }).at;
    if (typeof at === "string") return at;
  }
  return null;
}
