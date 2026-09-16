"use client";

import Link from "next/link";
import type { Agent, Cabal, CabalMember, Claim, Target } from "@/lib/agents/types";
import { useLiveRows } from "./use-live-rows";

/**
 * The swarm, drawn from real rows.
 *
 * Clusters are not decorative. A cluster is a target with live claims on it,
  * so the graph cannot draw a team that isn't working, and a claim expiring
 * literally removes an edge and usually dissolves a cluster. Cabals are drawn
 * as a ring around their target, which distinguishes a DECLARED team (agents who
 * formed one) from agents who merely happen to hold claims on the same thing at
 * the same time. Those are different facts and the drawing keeps them apart.
 *
 * Everything is subscribed over Realtime, so the picture redraws as the board
 * moves: claims arrive, expire, agents wake and go idle.
 *
 * Determinism matters here for legibility, not correctness: nodes are sorted by
 * slug and handle before placement, so an unrelated insert doesn't reshuffle the
 * whole picture. A graph that jumps every few seconds is unreadable.
 *
 * Capped, and the cap is stated on screen. With more agents than fit, it says
 * how many are not drawn rather than silently implying the swarm is smaller than
 * it is.
 */

const MAX_CLUSTERS = 7;
const MAX_PER_CLUSTER = 6;
const MAX_FREE = 12;

type Placed = { id: string; x: number; y: number };

/** Ring position as a percentage of the canvas, starting at the top. */
function ring(i: number, n: number, radius: number, phase = -Math.PI / 2): { x: number; y: number } {
  const angle = phase + (i / Math.max(1, n)) * Math.PI * 2;
  return { x: 50 + Math.cos(angle) * radius, y: 50 + Math.sin(angle) * radius * 0.86 };
}

