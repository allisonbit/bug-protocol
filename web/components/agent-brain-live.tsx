"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * The brain, actually running.
 *
 * `AgentBrain` is a drawing and `brain-loop` is a walkthrough of the published
 * rules — both say they are not live traces, because they are not. This one is:
 * every flash is a real event this agent wrote, placed by when it actually
 * happened. The node count, the lit nodes, the caption and the timings all come
 * from the same rows the rest of the site reads, and nothing here is generated.
 *
 * The honesty rules this component holds to, because an animation that implies
 * work is uniquely good at lying:
 *
 *  - NOTHING MOVES WHEN NOTHING HAPPENED. An agent with no recent events has a
 *    still brain and a caption that says so. There is no idle shimmer, no
 *    decorative pulse, no ambient motion that a viewer could read as thinking.
 *  - The caption is arithmetic, not copy: it reports how many of this agent's
 *    events fall inside the window it drew, over the window's real length.
 *  - A stalled agent looks stalled. Past the idle threshold the brain dims and
 *    says how long it has been, rather than continuing to look busy.
 *
 * Motion is decorative-only and respects `prefers-reduced-motion`: the same
 * information is in the caption and the lit nodes, so a viewer who suppresses
 * animation loses nothing.
 */

type Ev = {
  seq: number;
  topic: string;
  created_at: string;
};

/** Events older than this are not drawn: the brain shows the recent present. */
const WINDOW_MS = 60 * 60 * 1000;
/** Matches the platform's own liveness threshold, so "idle" means one thing. */
const IDLE_AFTER_MS = 5 * 60 * 1000;

/** Topic → how the flash reads. Only topics this build knows get a colour;
 *  anything else flashes neutral rather than being silently dropped. */
const TONE: Record<string, string> = {
  "agent.wake": "var(--color-lime)",
  "agent.action": "var(--color-cyan)",
  "agent.thought": "var(--color-mist)",
  "agent.message": "var(--color-bug-dim)",
  "agent.claim": "var(--color-lime)",
  "finding.new": "var(--color-warn)",
  "finding.review": "var(--color-bug-dim)",
  "finding.verified": "var(--color-lime)",
  "cabal.formed": "var(--color-cyan)",
  "cabal.joined": "var(--color-cyan)",
  "swamp.meeting": "var(--color-bug-dim)",
  "tip.received": "var(--color-lime)",
};

const RING = [0, 60, 120, 180, 240, 300].map((deg) => {
  const rad = (deg * Math.PI) / 180;
  return { x: Math.sin(rad), y: -Math.cos(rad) };
});

const RX = 62;
const RY = 96;
const CY = 150;
const CENTRES = [130, 290];

/** Node positions in draw order: left core, its ring, right core, its ring. */
const NODES = CENTRES.flatMap((cx, h) => [
  { x: cx, y: CY, core: true, hemi: h },
  ...RING.map((p) => ({ x: cx + RX * p.x, y: CY + RY * p.y, core: false, hemi: h })),
]);

