/**
 * WHICH PUBLISHED SKILLS THIS DEPLOYMENT READS THE BYTES OF, AND WHY THAT ORDER.
 *
 * THE COST THIS BOUNDS. Mirroring a catalogue is cheap: one request per two hundred
 * skills. Reading them is not, because each one is a separate fetch of somebody else's
 * document from somebody else's server, and this deployment is a guest on it. So fifty
 * thousand skills are not audited in a burst, and the interesting question is not "how
 * many can we get through" but "which ones should we read first".
 *
 * THREE TIERS, IN THIS ORDER, AND EACH ONE IS AN ARGUMENT RATHER THAN A WEIGHT.
 *
 *   1. WHAT THE REGISTRY ITSELF FLAGS. ClawHub runs its own moderation and publishes its
 *      verdict. A skill it calls suspicious is the single most informative document this
 *      deployment could read, because our engine either agrees with a working reviewer or
 *      disagrees with one, and both of those answers are worth publishing. Reading the
 *      suspicious ones last would be looking away from the only rows where a second opinion
 *      changes anybody's decision.
 *   2. A TOPIC THIS DEPLOYMENT CANNOT DO. If the outside world is full of skills for
 *      something this platform has no capability for, those documents are what the gap is
 *      made of, and a verdict on them is what turns "we do not do this" into something a
 *      reader can act on.
 *   3. EVERYTHING ELSE, by installs, because popularity is the honest proxy for what the
 *      ecosystem actually runs. A skill nobody installed is still worth a verdict if
 *      nothing else is waiting, which is what makes this a complete sweep over time rather
 *      than a popularity contest.
 *
 * Ties are broken by ref, ascending, so two passes over the same rows choose the same
 * documents. That matters more than it looks: an order that drifted between passes would
 * make "which skills have we judged" depend on luck, and the coverage number on the
 * registry page would be reporting a race.
 *
 * PURE. No fetch, no database, no clock. `scripts/verify-registry-triage.cjs` exercises the
 * tiers, the tie-break and the exclusions with fixtures.
 */

/** How many documents one pass reads. Five fetches is a polite guest. */
export const TRIAGE_PER_PASS = 5;

/** The most documents one pass may be asked to read, whatever the caller says. */
export const TRIAGE_MAX = 50;

/** As much of a mirrored row as the decision needs. */
export type TriageRow = {
  ref: string;
  topics: string[] | null;
  stats: Record<string, unknown> | null;
  clawhub_verdict: string | null;
  /** Already audited, already blocked, or already cited: none of them are candidates. */
  swamp_verdict?: string | null;
  blocked?: boolean | null;
  cited_at?: string | null;
};

export type TriageTier = "registry-flagged" | "uncovered-topic" | "popular";

export type TriagePick = {
  ref: string;
  tier: TriageTier;
  /** The reason that goes on the record and into the audit's subject line. */
  why: string;
  installs: number;
  topic: string | null;
};

/** Installs as a number, or zero when the registry did not publish one. */
export function installsOf(row: TriageRow): number {
  const raw = row.stats && typeof row.stats === "object" ? (row.stats as Record<string, unknown>).installs : null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The first topic on a row that is in the uncovered set, or null. */
function uncoveredTopicOf(row: TriageRow, uncovered: Set<string>): string | null {
  for (const topic of row.topics ?? []) {
    const key = topic.trim().toLowerCase();
    if (key && uncovered.has(key)) return topic.trim();
  }
  return null;
}

/** Rows that are already somebody's finished work, or that we may not serve anyway. */
export function isCandidate(row: TriageRow): boolean {
  if (row.blocked) return false;
  if (row.swamp_verdict) return false;
  return typeof row.ref === "string" && row.ref.includes("/");
}

/**
 * The documents this pass reads, in the order it reads them.
 *
 * `limit` is clamped rather than trusted, because the caller is a query string on a door
 * that can be driven by a scheduler.
 */
export function pickForTriage(
  rows: TriageRow[],
  input: { uncovered: Set<string>; limit?: number },
): TriagePick[] {
  const limit = Math.min(Math.max(Math.floor(input.limit ?? TRIAGE_PER_PASS), 1), TRIAGE_MAX);
  const ranked: { pick: TriagePick; tier: number }[] = [];

  for (const row of rows) {
    if (!isCandidate(row)) continue;
    const installs = installsOf(row);
    const topic = uncoveredTopicOf(row, input.uncovered);
    const flagged = row.clawhub_verdict === "suspicious";

    if (flagged) {
      // A flagged skill that also sits in an uncovered topic says both things, and the
      // reason names the flag because that is what put it first.
      ranked.push({
        pick: {
          ref: row.ref,
          tier: "registry-flagged",
          why:
            `ClawHub's own moderation flags it as suspicious${topic ? `, and it is in "${topic}", a topic this deployment has no capability for` : ""}` +
            `${row.clawhub_verdict === "blocked" ? "" : ""}`,
          installs,
          topic,
        },
        tier: 0,
      });
      continue;
    }
    if (topic) {
      ranked.push({
        pick: {
          ref: row.ref,
          tier: "uncovered-topic",
          why: `it is in "${topic}", a topic this deployment has no capability for`,
          installs,
          topic,
        },
        tier: 1,
      });
      continue;
    }
    ranked.push({
      pick: {
        ref: row.ref,
        tier: "popular",
        why: `nothing more pressing is waiting, and it has been installed ${installs} time(s)`,
        installs,
        topic: null,
      },
      tier: 2,
    });
  }

  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.pick.installs !== b.pick.installs) return b.pick.installs - a.pick.installs;
    return a.pick.ref < b.pick.ref ? -1 : a.pick.ref > b.pick.ref ? 1 : 0;
  });

  return ranked.slice(0, limit).map((r) => r.pick);
}

/**
 * The subject an audit of a mirrored skill is recorded under.
 *
 * A steady, prefixed form rather than the document's own address, because this record is
 * keyed by subject and a subject that changed shape would let the same document be audited
 * twice. It also means the audit record for the registry is one indexed read rather than a
 * scan of URLs belonging to a host this deployment does not own.
 */
export function auditSubjectOf(ref: string): string {
  return `registry:${ref}`;
}

/** The ref back out of a subject, or null when it is some other document's. */
export function refFromSubject(subject: string | null | undefined): string | null {
  if (typeof subject !== "string" || !subject.startsWith("registry:")) return null;
  const ref = subject.slice("registry:".length);
  return ref.includes("/") ? ref : null;
}
