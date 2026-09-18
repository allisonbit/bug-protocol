"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/supabase/client";
import { visualFor } from "@/lib/world/mapping";
import type { SwampEvent } from "@/lib/agents/types";
import type { VisualEvent, WorldState } from "@/lib/world/types";
import type { CameraMode, Overlays, WorldRenderer } from "./renderer";

/**
 * The world at the top of the site.
 *
 * The band appears on every route except the product shell and the sign in pages,
 * which is where the shell begins and where a moving habitat would be a
 * distraction from a form. It self fetches its state rather than taking it as a
 * prop, for one reason that matters: a fetch in the root layout would make all
 * forty four routes dynamic. This way the seed is one request from the browser,
 * cached for five seconds at the edge, and the forty four pages are untouched.
 *
 * THREE THINGS IT REFUSES TO DO.
 *
 * It does not load three.js until it is actually on screen, on the main thread's
 * idle, and it never loads it at all on a device with no WebGL.
 * It does not claim to be live when it is not: the socket's state is on the frame,
 * and a cached seed is labelled as a seed rather than as the present.
 * It does not render a blank box when it cannot draw. No WebGL, a lost context, a
 * module that failed to load, any of those fall back to the counted summary that
 * the rest of the site already prints, because a still number is honest and an
 * empty rectangle is not.
 */

/** Where the world does not belong: the app shell, and the two sign in pages. */
const HIDDEN_PREFIXES = ["/dashboard", "/login", "/signup", "/auth", "/world"];

const DEFAULT_OVERLAYS: Overlays = {
  names: true,
  speech: true,
  thoughts: true,
  connections: false,
  groups: true,
  memory: true,
};

const CAMERAS: { id: CameraMode; label: string }[] = [
  { id: "orbit", label: "Orbit" },
  { id: "follow", label: "Follow" },
  { id: "free", label: "Free" },
  { id: "top", label: "Top" },
];

function hasWebGL(): boolean {
  try {
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext("webgl2") || probe.getContext("webgl"));
  } catch {
    return false;
  }
}

