/**
 * WHO IS ACTUALLY IN A CABAL, AND WHY THIS IS A MODULE OF ITS OWN.
 *
 * A cabal's roster is written to `cabal_members`, which is keyed
 * `primary key (cabal_id, agent_id)` — one row per agent, by construction. The
 * planner built the roster as one row per CLAIM instead:
 *
 *     const members = claims.map((c) => ({ agentId: c.agent_id, ... }))
 *
 * On the target that formed both cabals this swarm has ever had, one agent held
 * three live claims and two others held two each. A payload naming the same agent
 * twice is rejected WHOLE by the composite key — `23505 duplicate key value
 * violates unique constraint "cabal_members_pkey"`, reproduced in a rolled-back
 * transaction on 2026-09-20 — and the insert's result was discarded, so the
 * refusal had no witness anywhere.
 *
 * The measured consequence: two cabals formed (2026-09-17 and 2026-09-19), both
 * dissolved, and `cabal_members` held ZERO rows. Dissolving does not delete
 * members, so nothing was ever written. Every reader — `getCabalMembers`, the
 * planner's own observation, the cluster graph — filters `left_at is null` and
 * therefore drew a working group with nobody in it, while the cabal's own purpose
 * line announced "5 agents hold live claims on Swamp".
 *
 * Two functions, because there are two places the roster is built and one place it
 * is written, and the write is the last place a duplicate may be allowed to pass.
 */

/** A roster member, in the shape `cabal_members` wants minus the cabal. */
export type RosterMember = {
  agentId: string;
  handle: string;
  role: string | null;
};

/**
 * One row per distinct agent, in order, dropping anything that cannot satisfy the
 * foreign key.
 *
 * A member's `role` stays the first subtask it claimed. An agent that claimed twice
 * is one member rather than two, and the second claim does not overwrite the role:
 * the column records what the agent actually claimed, and picking the later of two
 * true things would be a choice this module has no basis for.
 */
export function distinctMembers(members: readonly RosterMember[]): RosterMember[] {
  const out: RosterMember[] = [];
  const seen = new Set<string>();
  for (const m of members ?? []) {
    const id = typeof m?.agentId === "string" ? m.agentId.trim() : "";
    // An id that is missing cannot reference an agent, so a row for it would be
    // refused by the foreign key and take the whole roster down with it.
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      agentId: id,
      handle: typeof m.handle === "string" && m.handle.trim() !== "" ? m.handle : id,
      role: m.role ?? null,
    });
  }
  return out;
}

/**
 * The roster a set of claims implies: the agents holding them, each once.
 *
 * `handles` is what the caller already has — the peer handles a brain observed —
 * and a missing entry falls back to the id rather than to nothing, so a member is
 * never drawn as a blank.
 */
export function rosterFromClaims(
  claims: readonly { agent_id: string | null; subtask: string | null }[],
  handles: Map<string, string>,
): RosterMember[] {
  return distinctMembers(
    (claims ?? []).map((c) => {
      const id = c.agent_id ?? "";
      return { agentId: id, handle: handles.get(id) ?? id, role: c.subtask ?? null };
    }),
  );
}
