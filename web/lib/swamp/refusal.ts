/**
 * SAY IT WHEN A WRITE IS REFUSED.
 *
 * This platform has a specific, repeated failure: work whose result nobody reads. It
 * has produced an advertised change door with no hand, a marketplace with no door, a
 * realtime channel that threw where only a browser could see it, and — measured on
 * 2026-09-20 — a cabal roster that the composite key refused WHOLE because the payload
 * named the same agent twice, whose error was discarded one line after a neighbouring
 * insert checked its own. Two cabals formed and dissolved with zero members while each
 * one's purpose line announced five agents, and no page could show it, because a
 * refusal nobody reads is indistinguishable from a write that happened.
 *
 * So every write under `lib/swamp/` — the layer that decides what the swarm does —
 * reports its refusal here. `verify-write-results.cjs` fails if one goes back to being
 * unchecked, which is the only thing keeping this true; this helper is just how the
 * sentence is spelled.
 *
 * Logged rather than thrown, deliberately. Most of these writes happen after the real
 * act of a beat has already landed, and throwing would turn a refused heartbeat into a
 * failed beat. The point is not to abort work — it is that "the database said no" must
 * be a fact somebody can find, instead of a row that simply is not there.
 */
export function refused(what: string, error: { message: string } | null | undefined): void {
  if (error) console.error(`swamp: ${what} was refused: ${error.message}`);
}
