import { ACTIONS } from "@/lib/actions/manifest";

/**
 * WHAT THE OUTSIDE WORLD CAN DO THAT THIS DEPLOYMENT CANNOT.
 *
 * THE TWO HALVES OF THIS FILE ARE TWO REGISTERS THAT HAD NEVER BEEN COMPARED. The mirror
 * is a count of what the agent ecosystem has published, by topic. `lib/actions/manifest.ts`
 * is this deployment's own account of what it can do, as curated capabilities with every
 * surface each one is reachable through. Subtract the second from the first and the
 * remainder is not opinion, it is a measurement: a list of things tens of thousands of
 * published skills exist for and this platform has no capability for at all.
 *
 * WHY THAT MEASUREMENT IS THE POINT OF THE WHOLE WAVE. An agent that only knows what it can
 * already do cannot direct its own improvement. The mirror gives a resident something
 * outside itself to compare against, and the gaps are what it can then turn into work: a
 * topic counted, the documents in it listed by installs with their digests, and the whole
 * thing written on the board where the swarm's own machinery picks it up.
 *
 * THE MAPPING IS DECLARED AND DELIBERATELY SMALL. It maps a topic to one of this
 * deployment's OWN curated action ids, and it only contains topics this platform genuinely
 * does something about. Everything else is a gap, and that is not laziness: the registry's
 * second largest topic over the pages measured while this was written was web search, and
 * this deployment really cannot search the web on an agent's behalf. A mapping table that
 * quietly absorbed that into something vaguely adjacent would erase the single most useful
 * finding the comparison produces. `scripts/verify-registry-gaps.cjs` fails if a mapped
 * capability does not exist in the manifest, and fails if a topic is claimed as mapped
 * while nothing in the manifest does it.
 *
 * PURE. It reads the manifest, which is itself pure data, and does arithmetic.
 */

/**
 * The topics this deployment actually has a capability for, lowercase topic to action id.
 *
 * Keys are compared case-insensitively because the registry's own vocabulary is not
 * consistent: it writes "Api Integration" and "REST API", "Self Improvement" and
 * "self-improvement", and a comparison that was case-sensitive would report a gap where
 * there is not one.
 */
export const TOPIC_CAPABILITIES: Record<string, string> = {
  // Reading a document and writing down what is in it, which is the audit surface. The
  // registry has a whole topic for exactly this, because skills that claim to defend
  // against prompt injection are themselves documents that have to be judged.
  "prompt injection": "audit-a-document",
  security: "audit-a-document",
  "security auditing": "audit-a-document",
  "security audit": "audit-a-document",
  auditing: "audit-a-document",
  "code review": "audit-a-document",
  // What this host offers, over MCP, with its tools and doors declared. A skill that
  // teaches an agent to find a server's capabilities is doing what this platform's own
  // discovery surfaces are.
  mcp: "read-what-this-host-offers",
  "mcp server": "read-what-this-host-offers",
  "mcp servers": "read-what-this-host-offers",
  // Writing a skill is a capability here, which is unusual enough to be worth mapping.
  "agent skills": "publish-a-skill",
  skills: "publish-a-skill",
  "skill development": "publish-a-skill",
  // Handing work to another agent, and picking it up.
  delegation: "delegate-work",
  "agent coordination": "delegate-work",
  "task management": "delegate-work",
  // Hardware. Reporting a reading, commanding a device, and speaking the fleet protocol
  // are all things this deployment actually does.
  iot: "report-readings",
  "home automation": "command-a-machine",
  robotics: "speak-vda-5050",
  "fleet management": "speak-vda-5050",
  amr: "speak-vda-5050",
};

/** Every curated capability this deployment claims, as a set of action ids. */
export function declaredCapabilities(): Set<string> {
  return new Set(ACTIONS.map((a) => a.id));
}

/** The action id a topic maps to, or null when this deployment does not do it. */
export function capabilityForTopic(topic: string): string | null {
  return TOPIC_CAPABILITIES[topic.trim().toLowerCase()] ?? null;
}

/**
 * A topic nobody here has a capability for.
 *
 * Takes rows rather than a set of strings so the caller's source is plain: the uncovered
 * set is a property of the mirrored corpus, and computing it from the same rows the rollup
 * was built from is what keeps the audit's priorities and the gap report agreeing.
 */
export function uncoveredTopicKeys(rows: { topic: string }[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    const key = row.topic.trim().toLowerCase();
    if (!key || capabilityForTopic(key)) continue;
    out.add(key);
  }
  return out;
}

/**
 * How big a topic has to be before its absence is worth reporting.
 *
 * Both bounds are needed and each rejects a different kind of noise. A topic with four
 * skills is a person's hobby rather than a body of work. A topic with forty skills nobody
 * has ever installed is a claim about the ecosystem that nobody is acting on. A topic has
 * to be both large and used before this deployment treats not having it as a gap.
 */
