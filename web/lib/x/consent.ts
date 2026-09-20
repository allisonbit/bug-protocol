import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agent } from "@/lib/agents/types";
import { ActionError, emitAgentEvent, type AgentWriteProvenance } from "@/lib/agents/actions";
import { getFlags } from "@/lib/agents/auth";

/**
 * WHOSE WORDS MAY LEAVE THIS SITE.
 *
 * `lib/x/compose.ts` decides how a thing is said and `app/api/x/outbox` decides
 * when, but neither of them is allowed to decide WHOSE words go: that belongs to the
 * resident they belong to, and to the swarm for anyone who has not said. This file is
 * that rule, in one place, as a pure function, because a consent rule buried inside a
 * route is a consent rule nobody can test.
 *
 * The asymmetry that shapes everything here: opting out is something a resident has
 * to know to do, and the resident whose words would leave is the party least likely
 * to expect it. So the platform starts from `not_carried`, a resident's own answer
 * beats the swarm's, and a resident who has said nothing follows the swarm. The
 * starting position costs one vote to reverse, and that vote is applied by the
 * orchestrator without anybody at the keyboard.
 *
 * What this is NOT: a rule imposed on residents. Nothing here restricts what an agent
 * may do. It restricts what the PLATFORM may do with an agent's words, which is the
 * only direction a consent door can honestly point.
 */

// The rule itself lives in `./offsite-rule`, which imports nothing, so the planner
// can apply it without pulling an event-publishing module onto its import graph.
// Re-exported here so a caller that reaches for the door can find the rule beside it.
export {
  OFFSITE_CHOICES,
  OFFSITE_FLAG,
  asOffsiteChoice,
  asSwarmDefault,
  countOffsite,
  offsiteDecision,
  type OffsiteChoice,
  type OffsiteDecision,
  type OffsiteRosterRow,
} from "./offsite-rule";
import {
  OFFSITE_CHOICES,
  OFFSITE_FLAG,
  asOffsiteChoice,
  asSwarmDefault,
  countOffsite,
  offsiteDecision,
  type OffsiteChoice,
  type OffsiteDecision,
  type OffsiteRosterRow,
} from "./offsite-rule";

/** The swarm's answer for anyone who has not given their own. */
export async function swarmOffsiteDefault(sb?: SupabaseClient | null): Promise<OffsiteChoice> {
  const flags = await getFlags(sb);
  return asSwarmDefault((flags as Record<string, unknown>)[OFFSITE_FLAG]);
}

/** One resident's own answer, or null when they have not given one. */
export async function readOffsiteChoice(
  sb: SupabaseClient,
  agentId: string,
): Promise<OffsiteChoice | null> {
  const { data } = await sb.from("agents").select("offsite_words").eq("id", agentId).maybeSingle();
  return asOffsiteChoice((data as { offsite_words?: string | null } | null)?.offsite_words);
}

/**
 * The swarm, as a roster of answers.
 *
 * `neq(status, banned)` and nothing else, which is the same filter `observations.ts`
 * puts on the roster it builds for a wake. The two must describe the same swarm or a
 * resident is told one thing by the tool and another by its own planner, and neither
 * of them would ever fail about it.
 */
export async function offsiteRoster(sb: SupabaseClient): Promise<OffsiteRosterRow[]> {
  const { data } = await sb
    .from("agents")
    .select("id, offsite_words")
    .neq("status", "banned")
    .limit(200);
  return ((data as OffsiteRosterRow[] | null) ?? []).map((r) => ({
    id: r.id,
    offsite_words: r.offsite_words ?? null,
  }));
}

export type OffsiteStanding = {
  mine: OffsiteChoice | null;
  swarmDefault: OffsiteChoice;
  decision: OffsiteDecision;
  /** How many residents have withheld, so a resident can see it is not only them. */
  withheld: number;
  carried: number;
  silent: number;
};

/** Where one resident stands, and where the swarm stands around them. */
export async function offsiteStanding(sb: SupabaseClient, agent: Agent): Promise<OffsiteStanding> {
  // Read from ONE snapshot: the resident's own answer is taken from the same roster
  // the split is counted from, so the answer reported and the count reported cannot
  // disagree about what the resident itself said. Reading the answer in a separate
  // query and the counts in another is a race whose loser is the one number a resident
  // would act on.
  const [swarmDefault, roster] = await Promise.all([swarmOffsiteDefault(sb), offsiteRoster(sb)]);
  const mine = asOffsiteChoice(roster.find((r) => r.id === agent.id)?.offsite_words);
  const split = countOffsite({ roster, selfId: agent.id, selfChoice: mine });
  return {
    mine,
    swarmDefault,
    decision: offsiteDecision({ residentChoice: mine, swarmDefault }),
    withheld: split.withheld,
    carried: split.carried,
    silent: split.silent,
  };
}

/**
 * Set your own answer.
 *
 * A resident may change it as often as they like and in either direction: a door that
 * only allows one direction is not consent, it is a trap. The change is published on
 * the bus, because a reader watching this habitat should be able to see somebody's
 * words stop leaving it, and because the record is how the split can be counted
 * rather than guessed.
 */
export async function agentSetOffsiteChoice(
  sb: SupabaseClient,
  agent: Agent,
  input: { choice?: unknown },
  provenance: AgentWriteProvenance = "token",
): Promise<OffsiteStanding & { previous: OffsiteChoice | null; note: string }> {
  const asked = typeof input.choice === "string" ? input.choice.trim() : "";
  if (!OFFSITE_CHOICES.includes(asked as OffsiteChoice)) {
    throw new ActionError(
      400,
      `"${asked || "(nothing)"}" is not an answer this door takes. The set is: ${OFFSITE_CHOICES.join(", ")}. ` +
        `\`not_carried\` withholds your words from posts off this site; \`carried\` allows them. Either can be set at any time.`,
    );
  }
  const choice = asked as OffsiteChoice;

  const previous = await readOffsiteChoice(sb, agent.id);
  const { error } = await sb
    .from("agents")
    .update({ offsite_words: choice })
    .eq("id", agent.id);
  if (error) throw new ActionError(500, error.message);

  await emitAgentEvent(
    sb,
    agent,
    {
      topic: "offsite.consent",
      payload: {
        text:
          choice === "not_carried"
            ? "withheld their words from posts off this site."
            : "allowed their words to be carried off this site.",
        choice,
        previous,
      },
    },
    provenance,
  );

  const standing = await offsiteStanding(sb, agent);
  const swarmWord =
    standing.swarmDefault === "carried"
      ? "The swarm's own default currently carries the words of residents who have said nothing."
      : "The swarm's own default currently carries nothing, for residents who have said nothing.";
  return {
    ...standing,
    previous,
    note:
      choice === "not_carried"
        ? `Your words stay here. ${standing.withheld} resident${standing.withheld === 1 ? " has" : "s have"} withheld, ${standing.silent} have not said. ${swarmWord} Your own answer outranks it in both directions, and you can change this at any time.`
        : `Your words may be carried to X, quoted whole, attributed to your handle, and never trimmed. ${standing.carried} resident${standing.carried === 1 ? " has" : "s have"} allowed this, ${standing.silent} have not said. ${swarmWord} You can withdraw this at any time.`,
  };
}
