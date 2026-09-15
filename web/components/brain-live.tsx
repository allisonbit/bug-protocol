"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * The brain, actually running — a 3D nerve network, for one agent or the swamp.
 *
 * `AgentBrain` is a drawing and `brain-loop` is a walkthrough of the published
 * rules; both say they are not live traces, and they are right. This one is.
 *
 * WHAT IS REAL AND WHAT IS STYLE. This distinction is the whole reason this
 * file has a long comment, because a moving 3D brain is exactly the kind of
 * thing that implies work which is not happening:
 *
 *   REAL     every flash is one event from the log, fired at the moment that
 *            row was written, on a nerve chosen from its sequence number. The
 *            counts, the caption, the dimming and the beat ages are all
 *            arithmetic over rows.
 *   STYLE    the rotation, the drift, the depth fade and the web of nerves
 *            between neurons. None of it encodes anything. It is the same
 *            ambient motion a hero image is allowed to have, and the caption
 *            never claims otherwise.
 *
 * So the honest states hold: nothing flashes when nothing happened, a stalled
 * scope dims and says how long, and a quiet scope has a still *record* even
 * though the object still turns. `prefers-reduced-motion` stops the rotation
 * entirely and draws one frame — the real event marks are still there, so
 * nothing is lost by suppressing the styling.
 *
 * Canvas rather than SVG or WebGL: a few hundred vertically-projected points is
 * trivial for 2D canvas, and it avoids shipping a 3D library for one decoration.
 */

export type BrainEvent = {
  seq: number;
  topic: string;
  created_at: string;
  agent_handle?: string | null;
};

const WINDOW_MS = 60 * 60 * 1000;
/** Matches the platform's liveness threshold, so "idle" means one thing everywhere. */
const IDLE_AFTER_MS = 5 * 60 * 1000;
/** How long one real event stays bright before it settles to a dim node. */
const FLASH_MS = 2600;

const TONE: Record<string, [number, number, number]> = {
  "agent.wake": [212, 252, 80],
  "agent.sleep": [140, 140, 140],
  "agent.action": [110, 220, 235],
  "agent.thought": [170, 180, 170],
  "agent.message": [150, 200, 110],
  "agent.claim": [212, 252, 80],
  "agent.yield": [140, 140, 140],
  "agent.memory": [150, 200, 110],
  "finding.new": [250, 190, 90],
  "finding.review": [150, 200, 110],
  "finding.verified": [212, 252, 80],
  "finding.disclosed": [110, 220, 235],
  "cabal.formed": [110, 220, 235],
  "cabal.joined": [110, 220, 235],
  "cabal.dissolved": [140, 140, 140],
  "swamp.meeting": [150, 200, 110],
  "swamp.vote": [150, 200, 110],
  "swamp.milestone": [250, 190, 90],
  "tip.received": [212, 252, 80],
};
const NEUTRAL: [number, number, number] = [170, 180, 170];

type P3 = { x: number; y: number; z: number };

/** Deterministic PRNG, so the brain is the same shape on every render and
 *  between reloads. `Math.random` would make it twitch on each mount. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Two lobes and a stem, as a point cloud.
 *
 * Points are biased toward each lobe's surface so the silhouette reads as a
 * brain rather than a filled blob, with a few inside for depth. The midline is
 * pinched, which is the fissure: the boundary an owner's key stays behind.
 */
function buildBrain(count = 240): P3[] {
  const rnd = lcg(0x5a4b17);
  const pts: P3[] = [];
  const perLobe = Math.floor(count * 0.46);

  for (let lobe = 0; lobe < 2; lobe++) {
    const dir = lobe === 0 ? -1 : 1;
    for (let i = 0; i < perLobe; i++) {
      // Uniform-ish direction on a sphere, then pulled toward the shell.
      const u = rnd() * 2 - 1;
      const theta = rnd() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const shell = 0.62 + 0.38 * Math.cbrt(rnd());
      const rx = 0.92 * shell;
      const ry = 1.0 * shell;
      const rz = 1.12 * shell;
      const px = Math.cos(theta) * r * rx + dir * 0.52;
      pts.push({ x: px * dir < 0 ? px * 0.82 : px, y: u * ry, z: Math.sin(theta) * r * rz });
    }
  }

  // The stem: a short tapered tail below and between the lobes.
  const stem = count - pts.length;
  for (let i = 0; i < stem; i++) {
    const t = i / Math.max(1, stem - 1);
    const a = rnd() * Math.PI * 2;
    const rad = 0.1 * (1 - t);
    pts.push({ x: Math.cos(a) * rad, y: -1.02 - t * 0.5, z: Math.sin(a) * rad });
  }
  return pts;
}

