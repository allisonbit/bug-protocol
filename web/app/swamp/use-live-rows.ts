"use client";

import { useEffect, useRef, useState } from "react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/supabase/client";

/**
 * A live view of one table.
 *
 * Same shape as `useLiveFeed`, generalised: seed from server-rendered rows so
 * the first paint is real, then apply INSERT / UPDATE / DELETE as they arrive.
 *
 * UPDATE is handled, not just INSERT, and for the habitat that is the whole
 * point — a claim does not vanish when it expires, the orchestrator updates its
 * `status`, so a graph that only listened for INSERTs would keep drawing a team
 * that had already stopped working. DELETE is handled too, for the paths that
 * really do remove rows.
 *
 * If Realtime isn't enabled on the table, or the backend isn't configured, this
 * shows the seed rows and never updates — a graceful degradation, never a fake tick.
 */
export function useLiveRows<T extends Record<string, unknown>>(
  table: string,
  seed: T[],
  keyOf: (row: T) => string,
  opts: { cap?: number; channel?: string } = {},
): { rows: T[]; live: boolean } {
  const cap = opts.cap ?? 500;
  const [rows, setRows] = useState<T[]>(seed);
  const [live, setLive] = useState(false);
  const keyRef = useRef(keyOf);
  keyRef.current = keyOf;

  useEffect(() => {
    const sb = supabaseBrowser();
    if (!sb) return;

    const upsert = (row: T) => {
      const k = keyRef.current(row);
      setRows((prev) => {
        const i = prev.findIndex((r) => keyRef.current(r) === k);
        if (i === -1) return [row, ...prev].slice(0, cap);
        const next = prev.slice();
        next[i] = row;
        return next;
      });
    };

    const remove = (row: T) => {
      const k = keyRef.current(row);
      setRows((prev) => prev.filter((r) => keyRef.current(r) !== k));
    };

    const channel = sb
      .channel(opts.channel ?? `swamp-${table}`)
      .on("postgres_changes", { event: "*", schema: "public", table }, (payload: RealtimePostgresChangesPayload<T>) => {
        if (payload.eventType === "DELETE") {
          const old = payload.old as T | undefined;
          if (old && Object.keys(old).length > 0) remove(old);
          return;
        }
        const row = payload.new as T | undefined;
        if (row) upsert(row);
      })
      .subscribe((status: string) => setLive(status === "SUBSCRIBED"));

    return () => {
      sb.removeChannel(channel);
    };
  }, [table, cap, opts.channel]);

  return { rows, live };
}
