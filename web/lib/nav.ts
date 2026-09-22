import surfaces from "./surfaces.json";

/**
 * ONE NAVIGATION, FIVE MENUS, AND EVERY PAGE IN ONE OF THEM.
 *
 * WHY THIS FILE EXISTS. The site was arranged as two sites. Twenty four routes lived
 * in the swamp shell, which offers five words and nothing else, and the other thirty
 * five lived under a document header with a flat row of thirteen links. Neither list
 * contained the whole product, so from inside the swamp about twenty pages were
 * simply unreachable — you had to already know the URL, or find `/everything`, which
 * was itself one of the links you could not see. The complaint that produced this
 * file was exact: the visitor could not see that more existed.
 *
 * So there is one list, here, grouped into the five menus that appear in the header
 * of every page, and the rule this file is built to satisfy is TOTALITY: every page
 * `lib/surfaces.json` lists is either IN a menu, or a DETAIL reachable from a menu
 * entry (a specific agent, one conversation, one room — things a menu cannot name in
 * advance because there are as many as there are rows), or explicitly NOT in a menu
 * with the reason written down. `scripts/verify-nav.cjs` walks all three sets and
 * fails on a page that is in none of them, which is the only way a list like this
 * stays complete rather than becoming complete on the day it was written.
 *
 * WHAT THIS FILE DOES NOT DO. It does not carry descriptions. Every entry's one line
 * comes from `lib/surfaces.json` by lookup, so the words in the menu and the words on
 * `/everything` are the same words and cannot drift into disagreeing about what a
 * page is. Neither file repeats the other's job: surfaces.json says what exists,
 * this file says where it sits.
 *
 * PURE, deliberately, exactly like `lib/swamp/views.ts`: no React, no fetch, no DOM.
 * It is imported by a client component, by the swamp shell, and by a node verifier,
 * so it may not depend on any of them.
 */

/** A page that lives in the swamp shell rather than under a document header. */
export type MenuId = "swamp" | "world" | "commons" | "record" | "start";

type Entry = {
  /** A path exactly as `lib/surfaces.json` spells it. May be a `[template]`. */
  path: string;
  /** What the menu calls it. Short, because it sits in a column. */
  label: string;
};

export type NavEntry = {
  path: string;
  label: string;
  /** Where the link actually goes: the path, or a real instance of a template. */
  href: string;
  /** The one line from surfaces.json. Never written here. */
  what: string;
  /** True for a machine-readable document rather than a page. */
  doc: boolean;
  /** True when this entry is the page you are on. */
  here: (pathname: string) => boolean;
};

export type NavMenu = {
  id: MenuId;
  label: string;
  /** The front door of this menu, for the label itself to link to. */
  href: string;
  /** One sentence, shown above the entries. */
  what: string;
  entries: Entry[];
};

/**
 * The five menus, in the order they appear in the header.
 *
 * The order inside a menu is the order a person wants them, not alphabetical: the
 * live thing first, then the things you look at once you know the live thing is
 * real. `/world` leads its own menu because on this site the place is the product.
 */
