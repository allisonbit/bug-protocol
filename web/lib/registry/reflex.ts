import { capabilityForTopic, type GapRow } from "./gaps";

/**
 * THE REGISTRY AS SOMETHING A RESIDENT DOES, RATHER THAN SOMETHING A PAGE SHOWS.
 *
 * Two acts come out of the mirror, and both are bounded here rather than in the rules that
 * fire them, for the same reason `lib/audit/candidates.ts` exists: a rule that reads a
 * cooldown and a dedupe guard has to be testable without a swarm, a database or a clock.
 *
 *   - REPORT A GAP. The largest topic the outside world publishes under and this deployment
 *     has no capability for gets one board entry naming the count, the documents and their
 *     verdicts. This is work being created out of a measurement, and the board is where the
 *     swarm already looks for work.
 *   - CITE A SKILL. A published skill that does something one of this deployment's own
 *     capabilities does, and that this deployment's own engine judged clean, is recorded
 *     against that capability. A citation is a row, never a copy: nothing is ever lifted out
 *     of one of these documents into this platform's code, prompts or skills.
 *
 * WHY BOTH ARE PACED, AND WHY THE GAP ONE IS PACED HARDEST. The mirror holds thousands of
 * topics, and a rule with no cooldown would put one board entry per resident per wake onto a
 * board that is forty entries deep, which is the repetition flood this platform has already
 * been burned by once. Six hours between gap reports means a few a day at most, which is
 * what "the swarm found something it cannot do" deserves: enough to be worked, not enough to
 * bury the board.
 *
 * AND WHY THE GAP IS DEDUPED BY A ROW RATHER THAN BY THIS NOTE. `reported_at` on the topic
 * rollup is a row state, so a topic once reported stays reported even if every note in the
 * system were lost. The cooldown here is only pacing. This codebase has shipped the other
 * arrangement twice (a digest key nobody read published 1,076 copies of one sentence), and
 * the fix is always the same: the guard is a row, the note is a rate limit.
 */

/** The shared note that records the last gap a resident reported. */
export const GAP_NOTE_KEY = "registry:last";

/** The shared note that records the last citation a resident wrote. */
export const CITE_NOTE_KEY = "cite:last";

/**
 * How long the swarm leaves gap reporting alone after doing one.
 *
 * Six hours, which is between four and eight reports a day across the whole swarm however
 * many residents are awake. The cost of waiting is that a queue drains slowly, and the queue
 * here is a list of things nobody can do yet, which is not urgent in the way a reading
 * outside its band is.
 */
export const GAP_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * And for citations, which are cheaper but far more numerous.
 *
 * Two hours, because a citation writes one row and one bus event and is bounded by the
 * number of mirrored skills that match a capability this deployment already has. It paces
 * the log without making the list take weeks to fill.
 */
export const CITE_COOLDOWN_MS = 2 * 60 * 60 * 1000;

/** As much of a mirrored row as the citation decision needs. */
export type CitationRow = {
  ref: string;
  topics: string[] | null;
  stats: Record<string, unknown> | null;
  swamp_verdict: string | null;
  clawhub_verdict: string | null;
  blocked: boolean | null;
  cited_at: string | null;
  digest?: string | null;
  capability?: string | null;
};

/**
 * The capability a mirrored skill can be cited against, or null.
 *
 * Only a skill this deployment's own engine judged clean or barely-annotated is eligible,
 * and only for a capability that exists in its own manifest. A citation against a skill our
 * own audit called risky would be endorsing something we said was risky, which is the one
 * thing this record must never be caught doing.
 */
export function citationFor(row: CitationRow): { ref: string; capability: string; topic: string; installs: number } | null {
  if (row.blocked) return null;
  if (row.cited_at) return null;
  if (row.swamp_verdict !== "clean" && row.swamp_verdict !== "notes") return null;
  for (const topic of row.topics ?? []) {
    const capability = capabilityForTopic(topic);
    if (capability) {
      const raw = row.stats && typeof row.stats === "object" ? (row.stats as Record<string, unknown>).installs : null;
      const n = typeof raw === "number" ? raw : Number(raw);
      return {
        ref: row.ref,
        capability,
        topic: topic.trim(),
        installs: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0,
      };
    }
  }
  return null;
}

/**
 * Rank the eligible citations, most installed first, ties by ref.
 *
 * Deterministic for the same reason the triage order is: two residents waking in the same
 * beat have to be able to agree on what the best candidate is, or the swarm cites whatever
 * happened to be read first.
 */
export function rankCitations(rows: CitationRow[]): { ref: string; capability: string; topic: string; installs: number }[] {
  return rows
    .map(citationFor)
    .filter((c): c is { ref: string; capability: string; topic: string; installs: number } => c !== null)
    .sort((a, b) => (a.installs !== b.installs ? b.installs - a.installs : a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

/** The value written to `registry:last` after a gap is reported. */
export function gapNoteValue(input: { topic: string; skills: number }, at: string) {
  return { topic: input.topic, skills: input.skills, at };
}

/** The value written to `cite:last` after a citation is written. */
export function citeNoteValue(input: { ref: string; capability: string }, at: string) {
  return { ref: input.ref, capability: input.capability, at };
}

/** Is the swarm allowed to report another gap yet? */
export function gapCooldownElapsed(lastReportedAt: string | null, now: string, cooldownMs: number = GAP_COOLDOWN_MS): boolean {
  if (!lastReportedAt) return true;
  const since = Date.parse(now) - Date.parse(lastReportedAt);
  return !Number.isFinite(since) || since < 0 || since >= cooldownMs;
}

/** The same question for a citation. */
export function citeCooldownElapsed(lastCitedAt: string | null, now: string, cooldownMs: number = CITE_COOLDOWN_MS): boolean {
  if (!lastCitedAt) return true;
  const since = Date.parse(now) - Date.parse(lastCitedAt);
  return !Number.isFinite(since) || since < 0 || since >= cooldownMs;
}

/**
 * The one gap a resident may report right now, given the clock and what is already reported.
 *
 * Generic over the row type rather than pinned to `GapRow`, because the caller carries more
 * than the counts: the observation hands over the documents each gap is made of, and a
 * function that widened its answer back to the bare row would make the caller lose them at
 * exactly the point it needs to name them.
 */
export function pickGapToReport<T extends GapRow>(input: { gaps: T[]; lastReportedAt: string | null; now: string; cooldownMs?: number }): T | null {
  if (!gapCooldownElapsed(input.lastReportedAt, input.now, input.cooldownMs)) return null;
  return input.gaps[0] ?? null;
}
