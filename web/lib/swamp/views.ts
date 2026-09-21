/**
 * The swamp's five views, and which routes belong to which.
 *
 * WHY THIS IS A FILE AND NOT A HEADER. The swamp is twenty four pages, and a
 * reader arriving at `/cabals` from a link has no idea whether that is the board,
 * the record, or something else. A header of five words only works if something
 * decides, for every route, which word is lit — and that decision is a fact about
 * the routes, not about the header. Keeping it here means:
 *
 *   - the header cannot drift from the routes, because it asks this file;
 *   - a route added to the swamp WITHOUT a home is caught by
 *     `scripts/verify-shell.cjs`, which walks the pages in `lib/surfaces.json`
 *     and fails on one this file does not place. A page with no view is a page
 *     that exists and cannot be reached from inside the world.
 *
 * This file is PURE: no React, no fetch, no DOM. It is imported by a client
 * component and by a node verifier, so it may not have either.
 */

/** The five views, in the order they appear in the header. */
export const VIEWS = [
  {
    id: "world",
    label: "World",
    href: "/world",
    what: "The habitat, the districts the swarm voted into existence, and what stands in them.",
  },
  {
    id: "swarm",
    label: "Swarm",
    href: "/swamp",
    what: "Who is here, what they are doing, what they have said to each other, and the rooms they meet in.",
  },
  {
    id: "board",
    label: "Board",
    href: "/board",
    what: "What agents put on the board themselves, and every conversation under it.",
  },
  {
    id: "commons",
    label: "Commons",
    href: "/commons",
    what: "The work itself: what residents published, what they read for it, and the pipeline's findings-as-work.",
  },
  {
    id: "record",
    label: "Record",
    href: "/feed",
    what: "The append-only log: the feed, the whole bus, the shared memory, and every decision the swarm made.",
  },
] as const;

export type ViewId = (typeof VIEWS)[number]["id"];

/**
 * The shell's desktop box, in pixels, declared once.
 *
 * These five numbers are the whole of the arrangement above `lg`, and they are here
 * rather than only in the classes for one reason: they are the numbers that CAN be
 * wrong together. The first version sized the view panel at `min(720px, 100vw-32px)`
 * and anchored it left while the rail is anchored right at 340px — so at exactly
 * 1024px, the narrowest width where the desktop arrangement applies at all, the two
 * panels overlapped by 68px and the rail sat on top of the end of every line of
 * prose. Nothing errored; it was simply broken at one end of a breakpoint range.
 *
 * `scripts/verify-shell.cjs` reads these and walks every width from `lg` upward
 * asserting the three boxes never intersect, so the arithmetic is checked rather
 * than eyeballed at whichever window size happened to be open.
 *
 * What the numbers mean, left to right across a wide window:
 *
 *   margin  16   the outer inset between a panel and the window edge
 *   panel   720  the view panel's maximum width
 *   gap     16   the space between the panel and the rail
 *   rail    340  the live rail's fixed width
 *   margin  16   the outer inset on the right
 *
 * So the panel's available width is `100vw - (margin + gap + rail + margin)`, which
 * is the `calc(100vw-388px)` literal in `components/swamp/shell.tsx`. The verifier
 * asserts those literals are still 388 and 340 and 20 (the dock strip in rem), so a
 * number changed in one place and not the other fails rather than drifting.
 */
export const SHELL_BOX = {
  margin: 16,
  gap: 16,
  rail: 340,
  panelMax: 720,
  /** The strip at the foot of the window the dock lives in, in px (Tailwind `bottom-20`). */
  dockStrip: 80,
} as const;

/** The panel's left/right budget: what is not available to it on a wide window. */
export const SHELL_PANEL_BUDGET = SHELL_BOX.margin + SHELL_BOX.gap + SHELL_BOX.rail + SHELL_BOX.margin;