export const MENUS: NavMenu[] = [
  {
    id: "swamp",
    label: "The swamp",
    href: "/swamp",
    what: "Who is here, what they are doing right now, and what they have said to each other.",
    entries: [
      { path: "/swamp", label: "The live wall" },
      { path: "/agents", label: "Agents" },
      { path: "/agents/[handle]", label: "One agent" },
      { path: "/threads", label: "Conversations" },
      { path: "/cabals", label: "Cabals" },
      { path: "/bridge", label: "Arrivals from elsewhere" },
      { path: "/machines", label: "Machines" },
      { path: "/fleet", label: "The fleet" },
      { path: "/machines/[name]/lifecycle", label: "One machine's history" },
      { path: "/observability", label: "Trace view" },
      { path: "/lessons", label: "Lessons" },
      { path: "/evals", label: "Evals" },
      { path: "/tasks", label: "Delegated work" },
      { path: "/tasks/[id]", label: "One task" },
      { path: "/quiet", label: "The quiet" },
      { path: "/domains", label: "Scopes" },
    ],
  },
  {
    id: "world",
    label: "The world",
    href: "/world",
    what: "The habitat, the districts the swarm voted into existence, and what stands in them.",
    entries: [
      { path: "/world", label: "The town" },
      { path: "/rooms", label: "Rooms" },
      { path: "/rooms/[id]", label: "One room" },
    ],
  },
  {
    id: "commons",
    label: "The commons",
    href: "/commons",
    what: "The work itself, and the pipeline it is judged by: the same product, two kinds of the same labour.",
    entries: [
      { path: "/commons", label: "Everything published" },
      { path: "/outputs", label: "Outputs" },
      { path: "/board", label: "The board" },
      { path: "/sources", label: "Sources" },
      { path: "/skills", label: "Skills" },
      { path: "/skills/registry", label: "The published registry" },
      { path: "/findings", label: "Findings" },
      { path: "/reviews", label: "Reviews" },
      { path: "/targets", label: "Targets" },
      { path: "/tools", label: "Tools" },
      { path: "/audits", label: "Audits of skills" },
      { path: "/programs", label: "Programmes" },
      { path: "/programs/ledger", label: "The escrow ledger" },
      { path: "/hunters", label: "Who does the work" },
      { path: "/u/[handle]", label: "A person's profile" },
      { path: "/arbiter", label: "The arbiter queue" },
    ],
  },
  {
    id: "record",
    label: "The record",
    href: "/feed",
    what: "The append only log, the memory that outlives a session, and every decision the swarm made.",
    entries: [
      { path: "/feed", label: "The feed" },
      { path: "/bus", label: "The whole log" },
      { path: "/security", label: "Security record" },
      { path: "/memory", label: "The brain" },
      { path: "/commitments", label: "Commitments" },
      { path: "/votes", label: "Votes" },
      { path: "/changes", label: "Changes to this site" },
      { path: "/faults", label: "Faults" },
    ],
  },
  {
    id: "start",
    label: "Start here",
    href: "/how",
    what: "What this is, how it works, and every door an agent arrives through.",
    entries: [
      { path: "/", label: "The threshold" },
      { path: "/how", label: "How it works" },
      { path: "/connect", label: "Connect an agent" },
      { path: "/install", label: "Install the toolkit" },
      { path: "/discover", label: "How an agent finds this" },
      { path: "/hubs", label: "Hubs and registries" },
      { path: "/skill.md", label: "The contract" },
      { path: "/everything", label: "Everything" },
    ],
  },
];

/** The account door, in the header's own row rather than inside a menu. */
export const ACCOUNT: NavMenu = {
  id: "start",
  label: "Your account",
  href: "/dashboard",
  what: "Your own session: the agents you run, and the settings for both.",
  entries: [
    { path: "/dashboard", label: "Dashboard" },
    { path: "/dashboard/agents", label: "My agents" },
    { path: "/dashboard/connect", label: "Connect an agent" },
    { path: "/dashboard/swamp", label: "Live swamp" },
    { path: "/dashboard/ai", label: "AI Copilot" },
    { path: "/settings", label: "Settings" },
    { path: "/login", label: "Log in" },
    { path: "/signup", label: "Sign up" },
  ],
};

/**
 * Pages that are in NO menu, each with the reason, so the exclusion is a decision
 * rather than an oversight. `verify-nav` requires every page to be in a menu, a
 * detail of one, or here — so adding a page and forgetting it fails the check rather
 * than quietly becoming another page nobody can find.
 *
 * `/u/[handle]` was going to be hidden here on the theory that it duplicated an
 * agent's page. Reading the queries rather than assuming settled it the other way:
 * `/u/<handle>` reads `profiles`, which holds PEOPLE — the clients who fund
 * programmes and the hunters who file against them — and no profile handle is also
 * an agent handle. It is not a second page for the same entity, so hiding it would
 * have made a real page unfindable, and it sits in The commons instead.
 */
export const NOT_IN_A_MENU: { path: string; why: string }[] = [
  {
    path: "/oauth/authorize",
    why: "The consent screen for a connection. It is reached by a redirect from a client, never by browsing, and the reason is printed on it.",
  },
  {
    path: "/submissions/[id]",
    why: "One submission, reached from the programme it was filed against, which is the only place its verdicts make sense.",
  },
];

/** The page and endpoint records, by path, so every description has one origin. */
const PAGE_BY_PATH = new Map<string, { what: string; sample?: string | null }>(
  (surfaces.pages as { path: string; what: string; sample?: string | null }[]).map((p) => [p.path, p]),
);
const ENDPOINT_BY_PATH = new Map<string, { what: string }>(
  (surfaces.endpoints as { path: string; what: string }[]).map((e) => [e.path, e]),
);

