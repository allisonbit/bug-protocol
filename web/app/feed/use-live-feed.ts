"use client";

import { useEffect, useRef, useState } from "react";
import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/supabase/client";
import { uniqueChannelTopic } from "@/lib/supabase/channel-topic";
import type { SwampEvent } from "@/lib/agents/types";

/**
 * Subscribe to the append only bus over Supabase Realtime (Layer 5). Seeds from
 * server-rendered rows (so the feed is populated on first paint and honest when
 * empty), then prepends live INSERTs on public.events. The <500ms push path.
 *
 * Realtime must be enabled on `public.events` (swamp.sql adds it to the
 * supabase_realtime publication). If it isn't, or the backend isn't configured,
 * this simply shows the seed rows and never updates. A graceful, honest
 * degradation, never a crash or a fake tick.
 *
 * THAT LAST SENTENCE WAS NOT TRUE, and the shape of it is worth keeping: the topic
 * was hardcoded, and `channel(topic)` returns the existing channel when the topic
 * matches, so the second subscriber on a page got one that had already subscribed
 * and `on()` threw. `/feed` renders this hook twice — the rail and the stream — and
 * a navigation between two world-shell routes remounted it while the previous
 * `removeChannel` was still in flight. Both threw an uncaught error before any of
 * the degradation below could happen. The topic is now unique per subscriber, and
 * the setup is inside a try so the promise is kept even when the cause is unknown.
 *
 * `cap` bounds the in-memory list. `live` reflects whether the socket subscribed.
 */
export function useLiveFeed(seed: SwampEvent[], cap = 100): { events: SwampEvent[]; live: boolean } {
  const [events, setEvents] = useState<SwampEvent[]>(seed);
  const [live, setLive] = useState(false);
  const seen = useRef<Set<string>>(new Set(seed.map((e) => e.id)));

  useEffect(() => {
    const sb = supabaseBrowser();
    if (!sb) return;

    let channel: RealtimeChannel;
    try {
      channel = sb
        .channel(uniqueChannelTopic("swamp-feed"))
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "events" },
          (payload: RealtimePostgresChangesPayload<SwampEvent>) => {
            const row = payload.new as SwampEvent;
            if (!row?.id || seen.current.has(row.id)) return;
            seen.current.add(row.id);
            setEvents((prev) => [row, ...prev].slice(0, cap));
          },
        )
        .subscribe((status: string) => setLive(status === "SUBSCRIBED"));
    } catch {
      // The documented degradation, now actually reachable: the seeded rows stay,
      // `live` stays false, and the reader is told `as of` rather than `live`.
      // Nothing is faked and nothing is thrown at somebody who is only watching.
      setLive(false);
      return;
    }

    return () => {
      // Unsubscribing is asynchronous, so a navigation can start the next
      // subscription before this one has finished leaving. That is exactly why the
      // topic is unique per subscriber rather than per name.
      try {
        void sb.removeChannel(channel);
      } catch {
        // A socket that is already gone is not a state a reader needs told about.
      }
    };
  }, [cap]);

  return { events, live };
}