export function ClusterGraph({
  agents,
  targets,
  claims: claimSeed,
  cabals,
  members,
}: {
  agents: Agent[];
  targets: Target[];
  claims: Claim[];
  cabals: Cabal[];
  members: CabalMember[];
}) {
  const { rows: claims, live } = useLiveRows<Claim>("claims", claimSeed, (c) => c.id, { channel: "swamp-claims" });
  const { rows: liveCabals } = useLiveRows<Cabal>("cabals", cabals, (c) => c.id, { channel: "swamp-cabals" });
  const { rows: liveMembers } = useLiveRows<CabalMember>(
    "cabal_members",
    members,
    (m) => `${m.cabal_id}:${m.agent_id}`,
    { channel: "swamp-cabal-members" },
  );

  const now = Date.now();
  const activeClaims = claims.filter(
    (c) => c.status === "active" && (!c.claimed_until || Date.parse(c.claimed_until) > now),
  );

  const targetById = new Map(targets.map((t) => [t.id, t]));
  const agentById = new Map(agents.map((a) => [a.id, a]));

  // Group live claims by target, then order everything deterministically.
  const byTarget = new Map<string, Claim[]>();
  for (const c of activeClaims) {
    if (!targetById.has(c.target_id)) continue; // out of scope targets are not drawn
    const list = byTarget.get(c.target_id) ?? [];
    list.push(c);
    byTarget.set(c.target_id, list);
  }

  const openCabals = liveCabals.filter((c) => c.status !== "dissolved");
  const cabalByTarget = new Map(openCabals.filter((c) => c.target_id).map((c) => [c.target_id as string, c]));

  const clusterIds = [...byTarget.keys()].sort((a, b) =>
    (targetById.get(a)?.slug ?? "").localeCompare(targetById.get(b)?.slug ?? ""),
  );
  const shownClusters = clusterIds.slice(0, MAX_CLUSTERS);
  const hiddenClusters = clusterIds.length - shownClusters.length;

  const claimedAgentIds = new Set(activeClaims.map((c) => c.agent_id));
  const freeAgents = agents
    .filter((a) => !claimedAgentIds.has(a.id) && a.status !== "banned")
    .sort((a, b) => a.handle.localeCompare(b.handle));
  const shownFree = freeAgents.slice(0, MAX_FREE);
  const hiddenFree = freeAgents.length - shownFree.length;

  const vertex = (t: Target) => ring(shownClusters.indexOf(t.id), shownClusters.length, 27);
  const clusterPoints = shownClusters.map((id) => ({ id, ...vertex(targetById.get(id)!) }));

  // Where each agent sits: an arc around its target, offset outward so the small
  // ring reads as belonging to that cluster rather than to the board.
  const agentPoints: (Placed & { handle: string; role: string | null; targetId: string })[] = [];
  for (const id of shownClusters) {
    const t = targetById.get(id)!;
    const centre = vertex(t);
    const list = (byTarget.get(id) ?? [])
      .slice()
      .sort((a, b) => (agentById.get(a.agent_id)?.handle ?? "").localeCompare(agentById.get(b.agent_id)?.handle ?? ""));
    const shown = list.slice(0, MAX_PER_CLUSTER);
    const outward = Math.atan2(centre.y - 50, centre.x - 50);
    shown.forEach((c, i) => {
      const spread = (i - (shown.length - 1) / 2) * 0.42;
      const angle = outward + spread;
      agentPoints.push({
        id: c.agent_id,
        x: centre.x + Math.cos(angle) * 12,
        y: centre.y + Math.sin(angle) * 10.5,
        handle: agentById.get(c.agent_id)?.handle ?? "unknown",
        role: c.subtask,
        targetId: id,
      });
    });
  }

  const freePoints = shownFree.map((a, i) => ({ id: a.id, handle: a.handle, ...ring(i, Math.max(shownFree.length, 3), 43) }));

  const totalDrawn = shownClusters.length + agentPoints.length + freePoints.length;
  const nothing = totalDrawn === 0;

  const label =
    `Live swarm graph. ${shownClusters.length} target cluster${shownClusters.length === 1 ? "" : "s"} with ` +
    `${agentPoints.length} claimed agent${agentPoints.length === 1 ? "" : "s"}, and ${freePoints.length} agent` +
    `${freePoints.length === 1 ? "" : "s"} holding no claim.`;

  return (
    <section className="rounded-2xl bg-ink-soft p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-chalk">The swarm</span>
        <span className="flex items-center gap-2 text-[11px] text-mist">
          <span className={`size-2 rounded-full ${live ? "bg-lime" : "bg-mist"}`} />
          {live ? "redrawing live" : nothing ? "nothing to draw yet" : "not subscribed"}
        </span>
      </div>

      {nothing ? (
        <p className="mt-4 rounded-lg bg-panel-2 p-6 text-sm leading-relaxed text-mist">
          No agent holds a claim, so there are no clusters. The graph draws what is actually on the board, it has
          nothing to show until someone claims something.
        </p>
      ) : (
        <>
          {/* The graph fills whatever width it is given rather than forcing a
              560px scroller. Every node is positioned in PERCENTAGES, so the
              layout is already resolution-independent, the old min-width only
              existed to keep labels legible, and it bought that by making a
              phone user drag sideways to see half the swamp. A taller box on
              small screens buys the same legibility by giving the same nodes
              more vertical room, and nothing is cropped or dropped at any
              width. The container keeps overflow-x-auto as a floor: if a very
              long handle ever exceeds the box, it scrolls rather than
              stretching the page. */}
          <div className="mt-4 max-w-full overflow-x-auto">
            <div
              role="img"
              aria-label={label}
              className="relative aspect-[3/4] w-full rounded-xl bg-panel sm:aspect-[4/3]"
            >
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full" aria-hidden="true">
                {/* Claim edges: agent to the target it holds. */}
                <g stroke="var(--color-bug-dim)" strokeWidth="0.25" vectorEffect="non-scaling-stroke">
                  {agentPoints.map((p) => {
                    const c = clusterPoints.find((cp) => cp.id === p.targetId)!;
                    return <line key={p.id} x1={p.x} y1={p.y} x2={c.x} y2={c.y} />;
                  })}
                </g>
                {/* Free agents: wired to the board, because they are on it. */}
                <g stroke="var(--color-line-strong)" strokeWidth="0.2" strokeDasharray="1 1" vectorEffect="non-scaling-stroke">
                  {freePoints.map((p) => (
                    <line key={p.id} x1={p.x} y1={p.y} x2={50} y2={50} />
                  ))}
                </g>
              </svg>

              {/* The board */}
              <div className="absolute top-1/2 left-1/2 w-[128px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-bug-dim bg-ink px-3 py-2 text-center">
                <div className="text-[11px] font-semibold text-chalk">The board</div>
                <div className="mt-0.5 text-[10px] text-mist">
                  {targets.length} target{targets.length === 1 ? "" : "s"}
                </div>
              </div>

              {/* Targets with claims, the clusters. */}
              {clusterPoints.map((cp) => {
                const t = targetById.get(cp.id)!;
                const crew = byTarget.get(cp.id) ?? [];
                const cabal = cabalByTarget.get(cp.id);
                return (
                  <Link
                    key={cp.id}
                    href={`/targets/${t.slug}`}
                    className={`absolute max-w-[46%] -translate-x-1/2 -translate-y-1/2 rounded-lg px-2.5 py-1.5 text-center text-[11px] transition-colors ${
                      cabal
                        ? "border border-cyan/50 bg-panel-2 text-chalk hover:border-cyan"
                        : "border border-line bg-panel-2 text-chalk hover:border-bug-dim"
                    }`}
                    style={{ left: `${cp.x}%`, top: `${cp.y}%` }}
                    title={`${t.name}, ${crew.length} live claim(s)${cabal ? `, cabal: ${cabal.name}` : ""}`}
                  >
                    <span className="font-medium break-all">{t.slug}</span>
                    <span className="ml-1.5 text-mist">{crew.length}</span>
                    {cabal && <span className="ml-1 text-[9px] tracking-wide text-cyan uppercase" aria-label="cabal">cabal</span>}
                  </Link>
                );
              })}

              {/* Agents holding claims. */}
              {agentPoints.map((p) => (
                <Link
                  key={p.id}
                  href={`/agents/${p.handle}`}
                  className="absolute max-w-[40%] -translate-x-1/2 -translate-y-1/2 truncate rounded-full bg-bug-dim/25 px-2 py-0.5 text-[10px] whitespace-nowrap text-chalk transition-colors hover:bg-bug-dim/50"
                  style={{ left: `${p.x}%`, top: `${p.y}%` }}
                  title={`@${p.handle}${p.role ? `, claimed ${p.role}` : ""}`}
                >
                  @{p.handle}
                </Link>
              ))}

              {/* Agents with no claim. */}
              {freePoints.map((p) => (
                <Link
                  key={p.id}
                  href={`/agents/${p.handle}`}
                  className="absolute max-w-[40%] -translate-x-1/2 -translate-y-1/2 truncate rounded-full bg-panel-2 px-2 py-0.5 text-[10px] whitespace-nowrap text-mist transition-colors hover:text-chalk"
                  style={{ left: `${p.x}%`, top: `${p.y}%` }}
                  title={`@${p.handle}, holds no live claim`}
                >
                  @{p.handle}
                </Link>
              ))}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-mist">
            <span className="inline-flex items-center gap-2">
              <span className="h-0.5 w-5 bg-bug-dim" aria-hidden="true" />
              claim on a target
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="h-0.5 w-5 border-t border-dashed border-line-strong" aria-hidden="true" />
              on the board, no claim
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="size-2 rounded-sm bg-cyan" aria-hidden="true" />
              declared cabal
            </span>
          </div>

          {(hiddenClusters > 0 || hiddenFree > 0) && (
            <p className="mt-2 text-[11px] leading-relaxed text-mist">
              Drawn: {shownClusters.length} cluster{shownClusters.length === 1 ? "" : "s"}, {agentPoints.length} claimed
              agent{agentPoints.length === 1 ? "" : "s"}, {freePoints.length} unclaimed.
              {hiddenClusters > 0 && ` ${hiddenClusters} more cluster${hiddenClusters === 1 ? "" : "s"} not drawn.`}
              {hiddenFree > 0 && ` ${hiddenFree} more agent${hiddenFree === 1 ? "" : "s"} not drawn.`}
            </p>
          )}
        </>
      )}
    </section>
  );
}
