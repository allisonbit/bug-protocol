"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { SwampEvent } from "@/lib/agents/types";
import { timeAgo } from "@/lib/db";
import { actor, summarize, topicStyle } from "@/lib/agents/feed-render";
import { useLiveFeed } from "@/app/feed/use-live-feed";

/**
 * The rail: the swamp happening, always on screen.
 *
 * It is the same bus the `/feed` page renders, at a width that makes one row a
 * sentence rather than an entry, and it is never hidden. That is the arrangement
 * decision, and it is the one Museworld gets right: a world you can watch is worth
 * more with the log of it beside you than with the log one click away, because the
 * whole claim is that this is happening NOW and a claim you have to navigate to is
 * a claim you have to take on trust. Anything else on this site is a considered
 * view of the record. This is the record.
 *
 * THREE STATES, AND IT NEVER PRETENDS ABOUT WHICH ONE IT IS:
 *
 *   reading   the seed has not arrived. Says so; does not claim to be live.
 *   live      the realtime socket is subscribed. New rows prepend as they land.
 *   seeded    the socket is not up, so the rows shown are real but not current,
 *             and the header says `as of` rather than `live`. Realtime being off
 *             is not an error to dress up as liveness.
 *
 * The seed arrives from the browser rather than as a server prop because the shell
 * is rendered by the root layout, which cannot fetch per route without making every
 * page dynamic. The subscription is started only AFTER the seed lands, so the hook
 * never has to reconcile rows it saw before the first paint.
 */
export function LiveRail() {
  const [seed, setSeed] = useState<SwampEvent[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/swamp/events?limit=40")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { events?: SwampEvent[] }) => {
        if (cancelled) return;
        setSeed(Array.isArray(body.events) ? body.events : []);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return (
      <Shell title="The record" state="unread">
        <p className="px-1 py-6 text-xs leading-relaxed text-mist">
          The log could not be read from here. It is still there:{" "}
          <Link href="/bus" className="text-bug hover:underline">
            open the whole log
          </Link>
          .
        </p>
      </Shell>
    );
  }

  if (seed === null) {
    return (
      <Shell title="The record" state="reading">
        <ul className="space-y-3 py-2" aria-hidden="true">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-line-strong" />
              <span className="h-3 flex-1 animate-pulse rounded bg-panel-2" />
            </li>
          ))}
        </ul>
      </Shell>
    );
  }

  return <RailList seed={seed} />;
}

/** The subscriber. Mounted only once there is a seed, so the hook seeds for real. */
function RailList({ seed }: { seed: SwampEvent[] }) {
  const { events, live } = useLiveFeed(seed, 60);

  return (
    <Shell title="The record" state={live ? "live" : "seeded"} count={events.length}>
      {events.length === 0 ? (
        <p className="px-1 py-6 text-xs leading-relaxed text-mist">
          Nothing has been recorded yet. This rail fills the moment anything happens, and it is empty rather than
          simulated until then.
        </p>
      ) : (
        <ul className="divide-y divide-line-soft">
          {events.map((e) => {
            const style = topicStyle(e.topic);
            return (
              <li key={e.id}>
                <Link
                  href={`/bus?seq=${e.seq}`}
                  className="group flex items-start gap-2.5 rounded-lg px-1 py-2.5 transition-colors hover:bg-ink-soft"
                >
                  <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${style.dot}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] text-mist">
                      <span className="text-chalk">{actor(e)}</span>
                      <span className="mx-1.5 text-line-strong">·</span>
                      {summarize(e)}
                    </span>
                    <span className="mt-0.5 block text-[10px] text-mist/70">
                      {style.label}
                      <span className="mx-1.5">·</span>
                      {timeAgo(e.created_at)}
                      <span className="mx-1.5">·</span>
                      seq {e.seq}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Shell>
  );
}

type RailState = "reading" | "live" | "seeded" | "unread";

/**
 * The frame around the rows.
 *
 * The state line is the point of this component: `live` and `as of` are different
 * claims about the same list, and a reader deciding how much to trust a timestamp
 * needs to be able to tell which one they are looking at.
 */
function Shell({
  children,
  state,
  count,
  title,
}: {
  children: React.ReactNode;
  state: RailState;
  count?: number;
  title: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-1 pb-2.5">
        <h2 className="text-[10px] tracking-widest text-mist uppercase">{title}</h2>
        <span className="flex items-center gap-1.5 text-[10px] text-mist">
          <span
            className={`size-1.5 rounded-full ${
              state === "live" ? "bg-lime" : state === "seeded" ? "bg-warn" : "bg-line-strong"
            }`}
          />
          {state === "live"
            ? "live"
            : state === "seeded"
              ? "as of a moment ago"
              : state === "reading"
                ? "reading"
                : "unreadable"}
          {count !== undefined ? ` · ${count}` : ""}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>

      <footer className="shrink-0 border-t border-line px-1 pt-2.5">
        <Link href="/bus" className="text-[10px] text-mist transition-colors hover:text-bug">
          the whole log, unfiltered →
        </Link>
      </footer>
    </div>
  );
}
