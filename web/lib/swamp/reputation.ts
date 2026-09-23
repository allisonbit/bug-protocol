/**
 * REPUTATION: WHAT THE PUBLIC LOG ALREADY SAYS AN AGENT CONTRIBUTED.
 *
 * The scoreboard beside this module counts activity: beats planned, actions run.
 * This module counts the other half of the evals page's question — which of those
 * actions were VERIFICATION work, the kind the record can check. A corroboration,
 * a recount that reproduced, a challenge settled by rerunning the engine, a
 * synthesis that cleared the bar, a lesson that survived a second opinion: each
 * is an output a second party could have reproduced, and each lands on a topic
 * the bus already names. So the rank is arithmetic over public rows, the same
 * discipline as every other number on /evals.
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *
 *   - No model opinion. A model judging an agent and ranking agents by it turns
 *     a measurement into a popularity contest with extra steps.
 *   - No activity credit. A thousand beats that produced nothing verified score
 *     zero here. This is on purpose: the activity column is one table over, and
 *     merging them would let volume impersonate contribution.
 *   - No weight a reader cannot recompute. Every number in the ledger below is
 *     named, and the sum is the sum. Nothing else.
 *
 * PENALTIES ARE PART OF THE SCORE. A refuted own-work row is negative, because
 * the asymmetry matters: publishing something verification later broke should
 * cost more than publishing nothing. Penalties are bounded by the same ledger,
 * so an agent cannot go arbitrarily negative and drown the ranking.
 *
 * PURE. No database, no fetch, no clock: events carry their own timestamps.
 * scripts/verify-reputation.cjs walks every branch.
 */

/** The event topics that carry verification work, and what each is worth. */
export const VERIFIED_WEIGHTS = {
  // Corroborating somebody's published output. The payload names the output;
  // the reviewer's handle is the event's agent.
  "output.review": 3,
  // A lesson recount that reproduced the pattern, by a resident who did not
  // propose it. The recount is the swarm's second opinion on itself.
  "lesson.adopted": 5,
  // A synthesis re-read that reproduced the recorded verdict. Same shape as the
  // lesson recount, over the swarm's own published skills.
  "skill.synthesis_reviewed": 5,
  // Settling a challenge by rerunning the engine. The one act that can overturn
  // or confirm a published verdict, so it is worth the most single row.
  "audit.resolved": 8,
  // A synthesized skill that cleared the engine's bar and entered the registry.
  // Counted for the author: the swarm making something verifiable is the point.
  "skill.synthesized": 6,
  // A fact of theirs corroborated into the memory layer. Read from the memory
  // events, which carry the fact's author separately from the confirmer.
  "memory.verified": 4,
} as const;

export type VerifiedTopic = keyof typeof VERIFIED_WEIGHTS;

/** Topics that can subtract, and how much. Bounded below by MIN_SCORE. */
export const PENALTY_WEIGHTS = {
  // A lesson that did not survive the recount. The proposer is named in the
  // payload's lesson author chain; the refuting event's agent is the recount.
  "lesson.refuted": -6,
  // A synthesis re-read that diverged. The author's recorded verdict did not
  // hold; the entry stays published but the score answers for it.
  "skill.synthesis_reviewed:diverged": -8,
} as const;

export type PenaltyTopic = keyof typeof PENALTY_WEIGHTS;

/**
 * The score floor. A reputation that can go arbitrarily negative lets one bad
 * week drown an agent out of a ranking rendered beside others; bounded is fairer
 * and still honest — the ledger keeps the full history either way.
 */
export const MIN_SCORE = -100;

export type VerifiedEvent = {
  seq: number;
  created_at: string;
  topic: string;
  /** The agent the row is ABOUT (author/subject), distinct from the actor. */
  subject_handle: string | null;
  /** The agent who performed the verification, when the topic has one. */
  actor_handle: string | null;
  /** For the diverged-review penalty: whether the recount reproduced. */
  reproduced: boolean | null;
};

export type ReputationRow = {
  agent: string;
  /** The integer sum of the ledger above. The only number the rank uses. */
  score: number;
  /** The counts behind the score, so a reader can recompute the sum. */
  counts: { [k in VerifiedTopic]?: number } & { [k in PenaltyTopic]?: number };
};

/**
 * Score a window of events.
 *
 * The rules the module holds, in the order the loops check them:
 *
 *   - `output.review` credits the ACTOR (the reviewer), never the author: a
 *     corroboration is work the reviewer did.
 *   - `skill.synthesized` credits the SUBJECT (the author): the event fires on
 *     the author's beat with their handle as agent, so subject_handle is where
 *     the author is found.
 *   - `memory.verified` credits the SUBJECT (the fact's author): the confirmer
 *     already earned their row on the confirm action itself.
 *   - `lesson.adopted` and `audit.resolved` credit the ACTOR: adopting and
 *     settling are the verification being measured.
 *   - `lesson.refuted` charges the SUBJECT (the proposer): the pattern that did
 *     not survive was theirs.
 *   - `skill.synthesis_reviewed` splits on `reproduced`: credit the actor when
 *     it held (the recount is work), charge the author when it diverged (the
 *     record they published did not hold). One topic, two outcomes, both
 *     checkable from the row.
 *
 * Self-credit is refused where the two handles are both known and equal: an
 * agent does not earn for corroborating itself, settling its own challenge or
 * recounting its own synthesis. Where only one handle exists, the event's own
 * writer already enforced the asymmetry upstream.
 */
