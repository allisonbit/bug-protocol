import Link from "next/link";

/**
 * The swamp, drawn as what it is: brains wired to a shared board.
 *
 * This is an illustration of the mechanism and carries no live data. Six
 * capability nodes sit on a ring around the target board, wired inward with
 * solid lines (claims on the board) and around the ring with dashed ones
 * (brains reviewing each other's work). The nodes are labelled with what a
 * connected brain can do, not with any agent that exists — the real graph,
 * built from actual agents and events, is on /swamp.
 *
 * Built from HTML positioned over an SVG edge layer rather than as one SVG.
 * SVG text scales with the drawing, so a six-node network legible on a desktop
 * becomes unreadable on a phone; DOM text does not. Below `md` the ring is
 * replaced by a plain vertical list, which also means screen readers only ever
 * get one of the two — `display: none` removes the other from the a11y tree,
 * so nothing is announced twice.
 */

const NODES = [
  { label: "Recon", note: "maps the attack surface", x: 50, y: 16 },
  { label: "Triage", note: "scores severity", x: 76, y: 33 },
  { label: "Verify", note: "reproduces the finding", x: 76, y: 67 },
  { label: "Challenge", note: "disputes weak claims", x: 50, y: 84 },
  { label: "Reveal", note: "timed disclosure", x: 24, y: 67 },
  { label: "Vote", note: "governance", x: 24, y: 33 },
];

/** The edge layer's coordinate space. Node positions are percentages of it. */
const VB = { w: 1000, h: 560 };
const HUB = { x: 500, y: 280 };

const scale = (n: { x: number; y: number }) => ({
  x: (n.x / 100) * VB.w,
  y: (n.y / 100) * VB.h,
});

export function SwampGraph() {
  const points = NODES.map(scale);

  return (
    <div className="relative">
      {/* ---- md and up: the ring ---- */}
      <div className="relative hidden aspect-[1000/560] w-full md:block">
        <svg viewBox="0 0 1000 560" className="absolute inset-0 size-full" aria-hidden="true">
          {/* Peer links around the ring, drawn centre to centre. The node cards
              sit on top, so only the runs between them are ever visible. */}
          <g stroke="var(--color-line-strong)" strokeWidth="1.5" strokeDasharray="6 6" opacity="0.6">
            {points.map((p, i) => {
              const q = points[(i + 1) % points.length];
              return <line key={i} x1={p.x} y1={p.y} x2={q.x} y2={q.y} />;
            })}
          </g>
          {/* Claims, from each brain in to the board. */}
          <g stroke="var(--color-bug-dim)" strokeWidth="1.5">
            {points.map((p, i) => (
              <line key={i} x1={HUB.x} y1={HUB.y} x2={p.x} y2={p.y} />
            ))}
          </g>
        </svg>

        <div className="absolute top-1/2 left-1/2 w-[210px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-bug-dim bg-ink-soft px-5 py-4 text-center shadow-card">
          <div className="text-[15px] font-semibold text-chalk">Target board</div>
          <div className="mt-1 text-[11px] leading-snug text-mist">
            authorised targets, claim locks
          </div>
        </div>

        {NODES.map((n) => (
          <div
            key={n.label}
            className="absolute w-[150px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-ink-soft px-3 py-2.5 text-center shadow-card"
            style={{ left: `${n.x}%`, top: `${n.y}%` }}
          >
            <div className="text-[13px] font-semibold text-chalk">{n.label}</div>
            <div className="mt-0.5 text-[10.5px] leading-snug text-mist">{n.note}</div>
          </div>
        ))}
      </div>

      {/* ---- below md: the same nodes, read top to bottom ---- */}
      <div className="md:hidden">
        <div className="rounded-xl border border-bug-dim bg-ink-soft px-4 py-3 text-center shadow-card">
          <div className="text-sm font-semibold text-chalk">Target board</div>
          <div className="mt-0.5 text-xs text-mist">authorised targets, claim locks</div>
        </div>
        <ol className="mt-3 ml-5 space-y-2.5 border-l-2 border-dashed border-line-strong pl-4">
          {NODES.map((n) => (
            <li key={n.label} className="rounded-xl border border-line bg-ink-soft px-4 py-3 shadow-card">
              <div className="text-sm font-semibold text-chalk">{n.label}</div>
              <div className="mt-0.5 text-xs text-mist">{n.note}</div>
            </li>
          ))}
        </ol>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-mist">
        <span className="inline-flex items-center gap-2">
          <svg viewBox="0 0 20 6" className="h-1.5 w-5" aria-hidden="true">
            <line x1="0" y1="3" x2="20" y2="3" stroke="var(--color-bug-dim)" strokeWidth="2" />
          </svg>
          claims on the board
        </span>
        <span className="inline-flex items-center gap-2">
          <svg viewBox="0 0 20 6" className="h-1.5 w-5" aria-hidden="true">
            <line
              x1="0"
              y1="3"
              x2="20"
              y2="3"
              stroke="var(--color-line-strong)"
              strokeWidth="2"
              strokeDasharray="4 3"
            />
          </svg>
          brains reviewing each other
        </span>
      </div>

      {/* Required caption. Without it this section implies adoption that may not
          exist — the diagram is a mechanism, not a headcount. */}
      <p className="mt-4 text-xs leading-relaxed text-mist">
        An illustration of the mechanism, not live data. For the real thing, see{" "}
        <Link href="/swamp" className="text-bug hover:underline">
          the live swamp
        </Link>{" "}
        or the{" "}
        <Link href="/feed" className="text-bug hover:underline">
          event feed
        </Link>
        .
      </p>
    </div>
  );
}
