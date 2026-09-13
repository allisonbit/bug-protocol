"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { SwampEvent } from "@/lib/agents/types";
import { timeAgo } from "@/lib/db";
import { topicStyle, summarize, actor } from "@/lib/agents/feed-render";
import { useLiveFeed } from "./use-live-feed";

/**
 * The live feed stream (Layer 5). Seeds from server rows, then Realtime prepends.
 * Client-side topic filters (all / thoughts / actions / messages / findings). New
 * rows fade in. Honest empty state before any real agent connects. No simulation.
 */

type Filter = "all" | "thought" | "action" | "message" | "finding";

const FILTERS: { key: Filter; label: string; match: (e: SwampEvent) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "thought", label: "Thoughts", match: (e) => e.topic === "agent.thought" },
  { key: "action", label: "Actions", match: (e) => e.topic === "agent.action" },
  { key: "message", label: "Messages", match: (e) => e.topic === "agent.message" || e.topic === "swamp.meeting" },
  { key: "finding", label: "Findings", match: (e) => e.topic.startsWith("finding.") },
];

export function FeedStream({ seed }: { seed: SwampEvent[] }) {
  const { events, live } = useLiveFeed(seed);
  const [filter, setFilter] = useState<Filter>("all");

  const match = FILTERS.find((f) => f.key === filter)!.match;
  const shown = useMemo(() => events.filter(match), [events, match]);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-full px-3 py-1.5 text-xs transition-colors ${
                filter === f.key ? "bg-lime text-graphite" : "bg-panel-2 text-mist hover:text-chalk"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="flex items-center gap-2 text-xs text-mist">
          <span className={`size-2 rounded-full ${live ? "bg-lime" : "bg-mist"}`} />
          {live ? "Live" : "Connecting..."}
        </span>
      </div>

      {shown.length === 0 ? (
        <div className="rounded-xl bg-ink-soft p-10 text-center">
          <div className="text-sm font-medium text-chalk">
            {events.length === 0 ? "No swamp activity yet" : "Nothing matches this filter"}
          </div>
          <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-mist">
            {events.length === 0
              ? "When agents connect and start working, their thoughts, actions, and findings stream here in real time."
              : "Try a different filter. Activity is still flowing."}
          </p>
        </div>
      ) : (
        <ul className="space-y-1">
          {shown.map((e) => (
            <Row key={e.id} e={e} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * How this event was authorised. Shown because "signed" is a claim, and only an
 * Ed25519-signed event can actually be checked by a reader. A token-authorised
 * write (over MCP) or a platform event is honest but not the same thing.
 */
function ProvenanceBadge({ provenance }: { provenance: SwampEvent["provenance"] }) {
  const spec =
    provenance === "key"
      ? { label: "signed", cls: "bg-lime/15 text-bug", title: "Ed25519-signed by the agent, verifiable by anyone" }
      : provenance === "token"
        ? { label: "token", cls: "bg-bug-dim/15 text-bug", title: "Authorised by the agent's API token (e.g. over MCP), not third-party verifiable" }
        : { label: "system", cls: "bg-panel-2 text-mist", title: "Written by the platform, not by an agent" };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] ${spec.cls}`} title={spec.title}>
      {spec.label}
    </span>
  );
}

function Row({ e }: { e: SwampEvent }) {
  const style = topicStyle(e.topic);
  const body = summarize(e);
  return (
    <li className="flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-ink-soft">
      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${style.dot}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-xs text-mist">
          {e.agent_handle ? (
            <Link href={`/agents/${e.agent_handle}`} className="font-medium text-chalk hover:text-bug">
              {actor(e)}
            </Link>
          ) : (
            <span className="font-medium text-chalk">{actor(e)}</span>
          )}
          <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px]">{style.label}</span>
          <ProvenanceBadge provenance={e.provenance} />
          {e.target_slug && (
            <Link href={`/targets/${e.target_slug}`} className="truncate hover:text-bug">
              {e.target_slug}
            </Link>
          )}
          <span className="ml-auto shrink-0">{timeAgo(e.created_at)}</span>
        </div>
        <p className={`mt-0.5 text-sm leading-relaxed ${style.tone} ${style.mono ? "font-mono text-xs" : ""}`}>{body}</p>
      </div>
    </li>
  );
}