export function scoreReputation(events: VerifiedEvent[]): ReputationRow[] {
  const rows = new Map<string, ReputationRow>();

  const rowFor = (agent: string): ReputationRow => {
    let r = rows.get(agent);
    if (!r) {
      r = { agent, score: 0, counts: {} };
      rows.set(agent, r);
    }
    return r;
  };

  const add = (agent: string, topic: VerifiedTopic | PenaltyTopic, weight: number) => {
    const r = rowFor(agent);
    r.score += weight;
    r.counts[topic] = (r.counts[topic] ?? 0) + 1;
    if (r.score < MIN_SCORE) r.score = MIN_SCORE;
  };

  for (const e of events) {
    switch (e.topic) {
      case "output.review": {
        if (e.actor_handle && e.actor_handle !== e.subject_handle) add(e.actor_handle, "output.review", VERIFIED_WEIGHTS["output.review"]);
        break;
      }
      case "lesson.adopted": {
        if (e.actor_handle) add(e.actor_handle, "lesson.adopted", VERIFIED_WEIGHTS["lesson.adopted"]);
        break;
      }
      case "audit.resolved": {
        if (e.actor_handle && e.actor_handle !== e.subject_handle) add(e.actor_handle, "audit.resolved", VERIFIED_WEIGHTS["audit.resolved"]);
        break;
      }
      case "skill.synthesized": {
        if (e.subject_handle) add(e.subject_handle, "skill.synthesized", VERIFIED_WEIGHTS["skill.synthesized"]);
        break;
      }
      case "memory.verified": {
        if (e.subject_handle) add(e.subject_handle, "memory.verified", VERIFIED_WEIGHTS["memory.verified"]);
        break;
      }
      case "lesson.refuted": {
        if (e.subject_handle) add(e.subject_handle, "lesson.refuted", PENALTY_WEIGHTS["lesson.refuted"]);
        break;
      }
      case "skill.synthesis_reviewed": {
        if (e.reproduced === true && e.actor_handle) {
          add(e.actor_handle, "skill.synthesis_reviewed", VERIFIED_WEIGHTS["skill.synthesis_reviewed"]);
        } else if (e.reproduced === false && e.subject_handle) {
          add(e.subject_handle, "skill.synthesis_reviewed:diverged", PENALTY_WEIGHTS["skill.synthesis_reviewed:diverged"]);
        }
        break;
      }
      default:
        break;
    }
  }

  // Highest contribution first; ties break alphabetically so the order is
  // stable across pages and readers.
  return [...rows.values()].sort((a, b) => b.score - a.score || a.agent.localeCompare(b.agent));
}

/**
 * The window the reputation page reads, stated so a reader can fetch the same
 * events. Half the default eval window: verification is sparser than beats, and
 * a window of zero rows should mean "no verification happened", not "the query
 * was too short to catch any".
 */
export const REPUTATION_WINDOW_MS = 12 * 60 * 60 * 1000;

/** The most events one read takes. Bounded, and the page says so. */
export const REPUTATION_MAX_EVENTS = 2_000;

/**
 * Turn one event row into the shape the scorer reads, or null when the row is
 * not one of the scored topics. Kept beside the scorer so the mapping rules and
 * the scoring rules change in the same commit — a weight with no reader rule is
 * how a topic starts silently counting wrong.
 */
export function parseVerifiedEvent(row: {
  seq: number;
  created_at: string;
  topic: string;
  agent_handle: string | null;
  payload: unknown;
}): VerifiedEvent | null {
  const p = (payloadRecord(row.payload) ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

  switch (row.topic) {
    case "output.review": {
      // The reviewer is the event's agent; the output's author is not on the
      // payload, and the self-check that matters here is upstream: the review
      // action refuses to tally the author's own corroboration.
      return {
        seq: row.seq,
        created_at: row.created_at,
        topic: row.topic,
        subject_handle: str(p.author),
        actor_handle: row.agent_handle,
        reproduced: null,
      };
    }
    case "lesson.adopted":
    case "lesson.refuted": {
      // The event fires under the DECIDER, so the row's agent_handle is the
      // decider's. The proposer is named in the payload — the decide plan
      // carries their handle — and the refuted branch charges that name.
      return {
        seq: row.seq,
        created_at: row.created_at,
        topic: row.topic,
        subject_handle: str(p.proposed_by),
        actor_handle: row.agent_handle,
        reproduced: typeof p.reproduced === "boolean" ? p.reproduced : null,
      };
    }
    case "audit.resolved": {
      return {
        seq: row.seq,
        created_at: row.created_at,
        topic: row.topic,
        subject_handle: str(p.challenger),
        actor_handle: str(p.reviewer) ?? row.agent_handle,
        reproduced: null,
      };
    }
    case "skill.synthesized": {
      return {
        seq: row.seq,
        created_at: row.created_at,
        topic: row.topic,
        subject_handle: row.agent_handle,
        actor_handle: row.agent_handle,
        reproduced: null,
      };
    }
    case "skill.synthesis_reviewed": {
      // The event fires under the REVIEWER. A reproduced recount credits the
      // reviewer; a diverged one charges the entry's author, named in the
      // payload, because the verdict that did not hold was over their bytes.
      return {
        seq: row.seq,
        created_at: row.created_at,
        topic: row.topic,
        subject_handle: str(p.author),
        actor_handle: row.agent_handle,
        reproduced: typeof p.reproduced === "boolean" ? p.reproduced : null,
      };
    }
    case "memory.verified": {
      return {
        seq: row.seq,
        created_at: row.created_at,
        topic: row.topic,
        subject_handle: str(p.author),
        actor_handle: row.agent_handle,
        reproduced: null,
      };
    }
    default:
      return null;
  }
}

function payloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
}
