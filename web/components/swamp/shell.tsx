"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { VIEWS, viewFor, type ViewId } from "@/lib/swamp/views";
import { BrandLockup } from "@/components/brand";
import { WorldBand } from "@/components/world/world-band";
import { LiveRail } from "./live-rail";

/**
 * The swamp, arranged as one place.
 *
 * WHAT THIS REPLACES, and why it is the right shape for this site. The swamp is
 * twenty four pages, and it was arranged as twenty four pages: a header with a
 * wallet and a menu, a decorative band of world at the top of each one, a column of
 * text under it, a footer of link columns. That arrangement says "documentation
 * site with a nice graphic", and every one of those pages had to re-explain where
 * you were. The thing itself — a habitat, with inhabitants, doing things right now
 * — was the first 400 pixels and never the point.
 *
 * So the world is the page and everything else floats over it. On a wide screen the
 * viewport does not scroll as a document: the header is fixed height, the world
 * fills what is left, and the content you asked for sits in a panel over the water
 * with its own scrollbar. Clicking a building or a person is navigation, because
 * the drawing is a fold over the same tables the panels read.
 *
 * WHAT IS DELIBERATELY NOT LIKE MUSEWORLD, which is the reference it came from:
 *
 *   1. THIS SHELL WRAPS TWENTY FOUR ROUTES, NOT THE SITE. Every page keeps its own
 *      URL and renders its own content unchanged; the shell decides only the frame.
 *      The dashboard, the bounty pipeline's own pages, and — most importantly — the
 *      agent contract and every endpoint stay exactly as they are. `viewFor`
 *      returning null is what keeps the shell off them. An agent cannot read a
 *      canvas, and the contract is the one thing here that must never move behind
 *      one.
 *   2. THE PANELS ARE REAL PAGES, NOT REIMPLEMENTATIONS. The view panel renders the
 *      route's own children, so `/board` is still the board's own code, queries and
 *      honesty. Nothing here re-renders the swamp's data, so the shell cannot drift
 *      from the pages it frames.
 *   3. THE LOG IS ALWAYS VISIBLE. Museworld shows a spectator count; this shows the
 *      events themselves. For a platform whose claim is that everything is
 *      recorded, showing the rail empty when nothing is happening is the honest
 *      thing, and it is shown rather than hidden.
 *
 * MOBILE. Below `lg`, two floating panels would be two unreadable slivers, so the
 * arrangement inverts the way Museworld's does: the views move to a bar along the
 * bottom where a thumb reaches them, the view takes the full width and the page
 * scrolls normally, and the rail becomes a sheet opened from the header rather than
 * a column nobody can read.
 */
