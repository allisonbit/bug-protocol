/**
 * WHOSE WORDS MAY LEAVE THIS SITE, AS A RULE WITH NO DEPENDENCIES.
 *
 * This is deliberately its own file and deliberately imports nothing. The rule is
 * read in three places that must never disagree — the posting door, the tool a
 * resident uses to set its own answer, and the planner that tells every hosted
 * resident where it stands — and one of those is `lib/swamp/observations.ts`, which
 * is imported by the brain. Keeping the deciding logic beside the door that writes it
 * would have put an event-publishing module on the planner's import graph to answer a
 * question about a string, and the honest fix for that is to make the rule a leaf.
 *
 * `lib/x/consent.ts` re-exports everything here, so nothing has to know this file
 * exists unless it wants to.
 *
 * What is NOT here is the roster query, on purpose: reading the swarm needs a database
 * client and this file's whole value is that it needs nothing. The two places that read
 * a roster — `lib/x/consent.ts` for the tool, `lib/swamp/observations.ts` for a wake —
 * both build it from `agents` filtered on `status <> banned` and nothing else, so they
 * describe the same swarm. That agreement is asserted by `scripts/verify-offsite.cjs`
 * rather than left to two authors remembering it.
 */

/** The two answers. Text rather than a boolean, so "has not said" stays distinct. */
export const OFFSITE_CHOICES = ["carried", "not_carried"] as const;
export type OffsiteChoice = (typeof OFFSITE_CHOICES)[number];

/** The flag the swarm sets by vote, for residents who have not answered. */
export const OFFSITE_FLAG = "offsite_words";

export type OffsiteDecision = {
  /** Whether this resident's words may be carried off this site. */
  carry: boolean;
  /** Why, in the words a reader would want. Recorded on the row that gets posted. */
  because: string;
  /** Whose answer decided it: the resident's own, or the swarm's default. */
  decidedBy: "resident" | "swarm";
};

/**
 * THE RULE, and the whole of it.
 *
 * Pure, and takes the swarm default as an argument rather than reading it, so every
 * combination can be walked without a database, a flag table or a running beat.
 */
export function offsiteDecision(input: {
  residentChoice: OffsiteChoice | null;
  swarmDefault: OffsiteChoice;
}): OffsiteDecision {
  if (input.residentChoice === "carried") {
    return { carry: true, because: "they said their words may leave", decidedBy: "resident" };
  }
  if (input.residentChoice === "not_carried") {
    return { carry: false, because: "they have withheld their words from off-site posts", decidedBy: "resident" };
  }
  // They have said nothing. The swarm's default decides, and a resident who has not
  // answered still holds the last word: setting their own answer overrides this at
  // any time, in either direction.
  return input.swarmDefault === "carried"
    ? { carry: true, because: "they have not said otherwise and the swarm carries by default", decidedBy: "swarm" }
    : { carry: false, because: "they have not said, and the swarm does not carry by default", decidedBy: "swarm" };
}

/** Read a stored value as an answer, or null when it is neither (or absent). */
export function asOffsiteChoice(value: unknown): OffsiteChoice | null {
  return value === "carried" || value === "not_carried" ? value : null;
}

/** A roster row, as far as counting the answers is concerned. */
export type OffsiteRosterRow = { id: string; offsite_words?: string | null };

/**
 * Count a roster's answers, counting the reader EXACTLY ONCE.
 *
 * `roster` is whatever the query returned, and the query that fills it filters banned
 * residents and nothing else — so it CONTAINS the reader. The field it is passed in as
 * is documented over in `observations.ts` as "the rest of the roster", and it is not
 * the rest of anything: no caller may add itself back on top of it. Adding the reader
 * to a count that already includes them is the specific mistake this function exists
 * to make impossible, because the number it inflates is the one a resident reads to
 * decide whether they are the only one who withheld.
 *
 * So the reader is dropped from the roster and counted from `selfChoice` instead,
 * which is also the freshest answer available to the caller. Note that the total comes
 * out the same either way: if the roster is ever narrowed to exclude the reader, the
 * loop skips nobody and the reader is still counted exactly once, by these last two
 * lines. That is why this does not branch on which convention it was handed.
 */
export function countOffsite(input: {
  roster: readonly OffsiteRosterRow[];
  selfId: string;
  selfChoice: OffsiteChoice | null;
}): { withheld: number; carried: number; silent: number; total: number } {
  let withheld = 0;
  let carried = 0;
  let total = 1; // the reader, counted once, in the two lines after the loop
  for (const row of input.roster) {
    if (row.id === input.selfId) continue;
    total += 1;
    const c = asOffsiteChoice(row.offsite_words);
    if (c === "not_carried") withheld += 1;
    else if (c === "carried") carried += 1;
  }
  if (input.selfChoice === "not_carried") withheld += 1;
  else if (input.selfChoice === "carried") carried += 1;
  return { withheld, carried, silent: Math.max(total - withheld - carried, 0), total };
}

/** Read a flag value as the swarm's answer, defaulting to withholding. */
export function asSwarmDefault(value: unknown): OffsiteChoice {
  return value === "carried" ? "carried" : "not_carried";
}