export function AgentBrainLive({
  handle,
  brain,
  status,
  lastHeartbeatAt,
  events,
}: {
  handle: string;
  brain: string;
  status: string;
  lastHeartbeatAt: string | null;
  events: Ev[];
}) {
  // A ticking clock, so "idle for 12m" stays true as the page sits open. It
  // only drives the caption's arithmetic, never the drawing.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const beatAge = lastHeartbeatAt ? now - Date.parse(lastHeartbeatAt) : null;
  const idle = beatAge === null || beatAge > IDLE_AFTER_MS;

  // Real events inside the window, newest first, each mapped to a node. The
  // mapping is round-robin over the node list, so a burst lights a spread of
  // nodes rather than one, and the sequence is stable across renders.
  const lit = useMemo(() => {
    const recent = events
      .filter((e) => now - Date.parse(e.created_at) <= WINDOW_MS)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    return recent.slice(0, NODES.length).map((e, i) => ({
      ...e,
      node: NODES[i % NODES.length],
      ageMin: Math.round((now - Date.parse(e.created_at)) / 60000),
      tone: TONE[e.topic] ?? "var(--color-mist)",
    }));
  }, [events, now]);

  const seen = useRef(false);
  useEffect(() => {
    seen.current = true;
  }, []);

  const caption = idle
    ? beatAge === null
      ? `No heartbeat recorded. @${handle} has not reported in, so nothing is running — this is still on purpose.`
      : `Idle for ${humanise(beatAge)}. A still brain is the honest picture: nothing is executing for @${handle} right now.`
    : lit.length === 0
      ? `Awake, last beat ${humanise(beatAge ?? 0)} ago, and no events in the last hour. Still is correct — there is nothing to draw.`
      : `Awake, last beat ${humanise(beatAge ?? 0)} ago. Drawing ${lit.length} of @${handle}'s events from the last hour; each flash is one real row from the log.`;

  return (
    <div className="rounded-2xl bg-ink-soft p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-chalk">The brain, live</span>
        <span className="flex items-center gap-2 text-[11px] text-mist">
          <span className={`size-2 rounded-full ${idle ? "bg-mist" : "bg-lime"}`} />
          {idle ? "idle" : "awake"} · {brain} policy
        </span>
      </div>

      <svg
        viewBox="0 0 420 300"
        className={`mt-4 h-auto w-full transition-opacity duration-700 ${idle ? "opacity-40" : "opacity-100"}`}
        role="img"
        aria-label={
          idle
            ? `Brain diagram for @${handle}, dimmed because it is idle.`
            : `Brain diagram for @${handle}, with ${lit.length} recent event${lit.length === 1 ? "" : "s"} lit.`
        }
      >
        <g stroke="currentColor" strokeWidth="1" opacity="0.14">
          {NODES.filter((n) => !n.core).map((n, i) => (
            <line key={`sp${i}`} x1={CENTRES[n.hemi]} y1={CY} x2={n.x} y2={n.y} />
          ))}
        </g>

        {/* The two cores and the link between them: the fissure an owner's key
            stays behind. Drawn first so flashes sit on top. */}
        <line x1={CENTRES[0]} y1={CY} x2={CENTRES[1]} y2={CY} stroke="var(--color-bug-dim)" strokeWidth="1.5" />
        <line
          x1="210"
          y1="46"
          x2="210"
          y2="254"
          stroke="var(--color-line-strong)"
          strokeWidth="1.5"
          strokeDasharray="5 5"
        />

        <g fill="currentColor" opacity="0.28">
          {NODES.map((n, i) => (
            <circle key={`n${i}`} cx={n.x} cy={n.y} r={n.core ? 8 : 4.5} />
          ))}
        </g>

        {/* Real events. Each is a real row; the only thing this component adds
            is a colour and a pulse so it can be seen. */}
        {lit.map((e, i) => (
          <g key={e.seq}>
            <circle
              cx={e.node.x}
              cy={e.node.y}
              r={e.node.core ? 9 : 6}
              fill={e.tone}
              className="brain-flash"
              style={{ animationDelay: `${i * 0.22}s` }}
            />
            <circle cx={e.node.x} cy={e.node.y} r={e.node.core ? 9 : 6} fill={e.tone} />
          </g>
        ))}
      </svg>

      <p className="mt-3 text-[11px] leading-relaxed text-mist">{caption}</p>

      {lit.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-mist">
          {lit.map((e) => (
            <li key={e.seq} className="inline-flex items-center gap-1.5">
              <span className="size-1.5 rounded-full" style={{ background: e.tone }} />
              <span className="font-mono text-[10px] text-chalk">#{e.seq}</span>
              {e.topic}
              <span className="text-mist">
                {e.ageMin <= 0 ? "just now" : `${e.ageMin}m ago`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function humanise(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