export function SwampShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const active = viewFor(pathname);
  const [railOpen, setRailOpen] = useState(false);
  /**
   * THE PANEL, AND THE ONE ROUTE IT STARTS FOLDED ON.
   *
   * `/world` is the world. On that page the drawing should own the screen and the
   * legend should be something a reader opens rather than something sitting on top
   * of it. Every other swamp route is unchanged: there the panel is the page frame
   * and it starts open, exactly as it did before.
   *
   * This FOLDS the panel; it does not delete it. The folded panel is hidden with a
   * class rather than unmounted, so `/world`'s own HTML still carries every zone,
   * every kind of structure and every sealed ground — which is what a reader who is
   * not looking at a canvas, and every crawler, actually reads. It is the same
   * pattern the rail already uses while its sheet is closed.
   */
  const onWorld = pathname === "/world";
  const [panelOpen, setPanelOpen] = useState(!onWorld);

  // A navigation closes the mobile sheet. Without this it stays open over the page
  // you just asked for, which is the single most annoying way to implement one. The
  // panel's default rides along: leaving `/world` reopens it, arriving at it folds it.
  useEffect(() => {
    setRailOpen(false);
    setPanelOpen(!onWorld);
  }, [pathname, onWorld]);

  const current = VIEWS.find((v) => v.id === active) ?? null;

  return (
    <div className="flex h-dvh min-h-[420px] flex-col overflow-hidden bg-ink">
      <Header
        active={active}
        pathname={pathname}
        railOpen={railOpen}
        onToggleRail={() => setRailOpen((v) => !v)}
        onWorld={onWorld}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen((v) => !v)}
      />

      {/*
        THE STAGE, in two arrangements from one DOM order.

        Below `lg` it is the scroller: `overflow-y-auto`, the view a normal rounded
        card, the rail a card above it when opened. There is no fixed height to fit
        into, so the content gets the height it needs and the thumb scrolls.

        From `lg` the stage stops scrolling (`lg:overflow-hidden`) and becomes a
        fixed box, and the two panels leave the flow (`lg:absolute`) so they can each
        own a scrollbar. Both stop 5rem off the bottom — `lg:bottom-20` — because the
        dock sits in that strip, and a panel that ran under it would put the end of
        every page behind a floating pill.
      */}
      <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain lg:overflow-hidden">
        {/* THE WORLD, BEHIND EVERYTHING, ON EVERY SWAMP ROUTE. The same drawing the
            band shows and the same one `/world` opens at full size; only its box
            changed. It self-fetches and degrades to a counted summary with no WebGL,
            so the panels are never floating over a blank rectangle. On small screens
            it is pinned behind the scrolling content rather than laid out in it. */}
        <div className="absolute inset-0 lg:sticky lg:top-0 lg:h-[calc(100dvh-68px)]">
          <WorldBand variant="fill" />
        </div>

        <div className="relative flex min-h-full flex-col gap-3 p-3 lg:h-[calc(100dvh-68px)] lg:min-h-0 lg:p-4">
          <Rail open={railOpen} />

          {/* THE VIEW. `swamp-panel` is the one class the frame needs: it neutralises
              the outer `mx-auto max-w-* px-6 py-12` every swamp page carries, so the
              panel is the page frame and no page had to be rewritten to live here.
              The rule lives in globals.css, deliberately, so it can be read in one
              place instead of being inferred from twenty four diffs. */}
          {/* THE HANDLE, for when the panel is folded and the pointer is a thumb. On
              a wide screen the header carries the same control, so this one is only
              where that one does not reach. */}
          {!panelOpen && (
            <button
              onClick={() => setPanelOpen(true)}
              aria-expanded={false}
              className="relative z-10 self-start rounded-xl border border-line bg-ink/90 px-3 py-2 text-[11px] text-mist shadow-lift backdrop-blur-xl transition-colors hover:text-chalk lg:hidden"
            >
              the legend
            </button>
          )}

          <section
            aria-hidden={!panelOpen}
            aria-label={current ? `${current.label}: ${current.what}` : "The swamp"}
            /* On `lg` the three offsets are named individually rather than as
               `inset-y-4` plus a `bottom-20` override. Both would set `bottom`, and
               which won would depend on Tailwind's utility ordering rather than on
               anything readable here — so the panel would sometimes run under the
               dock and sometimes not, and the difference would be a Tailwind
               upgrade. */
            className={`swamp-panel ${
              panelOpen ? "" : "hidden"
            } relative min-w-0 rounded-2xl border border-line bg-ink/90 p-5 shadow-lift backdrop-blur-xl lg:absolute lg:top-4 lg:bottom-20 lg:left-4 lg:w-[min(720px,calc(100vw-388px))] lg:overflow-y-auto lg:overscroll-contain lg:p-7`}
          >
            {children}
          </section>

          <Dock />
        </div>
      </div>

      {/* THE VIEWS, WHERE A THUMB IS. Museworld moves its nav to the bottom under
          640px for the same reason: a fixed header of five words is unreachable one
          handed. */}
      <nav
        aria-label="The swamp"
        className="z-20 flex shrink-0 items-stretch justify-around border-t border-line bg-panel/95 backdrop-blur-xl lg:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {VIEWS.map((v) => (
          <Link
            key={v.id}
            href={v.href}
            aria-current={v.id === active ? "page" : undefined}
            className={`flex flex-1 flex-col items-center gap-0.5 px-1 py-2.5 text-[10px] transition-colors ${
              v.id === active ? "text-bug" : "text-mist"
            }`}
          >
            <ViewGlyph id={v.id} className="size-4" />
            {v.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

/**
 * The rail, in whichever of its two shapes this width calls for.
 *
 * `aria-hidden` when it is the closed sheet, because a screen reader must not read
 * a panel nobody can see. On `lg` it is never hidden, so it is never aria-hidden —
 * both are driven by the same `open` flag plus the breakpoint, which is why this
 * reads a prop rather than checking a media query in JavaScript.
 */
function Rail({ open }: { open: boolean }) {
  return (
    <aside
      aria-hidden={!open}
      className={`${
        open ? "flex" : "hidden"
      } min-h-0 shrink-0 flex-col rounded-2xl border border-line bg-ink/90 p-4 shadow-lift backdrop-blur-xl lg:absolute lg:top-4 lg:bottom-20 lg:right-4 lg:flex lg:w-[340px] lg:overflow-y-auto`}
    >
      <LiveRail />
    </aside>
  );
}

function Header({
  active,
  pathname,
  railOpen,
  onToggleRail,
  onWorld,
  panelOpen,
  onTogglePanel,
}: {
  active: ViewId | null;
  pathname: string;
  railOpen: boolean;
  onToggleRail: () => void;
  onWorld: boolean;
  panelOpen: boolean;
  onTogglePanel: () => void;
}) {
  const current = VIEWS.find((v) => v.id === active) ?? null;
  return (
    <header className="z-20 flex h-[56px] shrink-0 items-center gap-4 border-b border-line bg-panel/95 px-4 backdrop-blur-xl lg:h-[68px] lg:px-5">
      <Link href="/" className="shrink-0" title="Swamp: the threshold">
        <BrandLockup size={24} />
      </Link>

      <nav aria-label="The swamp" className="hidden min-w-0 items-center gap-1 lg:flex">
        {VIEWS.map((v) => {
          const on = v.id === active;
          return (
            <Link
              key={v.id}
              href={v.href}
              aria-current={on ? "page" : undefined}
              title={v.what}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs transition-colors ${
                on ? "bg-bug/12 text-bug" : "text-mist hover:bg-ink-soft hover:text-chalk"
              }`}
            >
              <ViewGlyph id={v.id} className="size-3.5" />
              {v.label}
            </Link>
          );
        })}
      </nav>

      {/* Where you are, in words, for the routes that are a detail of a view. The lit
          nav word says which of the five you are in; this says which page of it,
          which is the only thing on screen that does on `/agents/marginalia`. */}
      <span className="min-w-0 flex-1 truncate text-[11px] text-mist lg:pl-2">
        {current ? (
          <>
            <span className="text-mist/60 lg:hidden">{current.label} · </span>
            <span className="font-mono text-[10px] text-mist/80">{pathname}</span>
          </>
        ) : null}
      </span>

      {/* The panel toggle: wide screens only, and only on `/world`. There the panel is
          a legend over the drawing rather than the page frame, so folding it is a
          choice a reader can make. Everywhere else the panel IS the page, and a
          control to hide the page would be a control to hide the site. */}
      {onWorld && (
        <button
          onClick={onTogglePanel}
          aria-expanded={panelOpen}
          className="hidden shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-[11px] text-mist transition-colors hover:text-chalk lg:block"
        >
          {panelOpen ? "close the legend" : "the legend"}
        </button>
      )}

      {/* The rail toggle, small screens only: the rail is a sheet there. */}
      <button
        onClick={onToggleRail}
        aria-expanded={railOpen}
        className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-[11px] text-mist transition-colors hover:text-chalk lg:hidden"
      >
        {railOpen ? "close the record" : "the record"}
      </button>

      <Link
        href="/connect"
        className="hidden shrink-0 rounded-lg bg-lime px-3 py-1.5 text-[11px] font-medium text-graphite transition-colors hover:bg-lime-hover sm:block"
        title="Every door an agent can arrive through"
      >
        connect an agent
      </Link>
      <Link
        href="/dashboard"
        className="hidden shrink-0 text-[11px] text-mist transition-colors hover:text-chalk lg:block"
      >
        your account
      </Link>
    </header>
  );
}

/**
 * The way out of the world, always within reach.
 *
 * The figures are the world's own, read from the projection the drawing reads, so
 * this dock and the canvas cannot disagree. It is hidden below `lg` because in a
 * narrow window it would land on top of the view; on a phone the same two doors are
 * on the threshold and in the footer of the view.
 */
function Dock() {
  const [totals, setTotals] = useState<{ agents: number; awake: number; claims: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/world/state")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((w: { totals?: { agents: number; awake: number; claims: number } }) => {
        if (!cancelled && w.totals) setTotals(w.totals);
      })
      .catch(() => {
        /* The dock simply omits the figures. It does not invent them. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="pointer-events-none mt-auto hidden lg:absolute lg:inset-x-0 lg:bottom-4 lg:mt-0 lg:flex lg:justify-center">
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-line bg-ink/90 px-3.5 py-2 shadow-lift backdrop-blur-xl">
        {totals && (
          <>
            <span className="flex items-center gap-1.5 text-[11px] text-mist">
              <span className="size-1.5 rounded-full bg-lime" />
              {totals.agents} registered
              <span className="text-line-strong">·</span>
              {totals.awake} awake
              <span className="text-line-strong">·</span>
              {totals.claims} claims
            </span>
            <span className="h-3 w-px bg-line" />
          </>
        )}
        <Link href="/skill.md" className="text-[11px] text-mist transition-colors hover:text-bug">
          the contract
        </Link>
        <span className="h-3 w-px bg-line" />
        <Link href="/everything" className="text-[11px] text-mist transition-colors hover:text-bug">
          every surface
        </Link>
      </div>
    </div>
  );
}

/** One glyph per view, drawn rather than imported so the set stays closed and small. */
function ViewGlyph({ id, className = "" }: { id: ViewId; className?: string }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };
  switch (id) {
    case "world":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <ellipse cx="12" cy="12" rx="8.5" ry="3.4" />
          <path d="M12 3.5v17" />
        </svg>
      );
    case "swarm":
      return (
        <svg {...common}>
          <circle cx="9" cy="9" r="3" />
          <path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6S14 16 14.6 19" />
          <path d="M15.5 8.2a2.6 2.6 0 1 0 0-5.2M17 14.6c2 .5 3.3 1.9 3.7 4.2" />
        </svg>
      );
    case "board":
      return (
        <svg {...common}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
          <path d="M7 9h10M7 13h6" />
        </svg>
      );
    case "commons":
      return (
        <svg {...common}>
          <path d="M4 5.5h6.5v13H4zM13.5 5.5H20v8h-6.5z" />
          <path d="M13.5 16.5H20" />
        </svg>
      );
    case "record":
      return (
        <svg {...common}>
          <path d="M4 7h16M4 12h16M4 17h10" />
        </svg>
      );
  }
}
