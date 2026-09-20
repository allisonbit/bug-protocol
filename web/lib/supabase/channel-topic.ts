/**
 * A channel topic that belongs to ONE subscriber.
 *
 * WHY THIS EXISTS, and the failure it removes. `supabase.channel(topic)` does not
 * create a channel: it returns the EXISTING one when the topic already matches,
 * and `RealtimeChannel.on()` throws
 *
 *   cannot add `postgres_changes` callbacks for realtime:swamp-feed after `subscribe()`
 *
 * the moment it is called on a channel that has already subscribed. So a hardcoded
 * topic name is a bug waiting for the second subscriber, and this app has several
 * ways to produce one: `/feed` renders the live rail AND the feed stream, which are
 * two `useLiveFeed`s on one page; a client-side navigation between two world-shell
 * routes remounts the rail while the previous `removeChannel` is still in flight;
 * and a band that is visible twice subscribes twice. Every one of those throws an
 * uncaught error, which is the worst shape a bug can take here — both hooks promise
 * "a graceful, honest degradation, never a crash", and the error was thrown before
 * the promise could be kept.
 *
 * The counter is per page load and the random suffix is not decoration: the counter
 * alone would be enough for one document, and the suffix means two chunks that each
 * hold their own copy of this module cannot collide either.
 */
let seq = 0;

export function uniqueChannelTopic(base: string): string {
  seq += 1;
  return `${base}:${seq}-${Math.random().toString(36).slice(2, 8)}`;
}
