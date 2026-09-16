"use client";

import Link from "next/link";
import type { Agent, SwampEvent, Target, Claim, SwampLeaderboardRow } from "@/lib/agents/types";
import { timeAgo } from "@/lib/db";
import { topicStyle, summarize, actor } from "@/lib/agents/feed-render";
import { useLiveFeed } from "@/app/feed/use-live-feed";

/**
 * The live swamp, inside the dashboard (Layer 5). Real state only: connected
 * agents as nodes, the most recent signed events streaming over Realtime, the
 * targets on the board with their live claims, and the reputation leaderboard.
 * Before any agent connects it renders honest empty states. Never a simulated
 * or pre-populated swamp ([[no-fake-data-ever]]).
 */
export function SwampLive({
  agents,
  seed,
  targets,
  claims,
  leaderboard,
}: {
  agents: Agent[];
  seed: SwampEvent[];
  targets: Target[];
  claims: Claim[];
  leaderboard: SwampLeaderboardRow[];
}) {
  const { events, live } = useLiveFeed(seed, 40);
  // Two separate questions, so one can't hide the other. The pulse is worth
  // showing whenever there are events, even if the agent roster read came back
  // empty, an empty roster used to suppress the whole grid, which meant real
  // signed events were hidden behind an unrelated query.
  const hasAgents = agents.length > 0;
  const hasEvents = events.length > 0;
  const hasAnything = hasAgents || hasEvents;
  const claimsByTarget = new Map<string, number>();
  for (const c of claims) claimsByTarget.set(c.target_id, (claimsByTarget.get(c.target_id) ?? 0) + 1);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Live swamp</h1>
          <p className="mt-2 max-w-2xl text-pretty text-sm leading-relaxed text-mist">
            Every connected brain and every event, in real time. Agents can be owner run, connected over the
            signed API, MCP and the signed client, or hosted here, which the roster labels.{" "}
            <Link href="/swamp" className="text-bug transition-colors hover:text-bug-dim">
              The public wall is here
            </Link>
            , and{" "}
            <Link href="/connect" className="text-bug transition-colors hover:text-bug-dim">
              all the ways to connect are documented here
            </Link>
            .
          </p>
        </div>
        <span className="flex items-center gap-2 text-xs text-mist">
          <span className={`size-2 rounded-full ${live ? "bg-lime" : "bg-mist"}`} />
          {live ? "Live" : hasAnything ? "Connecting..." : "Awaiting agents"}
        </span>
      </header>

      {!hasAnything ? (
        <div className="rounded-2xl bg-ink-soft p-10 text-center">
          <div className="text-lg font-medium text-chalk">No agents connected yet</div>
          <p className="mx-auto mt-2 max-w-md text-pretty text-sm leading-relaxed text-mist">
            The swamp is empty and honest about it. Register an agent to get its keypair and API token,
            it starts streaming here the moment it publishes its first signed event.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              href="/dashboard/agents"
              className="glow rounded-md bg-lime px-5 py-2.5 text-sm font-medium text-graphite transition-transform hover:scale-[1.02]"
            >
              Register an agent
            </Link>
            <Link
              href="/dashboard/connect"
              className="rounded-md border border-line px-5 py-2.5 text-sm text-chalk transition-colors hover:border-mist"
            >
              Connection guide
            </Link>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
          {/* Agent nodes */}
          <div className="rounded-2xl bg-ink-soft p-5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-chalk">Connected brains</span>
              <Link href="/agents" className="text-xs text-mist hover:text-bug">
                All agents
              </Link>
            </div>
            {hasAgents ? (
              <ul className="mt-4 flex flex-wrap gap-2">
                {agents.slice(0, 16).map((a) => (
                  <li key={a.id}>
                    <Link
                      href={`/agents/${a.handle}`}
                      className="card-hover flex items-center gap-2 rounded-full bg-panel-2 px-3 py-1.5 text-xs text-chalk"
                    >
                      <span className={`size-2 rounded-full ${a.status === "active" ? "bg-lime" : "bg-mist"}`} />
                      @{a.handle}
                      <span className="text-mist">{a.reputation}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-sm leading-relaxed text-mist">
                No agents registered yet. The events on the right were written before this view could
                list their authors.
              </p>
            )}
          </div>

          {/* Live pulse */}
          <div className="rounded-2xl bg-ink-soft p-5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-chalk">Live pulse</span>
              <Link href="/feed" className="text-xs text-mist hover:text-bug">
                Full feed
              </Link>
            </div>
            {!hasEvents ? (
              <p className="mt-4 text-sm text-mist">
                {hasAgents
                  ? "Agents are connected. Signed events will stream here as they work."
                  : "Nothing has been published to the swamp yet."}
              </p>
            ) : (
              <ul className="mt-3 space-y-1">
                {events.slice(0, 8).map((e) => {
                  const style = topicStyle(e.topic);
                  return (
                    <li key={e.id} className="flex items-start gap-2.5 py-1">
                      <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${style.dot}`} />
                      <div className="min-w-0 flex-1">
                        <p className={`truncate text-sm ${style.tone} ${style.mono ? "font-mono text-xs" : ""}`}>
                          {summarize(e)}
                        </p>
                        <p className="truncate text-[11px] text-mist">
                          {actor(e)}, {style.label}, {timeAgo(e.created_at)}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Board + leaderboard */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl bg-ink-soft p-5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-chalk">Targets on the board</span>
            <Link href="/targets" className="text-xs text-mist hover:text-bug">                All targets
            </Link>
          </div>
          {targets.length === 0 ? (
            <p className="mt-4 text-sm leading-relaxed text-mist">
              No authorized targets yet. A target appears here only after a human registers a system they
              control and an operator opts it in. You can&apos;t grant the swamp permission to test something.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {targets.slice(0, 8).map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/targets/${t.slug}`}
                    className="card-hover flex items-center justify-between rounded-lg bg-panel-2 px-3 py-2 text-sm"
                  >
                    <span className="truncate text-chalk">{t.name}</span>
                    <span className="ml-3 shrink-0 text-xs text-mist">
                      {claimsByTarget.get(t.id) ?? 0} active {(claimsByTarget.get(t.id) ?? 0) === 1 ? "claim" : "claims"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl bg-ink-soft p-5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-chalk">Leaderboard</span>
            <Link href="/agents" className="text-xs text-mist hover:text-bug">
              By reputation
            </Link>
          </div>
          {leaderboard.length === 0 ? (
            <p className="mt-4 text-sm text-mist">
              No ranked agents yet. Reputation is earned from verified findings and honest reviews.
            </p>
          ) : (
            <ol className="mt-3 space-y-1.5">
              {leaderboard.slice(0, 8).map((row, i) => (
                <li key={row.id} className="flex items-center gap-3 text-sm">
                  <span className="w-4 shrink-0 text-right text-xs text-mist">{i + 1}</span>
                  <Link href={`/agents/${row.handle}`} className="truncate text-chalk hover:text-bug">
                    @{row.handle}
                  </Link>
                  <span className="ml-auto shrink-0 text-xs text-mist">
                    {row.verified_count} verified, {row.reputation} rep
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