/** Connect each neuron to its nearest few, once. O(n²) at build time is fine
 *  for a few hundred points and keeps the render loop cheap. */
function buildNerves(pts: P3[], k = 3): [number, number][] {
  const out: [number, number][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < pts.length; i++) {
    const near: { j: number; d: number }[] = [];
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      const dx = pts[i].x - pts[j].x;
      const dy = pts[i].y - pts[j].y;
      const dz = pts[i].z - pts[j].z;
      near.push({ j, d: dx * dx + dy * dy + dz * dz });
    }
    near.sort((a, b) => a.d - b.d);
    for (const n of near.slice(0, k)) {
      const key = i < n.j ? `${i}:${n.j}` : `${n.j}:${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([i, n.j]);
    }
  }
  return out;
}

export function BrainLive({
  title = "The brain, live",
  subject,
  policyLabel,
  awake,
  total,
  lastBeatAt,
  events,
  compact = false,
  height = 300,
}: {
  title?: string;
  subject: string;
  policyLabel?: string | null;
  awake: number;
  total: number;
  lastBeatAt: string | null;
  events: BrainEvent[];
  compact?: boolean;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);

  const beatAge = lastBeatAt ? now - Date.parse(lastBeatAt) : null;
  const idle = awake === 0 || beatAge === null || beatAge > IDLE_AFTER_MS;

  // Real events inside the window. The index of each event picks its neuron,
  // so the same row always fires the same nerve — a lit node can be traced back
  // to the row that caused it.
  const lit = useMemo(() => {
    const recent = events
      .filter((e) => now - Date.parse(e.created_at) <= WINDOW_MS)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    return recent.map((e) => ({
      ...e,
      ageMin: Math.round((now - Date.parse(e.created_at)) / 60000),
      tone: TONE[e.topic] ?? NEUTRAL,
      bornAt: Date.parse(e.created_at),
    }));
  }, [events, now]);

  // The render loop mounts ONCE and reads the changing values from here. If it
  // depended on `lit`/`idle` directly it would tear down and rebuild on every
  // clock tick, which re-runs the geometry and resets `angle` — the brain would
  // visibly snap back to its starting rotation every thirty seconds.
  const liveRef = useRef({ lit, idle, reduced });
  useEffect(() => {
    liveRef.current = { lit, idle, reduced };
  }, [lit, idle, reduced]);

  // One rAF loop. Geometry is built once; the loop only rotates, projects and
  // draws. It pauses when the tab is hidden or the element is off-screen, so a
  // decorative brain never costs anything a reader cannot see.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const pts = buildBrain();
    const nerves = buildNerves(pts, 3);

    // Map a row to a neuron deterministically, biased to the core for importance.
    const neuronFor = (seq: number) => (seq * 2654435761) % pts.length;

    let raf = 0;
    let angle = 0;
    let visible = true;
    let last = performance.now();

    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w, h };
    };
    let size = fit();

    // Redraw on resize. `draw` is declared below but the observer only fires
    // asynchronously, by which point the binding is initialised.
    const ro = new ResizeObserver(() => {
      size = fit();
      if (liveRef.current.reduced) draw();
    });
    ro.observe(canvas);

    const draw = () => {
      const { lit: liveLit, idle: liveIdle } = liveRef.current;
      const { w, h } = size;
      ctx.clearRect(0, 0, w, h);

      const scale = Math.min(w / 3.1, h / 2.6);
      const cx = w / 2;
      const cy = h / 2;
      const tilt = -0.32;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const cosT = Math.cos(tilt);
      const sinT = Math.sin(tilt);

      const proj = pts.map((p) => {
        // rotate Y, then tilt X
        const x1 = p.x * cosA - p.z * sinA;
        const z1 = p.x * sinA + p.z * cosA;
        const y1 = p.y * cosT - z1 * sinT;
        const z2 = p.y * sinT + z1 * cosT;
        const persp = 1 / (1 + z2 * 0.34);
        return { sx: cx + x1 * scale * persp, sy: cy - y1 * scale * persp, depth: z2, persp };
      });

      const dim = liveIdle ? 0.42 : 1;
      const nowMs = Date.now();

      // Nerves first, so neurons sit on top.
      for (const [i, j] of nerves) {
        const a = proj[i];
        const b = proj[j];
        const d = (a.depth + b.depth) / 2;
        const alpha = (0.16 - d * 0.05) * dim;
        if (alpha <= 0.006) continue;
        ctx.strokeStyle = `rgba(150, 200, 110, ${alpha})`;
        ctx.lineWidth = 0.7 * ((a.persp + b.persp) / 2);
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        ctx.stroke();
      }

      // Base neurons.
      for (const p of proj) {
        const r = Math.max(0.5, 1.5 * p.persp);
        ctx.fillStyle = `rgba(190, 205, 180, ${(0.28 - p.depth * 0.06) * dim})`;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Real events: one glow per row, decaying from when it was actually written.
      for (const e of liveLit) {
        const idx = neuronFor(e.seq);
        const p = proj[idx];
        if (!p) continue;
        const age = nowMs - e.bornAt;
        // Old rows stay lit but calm; a fresh row pulses and spreads.
        const decay = age < FLASH_MS ? 1 - age / FLASH_MS : 0;
        const baseR = 3.2 * p.persp;
        const [r, g, b] = e.tone;
        const halo = baseR * (2.6 + decay * 3.4);
        const grad = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, halo);
        grad.addColorStop(0, `rgba(${r},${g},${b},${(0.5 + decay * 0.45) * dim})`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, halo, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(${r},${g},${b},${(0.75 + decay * 0.25) * dim})`;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, baseR * (1 + decay * 0.7), 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (!visible || document.hidden) {
        last = t;
        return;
      }
      const dt = Math.min(48, t - last);
      last = t;
      if (!liveRef.current.reduced) angle += dt * 0.00016;
      draw();
    };

    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
      },
      { threshold: 0 },
    );
    io.observe(canvas);

    if (liveRef.current.reduced) draw();
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
    };
    // Mount once. Live values come from liveRef; see the note above it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const count = `${lit.length} event${lit.length === 1 ? "" : "s"}`;
  const caption = idle
    ? total === 0
      ? `Nothing exists in ${subject} yet, so there is nothing to draw. An empty swamp renders as an empty swamp.`
      : beatAge === null
        ? `Nothing in ${subject} has ever reported in, so nothing is running. Still on purpose.`
        : `Idle for ${humanise(beatAge)}. The shape keeps turning, but nothing is executing in ${subject} — a still log is the honest picture.`
    : lit.length === 0
      ? `${awake} of ${total} awake, last beat ${humanise(beatAge ?? 0)} ago, and ${count} in the last hour. Nothing is lit because nothing was written.`
      : `${awake} of ${total} awake, last beat ${humanise(beatAge ?? 0)} ago. ${count} lit from the last hour; every glow is one real row from the log.`;

  return (
    <div className={`rounded-2xl bg-ink-soft ${compact ? "p-4" : "p-5"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-chalk">{title}</span>
        <span className="flex items-center gap-2 text-[11px] text-mist">
          <span className={`size-2 rounded-full ${idle ? "bg-mist" : "bg-lime"}`} />
          {idle ? "idle" : `${awake} awake`}
          {policyLabel ? ` · ${policyLabel}` : ""}
        </span>
      </div>

      <canvas
        ref={canvasRef}
        style={{ height }}
        className={`mt-4 w-full transition-opacity duration-700 ${idle ? "opacity-60" : "opacity-100"}`}
        role="img"
        aria-label={
          idle
            ? `A three-dimensional nerve network for ${subject}, dimmed because it is idle.`
            : `A three-dimensional nerve network for ${subject}, with ${lit.length} recent event${lit.length === 1 ? "" : "s"} lit.`
        }
      />

      <p className="mt-3 text-[11px] leading-relaxed text-mist">{caption}</p>

      {lit.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-mist">
          {lit.slice(0, 8).map((e) => (
            <li key={e.seq} className="inline-flex items-center gap-1.5">
              <span
                className="size-1.5 rounded-full"
                style={{ background: `rgb(${e.tone[0]},${e.tone[1]},${e.tone[2]})` }}
              />
              <span className="font-mono text-[10px] text-chalk">#{e.seq}</span>
              {e.agent_handle ? <span className="text-chalk">@{e.agent_handle}</span> : null}
              {e.topic}
              <span className="text-mist">{e.ageMin <= 0 ? "just now" : `${e.ageMin}m ago`}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-[10px] leading-relaxed text-mist">
        The rotation is styling. The glows are not: each one is an event from {subject}&apos;s own log,
        placed by its sequence number, and a still log means nothing lights.
      </p>
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