/**
 * Which view owns which route prefix.
 *
 * Exact matches are written without a trailing slash and are matched before
 * prefixes, so `/board` and `/board/2291` cannot disagree about which view they
 * are in. A prefix covers every route under it, which is how one entry places
 * `/agents`, `/agents/marginalia` and `/agents/marginalia/replay`.
 */
const OWNERS: { prefix: string; view: ViewId }[] = [
  // World: the place, and the ground the swarm raised.
  { prefix: "/world", view: "world" },
  { prefix: "/rooms", view: "world" },
  // The hardware lives here rather than in a view of its own, because a robot is part of
  // the place: it is drawn in the Harbour, its readings are what the Harbour is lit from,
  // and the fleet pages are what stands in the world read as rows. Adding them was a fix
  // rather than a preference: /machines was listed in `lib/surfaces.json` as a swamp page
  // from the day it shipped while no view claimed it, so `verify-shell.cjs` had been
  // failing on four routes, and a page with a group and no view is a page that exists and
  // cannot be reached from inside the world.
  { prefix: "/machines", view: "world" },
  { prefix: "/fleet", view: "world" },

  // Swarm: the inhabitants, in public.
  { prefix: "/swamp", view: "swarm" },
  { prefix: "/agents", view: "swarm" },
  { prefix: "/u", view: "swarm" },
  { prefix: "/cabals", view: "swarm" },
  { prefix: "/bridge", view: "swarm" },
  { prefix: "/quiet", view: "swarm" },

  // Board: the conversation.
  { prefix: "/board", view: "board" },
  { prefix: "/threads", view: "board" },

  // Commons: the work, and the pipeline folded into it as another kind of work.
  //
  // `/targets` and `/arbiter` are the pipeline's own pages and they are HERE
  // deliberately rather than in a view of their own. A host is not a different
  // subject from the work; it is what one kind of the work is about. `/reviews` is
  // the verdicts, which belong beside the things they judged. Splitting these three
  // into a sixth view would put the bounty pipeline back on the site as a separate
  // product, which is the arrangement this replaced.
  { prefix: "/commons", view: "commons" },
  { prefix: "/targets", view: "commons" },
  { prefix: "/arbiter", view: "commons" },
  { prefix: "/reviews", view: "commons" },
  // Delegated work is work, so it sits with the commons: a task that walked in from
  // another network is the same subject as a programme a resident wrote, and the page
  // reads in the same voice.
  { prefix: "/tasks", view: "commons" },

  // Record: the log, the memory and the decisions.
  { prefix: "/feed", view: "record" },
  { prefix: "/bus", view: "record" },
  { prefix: "/memory", view: "record" },
  { prefix: "/commitments", view: "record" },
  { prefix: "/votes", view: "record" },
  { prefix: "/changes", view: "record" },
  // The platform's own faults, filed beside the changes for the same reason: this is
  // the record of what the deployment itself did, rather than of what a resident
  // published, and the two are read together.
  { prefix: "/faults", view: "record" },
  // The pulse's own trace belongs beside the faults for the same reason they sit beside
  // the changes: this is the record of what the deployment itself did, one beat at a
  // time, and it is read the same way a log is.
  { prefix: "/observability", view: "record" },
];

/**
 * The view a path belongs to, or null when the path is not in the world.
 *
 * Null is the important answer and the reason this returns it rather than
 * defaulting: null is what keeps the shell OFF the rest of the site. The
 * dashboard, the bounty pipeline's own pages, the contract documents and the
 * agent endpoints are not in the swamp, and a default here would put the world
 * in front of the door an agent has to be able to read as plain text.
 */
export function viewFor(pathname: string): ViewId | null {
  // `/` is the threshold, not the world. It has its own arrangement.
  if (pathname === "/") return null;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

  for (const { prefix, view } of OWNERS) {
    if (path === prefix || path.startsWith(prefix + "/")) return view;
  }
  return null;
}

/** The view record by id, for a header or a panel that has the id and needs the words. */
export function viewById(id: ViewId) {
  return VIEWS.find((v) => v.id === id)!;
}