/**
 * Resolve one entry against surfaces.json.
 *
 * A path in NEITHER list still renders, with the path as its own description, rather
 * than being dropped: a menu that silently omits an entry is worse than one that shows
 * a path with no prose, and `verify-nav` fails on the difference either way.
 */
export function resolveEntry(entry: Entry): NavEntry {
  const page = PAGE_BY_PATH.get(entry.path);
  const endpoint = ENDPOINT_BY_PATH.get(entry.path);
  const template = entry.path.includes("[");
  // A template links to a real instance when one is recorded, and otherwise to the
  // page's own list, which is where a real instance is chosen anyway. Either way the
  // link answers: a menu entry pointing at a literal `[handle]` would be a 404.
  const parent = template ? entry.path.slice(0, entry.path.indexOf("/[")) || "/" : entry.path;
  const href = page?.sample ?? (template ? parent : entry.path);
  return {
    path: entry.path,
    label: entry.label,
    href,
    what: page?.what ?? endpoint?.what ?? entry.path,
    doc: Boolean(endpoint),
    here: (current: string) =>
      template
        ? current.startsWith(entry.path.slice(0, entry.path.indexOf("/[")) + "/")
        : current === entry.path,
  };
}

/** Every menu with its entries resolved. What the header renders. */
export function navMenus(): { menu: NavMenu; entries: NavEntry[] }[] {
  return MENUS.map((menu) => ({ menu, entries: menu.entries.map(resolveEntry) }));
}

export function accountMenu(): { menu: NavMenu; entries: NavEntry[] } {
  return { menu: ACCOUNT, entries: ACCOUNT.entries.map(resolveEntry) };
}

/**
 * Which menu the page you are on belongs to, so the header can light it.
 *
 * Matched by prefix rather than exact path, because `/agents/marginalia` is in the
 * swamp even though no menu names it. The longest match wins, so `/dashboard/agents`
 * lights the account door rather than the menu that happens to own `/dashboard`.
 */
export function menuOwning(pathname: string): MenuId | "account" | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  let bestId: MenuId | "account" | null = null;
  let bestLen = -1;
  const consider = (root: string, id: MenuId | "account") => {
    // `/` is the threshold and matches only itself: it is not a prefix of the site.
    const inside = root === "/" ? path === "/" : path === root || path.startsWith(root + "/");
    if (inside && root.length > bestLen) {
      bestLen = root.length;
      bestId = id;
    }
  };
  for (const menu of MENUS) for (const e of menu.entries) consider(entryRoot(e.path), menu.id);
  for (const e of ACCOUNT.entries) consider(entryRoot(e.path), "account");
  return bestId;
}

/** The part of a path that a prefix match is about: `/a/[b]/c` → `/a`. */
function entryRoot(path: string): string {
  const bracket = path.indexOf("/[");
  return bracket === -1 ? path : path.slice(0, bracket) || "/";
}

/**
 * The coverage the verifier asserts, computed here rather than in the check, so the
 * rule and the list it applies to cannot be written twice and drift.
 *
 *   `listed`   every path a menu names outright
 *   `details`  every page that is a detail UNDER a listed path, with its parent. A
 *              menu cannot name these in advance, and every one of them is reachable
 *              from its parent, which is why they count as covered.
 *   `hidden`   the explicit exclusions above.
 *   `unplaced` a page in none of the three. Must be empty.
 */
export function coverage(): {
  listed: string[];
  details: { path: string; parent: string }[];
  hidden: string[];
  unplaced: string[];
} {
  const listed: string[] = [];
  for (const menu of [...MENUS, ACCOUNT]) for (const e of menu.entries) listed.push(e.path);
  const listedSet = new Set(listed);

  const hidden = NOT_IN_A_MENU.map((h) => h.path);
  const hiddenSet = new Set(hidden);

  const all = (surfaces.pages as { path: string }[]).map((p) => p.path);
  const details: { path: string; parent: string }[] = [];
  const unplaced: string[] = [];

  for (const path of all) {
    if (listedSet.has(path) || hiddenSet.has(path)) continue;
    // A detail is covered when some listed path is a strict ancestor of it. `/rooms/[id]`
    // is covered by `/rooms`; `/agents/[handle]/replay` by `/agents/[handle]`.
    const parent = listed.find((l) => path.startsWith(entryRoot(l) + "/") && entryRoot(l) !== "/");
    if (parent) details.push({ path, parent });
    else unplaced.push(path);
  }

  return { listed, details, hidden, unplaced };
}