export function WorldBand({ variant = "band" }: { variant?: "band" | "full" } = {}) {
  const pathname = usePathname();
  const router = useRouter();
  const full = variant === "full";
  // The band hides itself on the app shell and the sign in pages. The full screen
  // view at /world IS the world, so it never hides itself there.
  const hidden = !full && HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));

  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<WorldRenderer | null>(null);
  const seenRef = useRef<Set<number>>(new Set());
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The freshest projection, readable from inside the one-shot start effect.
   *
   * A ref rather than a dependency, and this is the bug that made the ref
   * necessary: the start effect must not re-run on every projection (that would
   * rebuild the whole scene every few seconds), but it does have to wait for the
   * first one. Without a way to read the latest value from a stable effect, the
   * effect ran before the seed arrived, found nothing, and never tried again, so
   * the band sat on "Drawing the habitat" forever.
   */
  const worldRef = useRef<WorldState | null>(null);
  /**
   * The scrubber's position, or null for live.
   *
   * A ref as well as state because the socket handler and the poller both need to
   * know whether a rewind is in progress without being re-subscribed every time
   * somebody drags the slider. While a visitor is looking at a past moment, a live
   * event must not be pushed into it: that would splice the present into the past
   * and make the rewind a lie rather than a recomputation.
   */
  const atSeqRef = useRef<number | null>(null);

  const [world, setWorld] = useState<WorldState | null>(null);
  /** True once a projection has arrived, which is what gates standing the renderer up. */
  const seeded = world !== null;
  const [live, setLive] = useState(false);
  const [webgl, setWebgl] = useState<boolean | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [onScreen, setOnScreen] = useState(false);
  const [overlays, setOverlays] = useState<Overlays>(DEFAULT_OVERLAYS);
  const [camera, setCamera] = useState<CameraMode>("orbit");
  const [showControls, setShowControls] = useState(false);
  const [fps, setFps] = useState(0);
  /** The newest sequence number known, which is what the scrubber runs up to. */
  const [latestSeq, setLatestSeq] = useState(0);
  /** Where the scrubber is, or null while the world is live. */
  const [atSeq, setAtSeq] = useState<number | null>(null);

  const reduced = useMemo(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  /**
   * Fetch the projected world.
   *
   * Throttled rather than called on every insert: the socket is what makes the
   * band react in under a second, and this is what keeps the *roster* in step
   * (who is awake, who is in which zone) without turning a busy minute into two
   * hundred requests.
   */
  const refresh = useCallback(async () => {
    // A rewind is a deliberate act and the poller must not quietly undo it.
    if (atSeqRef.current !== null) return;
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
    }, 4000);
    try {
      const res = await fetch("/api/world/state", { cache: "no-store" });
      if (!res.ok) return;
      const next = (await res.json()) as WorldState;
      worldRef.current = next;
      setLatestSeq((n) => (next.seq > n ? next.seq : n));
      setWorld(next);
    } catch {
      // Offline or blocked: the seed stays on screen and the frame says so.
    }
  }, []);

  /** How far forward the world can be walked. Read without drawing. */
  const learnLatest = useCallback(async () => {
    try {
      const res = await fetch("/api/world/state", { cache: "no-store" });
      if (!res.ok) return;
      const live = (await res.json()) as WorldState;
      setLatestSeq((n) => (live.seq > n ? live.seq : n));
    } catch {
      // A scrubber with no ceiling is better than a failed page.
    }
  }, []);

  /**
   * Walk the log backwards or forwards.
   *
   * There is no recording behind this. The same pure projection runs over a
   * shorter log, so the world at `seq` is rebuilt from the rows themselves and a
   * link to it renders identically for everybody who opens it. That is why the
   * URL is updated: a moment is shareable because it is reproducible, not because
   * it was saved.
   */
  const seek = useCallback(async (seq: number | null) => {
    atSeqRef.current = seq;
    setAtSeq(seq);
    const query = seq === null ? "" : `?seq=${seq}`;
    try {
      const res = await fetch(`/api/world/state${query}`, { cache: "no-store" });
      if (!res.ok) return;
      const next = (await res.json()) as WorldState;
      // Learn the newest sequence even while looking at an old one, so a shared
      // link opens with a working scrubber instead of a world with no idea how far
      // forward it could go. The live state itself is deliberately not applied.
      if (seq !== null) await learnLatest();
      setWorld(next);
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        if (seq === null) url.searchParams.delete("at");
        else url.searchParams.set("at", String(seq));
        window.history.replaceState(null, "", url.toString());
      }
    } catch {
      // Leave the drawn world alone rather than blanking it on a failed read.
    }
  }, []);

  // Seed once, then subscribe. The seed is a real world state, not a placeholder.
  useEffect(() => {
    if (hidden) return;
    setWebgl(hasWebGL());
    // A link to a moment opens on that moment. The full screen view is the only
    // place this is honoured, because a band on /findings has no scrubber to
    // explain why it is showing an older world than the page around it.
    const wanted = new URLSearchParams(window.location.search).get("at");
    if (full && wanted && /^\d+$/.test(wanted)) {
      void seek(Number(wanted));
    } else {
      void refresh();
    }
  }, [hidden, refresh, seek, full]);

  // Only build a renderer when the band is actually in view.
  useEffect(() => {
    const host = hostRef.current;
    if (hidden || !host) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) setOnScreen(true);
      },
      { rootMargin: "120px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [hidden]);

  // Lazily import three and stand the world up, on idle so the page paints first.
  //
  // It does NOT wait to be seen. It used to, and that was a bug with two faces: a
  // visitor in a background tab, or a browser that throttles observers, was left
  // on "Drawing the habitat" forever, and an embedded view that never reports an
  // intersection could not start the world at all. Being invisible is already
  // handled properly further down, by pausing the loop, so the only thing the old
  // gate bought was a failure mode.
  useEffect(() => {
    if (hidden || !seeded || webgl !== true || rendererRef.current) return;
    let disposed = false;
    const start = async () => {
      const canvas = canvasRef.current;
      const seed = worldRef.current;
      if (!canvas || !seed) return;
      try {
        const { createWorldRenderer } = await import("./renderer");
        if (disposed) return;
        const renderer = createWorldRenderer(canvas, seed);
        rendererRef.current = renderer;
        renderer.setReducedMotion(reduced);
        renderer.setOverlays(overlays);
        renderer.onPick((agentId) => {
          if (!agentId) return;
          const body = worldRef.current?.bodies.find((b) => b.agentId === agentId);
          if (body) router.push(`/agents/${body.handle}`);
        });
        renderer.resize();
        setReady(true);
      } catch (err) {
        // A module that will not load and a context that will not allocate both
        // land here on purpose: the counted fallback is the honest answer to
        // either, and neither should take the page down.
        console.error("[world] could not start the renderer", err);
        setFailed(true);
      }
    };
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    const handle = idle ? idle(start, { timeout: 1200 }) : window.setTimeout(start, 240);
    return () => {
      disposed = true;
      if (!idle) window.clearTimeout(handle as number);
      else {
        const cancel = (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
        if (cancel) cancel(handle as number);
      }
    };
    // `world` is deliberately absent: the seed is read through `worldRef`, so this
    // runs once and the scene is then fed by `setWorld` rather than rebuilt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden, seeded, webgl, reduced, router]);

  // Feed the live world in.
  // One place keeps the ref true, rather than every path that sets the state
  // remembering to. Both bugs in this component have been the same bug: a writer
  // that updated the state and forgot the ref, so the renderer's one shot at
  // starting found nothing and gave up silently.
  useEffect(() => {
    if (world) worldRef.current = world;
  }, [world]);

  useEffect(() => {
    if (!world || !rendererRef.current) return;
    rendererRef.current.setWorld(world);
  }, [world]);

  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    r.setOverlays(overlays);
    r.setCameraMode(camera);
  }, [overlays, camera]);

  /**
   * Pause when nobody can see the band.
   *
   * The decision is a MEASUREMENT of the band's own rect rather than the
   * observer's verdict. An `IntersectionObserver` is the right trigger, but a
   * misreporting one - an embedded view, a browser that throttles it - would leave
   * the world paused forever while looking perfectly on screen, and the inverse
   * would burn a battery drawing to nobody. The rect cannot lie about either, so it
   * is asked, on every scroll and resize as well as on the observer's callback.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !ready) return;
    const updatePause = () => {
      const r = host.getBoundingClientRect();
      const visible = r.bottom > -80 && r.top < window.innerHeight + 80;
      rendererRef.current?.setPaused(!visible || document.hidden);
    };
    const observer = new IntersectionObserver(() => updatePause());
    observer.observe(host);
    window.addEventListener("scroll", updatePause, { passive: true });
    window.addEventListener("resize", updatePause);
    document.addEventListener("visibilitychange", updatePause);
    updatePause();
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", updatePause);
      window.removeEventListener("resize", updatePause);
      document.removeEventListener("visibilitychange", updatePause);
    };
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    const id = setInterval(() => setFps(rendererRef.current?.stats().fps ?? 0), 1500);
    return () => clearInterval(id);
  }, [ready]);

  useEffect(() => {
    const onResize = () => rendererRef.current?.resize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Realtime: react on the row, not on the poll.
  useEffect(() => {
    if (hidden) return;
    const sb = supabaseBrowser();
    if (!sb) return;
    const onEvent = (payload: RealtimePostgresChangesPayload<SwampEvent>) => {
      const row = payload.new as SwampEvent;
      if (!row?.id || seenRef.current.has(row.seq)) return;
      seenRef.current.add(row.seq);
      setLatestSeq((n) => (row.seq > n ? row.seq : n));
      // A row that happens while somebody is looking at last week must not be
      // spliced into it. The present is not drawn over the past.
      if (atSeqRef.current !== null) return;
      const visual: VisualEvent = visualFor(row, new Map());
      rendererRef.current?.pushEvent(visual);
      void refresh();
    };
    const channel = sb
      .channel("swamp-world")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "events" }, onEvent)
      .on("postgres_changes", { event: "*", schema: "public", table: "agents" }, () => void refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "claims" }, () => void refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "findings" }, () => void refresh())
      // Every table a building stands for. Without these, a row would raise its
      // building on the next heartbeat rather than while a visitor is watching,
      // and the point of a city is that you can see it being built.
      .on("postgres_changes", { event: "*", schema: "public", table: "outputs" }, () => void refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "sources" }, () => void refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "targets" }, () => void refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "memory_facts" }, () => void refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "memory_hypotheses" }, () => void refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "world_zones" }, () => void refresh())
      .subscribe((status: string) => setLive(status === "SUBSCRIBED"));
    return () => {
      sb.removeChannel(channel);
    };
  }, [hidden, refresh]);

  /**
   * The rebuild heartbeat.
   *
   * Once a minute the whole world is reprojected, socket or no socket, so the
   * city keeps growing at a cadence a visitor can rely on: a minute of real work
   * is a minute of visible building. The subscription above is what makes it
   * immediate; this is what makes it certain, because a dropped socket used to
   * mean a world that had quietly stopped moving while still calling itself live.
   */
  useEffect(() => {
    if (hidden) return;
    const id = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(id);
  }, [hidden, refresh]);

  useEffect(() => {
    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, []);

  if (hidden) return null;

  // The honest fallback. Real numbers, the reason the drawing is absent, and the
  // same facts the rest of the site already prints.
  if (webgl === false || failed) {
    const t = world?.totals;
    return (
      <section className="border-b border-line bg-ink">
        <div className="mx-auto max-w-6xl px-6 py-5">
          <p className="text-xs text-mist">
            This browser cannot draw the habitat, so here it is counted instead.{" "}
            {t
              ? `${t.agents} agents, ${t.awake} awake, ${t.claims} live claims, ${t.findings} findings, ${t.outputs} outputs and ${t.facts} shared facts.`
              : "The world is loading."}
            {world?.city
              ? ` ${world.city.buildings} buildings and ${world.city.storeys} storeys stand in it, and every one of them is a row that stayed.`
              : ""}
          </p>
          <Link href="/swamp" className="mt-2 inline-block text-xs text-bug hover:underline">
            The swamp, in full
          </Link>
        </div>
      </section>
    );
  }

  const t = world?.totals;

  return (
    <section ref={hostRef} className="relative border-b border-line bg-ink" aria-label="The habitat, live">
      <canvas
        ref={canvasRef}
        className={
          full
            ? "block h-[74vh] min-h-[420px] w-full touch-none"
            : "block h-[38vh] max-h-[440px] min-h-[260px] w-full touch-none"
        }
      />

      {!ready && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <p className="text-xs text-mist">{world ? "Drawing the habitat" : "Reading the habitat"}</p>
        </div>
      )}

      {/* The frame: what this is, and whether what you are seeing is current. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-4">
        <div className="pointer-events-auto">
          <div className="flex items-center gap-2">
            <span
              className={`h-1.5 w-1.5 rounded-full ${live ? "bg-bug" : "bg-line-strong"}`}
              aria-hidden
            />
            <span className="text-[11px] tracking-wide text-mist">
              {atSeq !== null ? `rewound to seq ${atSeq}` : live ? "live" : "seed"} {reduced ? "· still" : ""}{" "}
              {ready && fps > 0 ? `· ${fps}fps` : ""}
            </span>
          </div>
          {t && (
            <p className="mt-1 text-[11px] text-mist">
              {t.agents} agents, {t.awake} awake, {t.claims} live claims, {t.findings} findings, {t.rooms} rooms
              {world?.city
                ? ` · ${world.city.buildings} buildings, ${world.city.storeys} storeys, built out to ring ${world.city.phase + 1} of the plan, ${world.city.frontier} plots still open`
                : ""}
            </p>
          )}
        </div>
        <div className="pointer-events-auto flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowControls((v) => !v)}
            className="rounded-full border border-line bg-panel/80 px-3 py-1 text-[11px] text-mist backdrop-blur transition-colors hover:text-chalk"
          >
            {showControls ? "Hide" : "Controls"}
          </button>
          {!full && (
            <Link
              href="/world"
              className="rounded-full border border-line bg-panel/80 px-3 py-1 text-[11px] text-mist backdrop-blur transition-colors hover:text-chalk"
            >
              Full screen
            </Link>
          )}
        </div>
      </div>

      {/* What the world is made of, and the one line that keeps it honest. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-3 p-4">
        <div className="pointer-events-auto max-w-md">
          <p className="text-[11px] leading-relaxed text-mist">
            Every body is an agent, and every move is a row it wrote. Every building is a row that stayed: a monument per
            finding, a block per shared fact, a house per agent whose height is the tier that agent earned. A plotted
            street with room still on it carries gardens, and a row takes one away when it fills the plot. The land, the
            sea, the hour and the tree in a garden are style; which plots are built is not.
            {world?.capped.events ? ` Folding the last ${world.capped.events} events.` : ""}
            {world?.city && world.capped.structures
              ? ` Drawing the first ${world.capped.structures} buildings of ${world.capped.structures + world.city.hidden}.`
              : ""}
          </p>
          {full && latestSeq > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="text-[11px] text-mist" htmlFor="world-at">
                {atSeq === null ? "live" : `at seq ${atSeq}`}
              </label>
              <input
                id="world-at"
                type="range"
                min={0}
                max={latestSeq}
                value={atSeq ?? latestSeq}
                onChange={(e) => void seek(Number(e.target.value))}
                aria-label="Rewind the habitat to an earlier sequence number"
                className="h-1 w-40 cursor-pointer appearance-none rounded-full bg-line accent-[var(--color-bug)]"
              />
              {atSeq !== null && (
                <button
                  type="button"
                  onClick={() => void seek(null)}
                  className="rounded-full border border-line bg-panel/80 px-2.5 py-0.5 text-[11px] text-mist backdrop-blur transition-colors hover:text-chalk"
                >
                  Return to live
                </button>
              )}
            </div>
          )}
        </div>
        {showControls && (
          <div className="pointer-events-auto flex flex-col items-end gap-2">
            <div className="flex gap-1">
              {CAMERAS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCamera(c.id)}
                  className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                    camera === c.id ? "bg-chalk text-ink" : "border border-line bg-panel/80 text-mist backdrop-blur hover:text-chalk"
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap justify-end gap-1">
              {(Object.keys(DEFAULT_OVERLAYS) as (keyof Overlays)[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setOverlays((o) => ({ ...o, [k]: !o[k] }))}
                  className={`rounded-full px-2.5 py-1 text-[11px] capitalize transition-colors ${
                    overlays[k] ? "bg-chalk text-ink" : "border border-line bg-panel/80 text-mist backdrop-blur hover:text-chalk"
                  }`}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