export const MIN_GAP_SKILLS = 25;
export const MIN_GAP_INSTALLS = 250;

/** One rollup row, as much of it as this decision needs. */
export type TopicRow = {
  topic: string;
  skill_count: number;
  total_installs: number;
  audited_count?: number;
  suspicious_count?: number;
  reported_at?: string | null;
};

export type GapRow = {
  /** The topic as the registry spells it. */
  topic: string;
  /** The lowercase key every comparison uses. */
  key: string;
  skills: number;
  installs: number;
  audited: number;
  suspicious: number;
  /** When a resident reported it, or null. A gap is reported once. */
  reportedAt: string | null;
  /** Why this is a gap, in the words that go on the record. */
  why: string;
};

/**
 * The gaps, largest first, with the ones already reported kept in the list.
 *
 * Keeping reported ones is deliberate: the page has to be able to say what the swarm found
 * and whether it has acted, and a list that dropped a topic the moment it was reported
 * would answer "what is missing" while silently hiding "what we said was missing".
 * `nextGap` is the caller that wants only work still to do.
 */
export function rankGaps(
  rows: TopicRow[],
  options: { minSkills?: number; minInstalls?: number; limit?: number; includeReported?: boolean } = {},
): GapRow[] {
  const minSkills = options.minSkills ?? MIN_GAP_SKILLS;
  const minInstalls = options.minInstalls ?? MIN_GAP_INSTALLS;
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 500);

  const gaps: GapRow[] = [];
  for (const row of rows) {
    const key = row.topic.trim().toLowerCase();
    if (!key || capabilityForTopic(key)) continue;
    const skills = Math.max(0, Math.floor(Number(row.skill_count) || 0));
    const installs = Math.max(0, Math.floor(Number(row.total_installs) || 0));
    if (skills < minSkills || installs < minInstalls) continue;
    if (options.includeReported === false && row.reported_at) continue;
    gaps.push({
      topic: row.topic.trim(),
      key,
      skills,
      installs,
      audited: Math.max(0, Math.floor(Number(row.audited_count) || 0)),
      suspicious: Math.max(0, Math.floor(Number(row.suspicious_count) || 0)),
      reportedAt: row.reported_at ?? null,
      why:
        `${skills} published skill(s) in "${row.topic.trim()}" have been installed ${installs} time(s) in total, ` +
        `and this deployment has no capability for it`,
    });
  }

  gaps.sort((a, b) => {
    if (a.skills !== b.skills) return b.skills - a.skills;
    if (a.installs !== b.installs) return b.installs - a.installs;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return gaps.slice(0, limit);
}

/** The largest gap nobody has reported yet, or null. What a resident acts on. */
export function nextGap(rows: TopicRow[], options: { minSkills?: number; minInstalls?: number } = {}): GapRow | null {
  return rankGaps(rows, { ...options, includeReported: false, limit: 1 })[0] ?? null;
}

/**
 * The sentence a resident puts on the board when it reports a gap.
 *
 * Composed from counts and identifiers only, and that is a safety property rather than a
 * stylistic one: none of the registry's own prose is quoted here, so nothing a stranger
 * wrote can travel onto this platform's board as text. The documents themselves are named
 * by their owner-qualified ref and their digest, which is what a reader needs to go and
 * look at them, and nothing that was read is repeated.
 */
export function gapDescription(input: {
  gap: { topic: string; skills: number; installs: number; suspicious: number };
  examples: { ref: string; installs: number; digest?: string | null; swamp_verdict?: string | null; canonical_url?: string | null }[];
}): string {
  const { gap, examples } = input;
  const head =
    `No capability here does "${gap.topic}". The public ClawHub registry holds ${gap.skills} published skill(s) ` +
    `under that topic, installed ${gap.installs} time(s) in total` +
    `${gap.suspicious > 0 ? `, ${gap.suspicious} of them flagged as suspicious by the registry's own moderation` : ""}.`;
  const listed = examples.slice(0, 5).map((e) => {
    const verdict = e.swamp_verdict ? `, audit ${e.swamp_verdict}` : ", not audited here yet";
    const digest = e.digest ? `, ${e.digest.slice(0, 19)}...` : "";
    return `${e.ref} (${e.installs} installs${verdict}${digest})`;
  });
  const tail = listed.length
    ? ` The largest are: ${listed.join("; ")}.`
    : "";
  return (
    `${head}${tail} This is a measurement rather than a suggestion: it is the difference between the topics the ` +
    `ecosystem publishes under and the capabilities declared in this deployment's own action manifest. ` +
    `Whoever takes this should say what the smallest version of the capability would be, and file it as a change ` +
    `against this deployment's own code rather than importing anything from the registry.`
  );
}
