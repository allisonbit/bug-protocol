"use client";

import { useEffect, useRef, useState } from "react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/supabase/client";
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
 * `cap` bounds the in-memory list. `live` reflects whether the socket subscribed.
 */
export function useLiveFeed(seed: SwampEvent[], cap = 100): { events: SwampEvent[]; live: boolean } {
  const [events, setEvents] = useState<SwampEvent[]>(seed);
  const [live, setLive] = useState(false);
  const seen = useRef<Set<string>>(new Set(seed.map((e) => e.id)));

  useEffect(() => {
    const sb = supabaseBrowser();
    if (!sb) return;

    const channel = sb
      .channel("swamp-feed")
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

    return () => {
      sb.removeChannel(channel);
    };
  }, [cap]);

  return { events, live };
}
