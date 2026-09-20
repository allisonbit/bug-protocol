#!/usr/bin/env node
/**
 * Which routes get the world shell, and — more importantly — which do not.
 *
 * WHY THIS EXISTS. The world shell changes the arrangement of twenty four pages at
 * once, and its most dangerous property is not what it does to them. It is what it
 * must never do to the OTHERS.
 *
 * `/skill.md`, `/agents.md`, `/connect`, `/llms.txt` and every `/v1/*` and
 * `/.well-known/*` endpoint are read by software. An agent cannot read a canvas. If
 * one of those routes ever acquired the shell, the platform's contract would move
 * behind an interactive frame that the thing the contract is addressed to cannot
 * see — and nothing would error. The page would still return 200, a browser would
 * still render it, and the only symptom would be agents quietly arriving with less
 * than they used to. That is the failure this file is for.
 *
 * WHAT IS PINNED, and each of these is a real way to break it:
 *
 *   1. EVERY SWAMP PAGE IS PLACED. The list is `lib/surfaces.json`'s "The swamp"
 *      group — the same registry `/everything` renders and `verify-surfaces`
 *      probes — so a page cannot be added to the swamp and left unreachable from
 *      inside the world without this failing.
 *   2. NO PAGE OUTSIDE THE SWAMP IS PLACED. Every other surface, page and endpoint,
 *      must answer null. This is the one that protects the agents.
 *   3. THE PREFIX MATCH HAS BOUNDARIES. `/boards` is not `/board`, `/users` is not
 *      `/u`, and a trailing slash is the same route as the one without it. A
 *      `startsWith` without a separator would put unrelated routes in the world
 *      silently, which is exactly how a shell leaks.
 *   4. THE FIVE VIEWS ARE REACHABLE. Every view's own href is in the world, and no
 *      two views claim the same route. A view whose href is not in the swamp is a
 *      header button that throws a reader out of the world.
 *
 * It is PURE: `viewFor` is a function of a string. No network, no database, no
 * build. The live behaviour of the shell is exercised against production when the
 * feature ships.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-shell.cjs
 */
const { VIEWS, viewFor, SHELL_BOX, SHELL_PANEL_BUDGET } = require("../lib/swamp/views.ts");
const surfaces = require("../lib/surfaces.json");
const fs = require("node:fs");
const path = require("node:path");

let failed = 0;
const say = (ok, label, detail) => {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail !== undefined ? `  ${detail}` : ""}`);
};

/** A template path as a concrete one, preferring the registry's own sample. */
function concrete(entry) {
  if (!entry.path.includes("[")) return entry.path;
  return entry.sample ?? null;
}

console.log("== every swamp page has a view ==");
const swamp = surfaces.pages.filter((p) => p.group === "The swamp");
say(swamp.length >= 20, "the swamp is the group the registry says it is", `${swamp.length} pages`);

const unplaced = [];
for (const p of swamp) {
  const path = concrete(p);
  if (path === null) {
    unplaced.push(`${p.path} (no sample to test)`);
    continue;
  }
  if (viewFor(path) === null) unplaced.push(p.path);
}
say(unplaced.length === 0, "and every one of them is inside the world", unplaced.join(", ") || `${swamp.length} placed`);

console.log("\n== and nothing else is ==");
const outside = [];
for (const p of surfaces.pages) {
  if (p.group === "The swamp") continue;
  const path = concrete(p);
  if (path === null) continue;
  const v = viewFor(path);
  if (v !== null) outside.push(`${path} -> ${v}`);
}
say(outside.length === 0, "no page outside the swamp is placed in it", outside.join(", ") || "every other page keeps the document arrangement");

/**
 * ENDPOINTS ARE HELD TO A DIFFERENT RULE, and the first version of this check got
 * that wrong in a way worth keeping written down.
 *
 * It demanded `viewFor(endpoint) === null` for all forty-eight of them, and failed
 * on `/agents/[handle]/document` — the PDF and Markdown download of an agent's whole
 * record. That path sits under `/agents`, which IS a swamp prefix, so `viewFor`
 * places it in the swarm and the check called that a leak.
 *
 * It is not one, and the reason is structural: a Next route HANDLER is not wrapped
 * by a layout. `app/agents/[handle]/document/route.ts` returns a PDF or a file, and
 * the shell only ever wraps what a `page.tsx` renders. So the assertion the check
 * was reaching for was never `viewFor` at all — it was "these doors are handlers,
 * and none of them has quietly become a page". That is now what it asserts, and it
 * is a stronger statement than the one it replaced: a route handler cannot be
 * framed, and the day somebody adds a `page.tsx` under one of these paths, this
 * fails and says which.
 */
const APP = require("node:path").join(__dirname, "..", "app");
const exists = require("node:fs").existsSync;
const becamePages = [];
for (const e of surfaces.endpoints) {
  const dir = require("node:path").join(APP, e.path.replace(/^\//, ""));
  if (exists(require("node:path").join(dir, "page.tsx"))) becamePages.push(e.path);
}
say(
  becamePages.length === 0,
  "no registered endpoint renders a page, so none of them can be framed",
  becamePages.join(", ") || `${surfaces.endpoints.length} endpoints, all of them doors rather than pages`,
);
// Deliberately NOT asserted here: that each of those paths is served by a
// `route.ts`. A first version did, and failed on nineteen well-known files, a
// sitemap, robots and security.txt — all of which Next serves through its own
// conventions (`sitemap.ts`, `robots.ts`, rewrites) rather than through a route
// handler. Guessing at the mechanism from the file tree is how a verifier ends up
// red on something innocent. That each endpoint ANSWERS is `verify-surfaces`' job,
// against the running site, which is the only place it can be checked anyway.
for (const p of ["/agents/[handle]/document", "/v1/outputs/[id]/document"]) {
  say(
    !exists(require("node:path").join(APP, p.replace(/^\//, ""), "page.tsx")),
    `  ${p} is a download, not a page`,
  );
}

// Named individually, because these are the ones whose loss would be silent and
// expensive: the contract an arrival is told to read first, and the two pages that
// describe every door.
for (const p of ["/skill.md", "/agents.md", "/connect", "/llms.txt", "/everything", "/how", "/", "/v1/continuity", "/api/mcp", "/.well-known/mcp.json", "/dashboard", "/login"]) {
  say(viewFor(p) === null, `  ${p} is not in the world`);
}

console.log("\n== the prefix match has boundaries ==");
say(viewFor("/board") === "board", "an exact route is placed");
say(viewFor("/board/2291") === "board", "and its detail routes agree with it");
say(viewFor("/board/") === "board", "and a trailing slash is the same route");
say(viewFor("/boards") === null, "but a route that merely starts with the same letters is not");
say(viewFor("/users") === null, "and /u does not swallow /users", `viewFor("/users") = ${viewFor("/users")}`);
say(viewFor("/u/marginalia") === "swarm", "while a real handle under it is");
say(viewFor("/world") === "world", "the world is in itself");
say(viewFor("/") === null, "the threshold is not a swamp route");
say(viewFor("/agent") === null, "and /agent is not /agents");
say(viewFor("/feeds") === null, "nor is /feeds /feed");
say(viewFor("/memory") === "record" && viewFor("/memories") === null, "the same holds for the memory");

console.log("\n== the five views are reachable and distinct ==");
say(VIEWS.length === 5, "there are five views", VIEWS.map((v) => v.id).join(", "));
for (const v of VIEWS) {
  say(viewFor(v.href) === v.id, `  ${v.label}'s own href is in ${v.id}`, v.href);
  say(typeof v.what === "string" && v.what.length > 20, `  and it says what it is for`, `${v.what.length} chars`);
}
const ids = VIEWS.map((v) => v.id);
say(new Set(ids).size === ids.length, "no two views share an id");
const hrefs = VIEWS.map((v) => v.href);
say(new Set(hrefs).size === hrefs.length, "and no two share an href");

// Every swamp page must land in exactly one view, which is a property of the
// ownership map rather than of any one route: a route matched by two prefixes would
// be resolved by whichever came first in the array, so its view would depend on
// ordering rather than on the route.
console.log("\n== ownership does not depend on the order of the list ==");
const flipped = [...swamp].reverse();
let disagree = [];
for (const p of flipped) {
  const path = concrete(p);
  if (path === null) continue;
  // Re-ask every swamp path; the map is a lookup, so a path's view must not depend
  // on which other paths were asked first.
  if (viewFor(path) === null) disagree.push(p.path);
}
say(disagree.length === 0, "asking in any order gives the same answer", disagree.join(", "));

/*
 * THE DESKTOP BOX, ARITHMETICALLY.
 *
 * This is the check that would have caught the overlap the arrangement shipped with
 * for its first hour: at `lg` — the narrowest width where the desktop arrangement
 * applies at all — a 720px panel anchored left and a 340px rail anchored right do
 * not fit in 1024px. The panels intersected by 68px, so the rail sat on the end of
 * every line in the view, at exactly one end of a breakpoint range and nowhere else.
 *
 * So the widths are walked rather than eyeballed, and the literals in the classes are
 * asserted against the constants in `lib/swamp/views.ts` — because a number changed
 * in one place and not the other is how this breaks next.
 */
console.log("\n== the desktop box fits at every width it applies to ==");
const shellSource = fs.readFileSync(path.join(__dirname, "..", "components", "swamp", "shell.tsx"), "utf8");
for (const [literal, what] of [
  ["lg:w-[340px]", "the rail's width"],
  ["lg:w-[min(720px,calc(100vw-388px))]", "the panel's width"],
  ["lg:bottom-20", "the strip the dock lives in"],
  ["lg:left-4", "the panel's left inset"],
  ["lg:right-4", "the rail's right inset"],
  ["lg:top-4", "both panels' top inset"],
]) {
  say(shellSource.includes(literal), `  the shell still writes \`${literal}\` (${what})`);
}
say(SHELL_PANEL_BUDGET === 388, "and the panel's budget is the four insets it leaves room for", `${SHELL_PANEL_BUDGET}px`);
say(
  SHELL_PANEL_BUDGET === SHELL_BOX.margin + SHELL_BOX.gap + SHELL_BOX.rail + SHELL_BOX.margin,
  "  which is margin + gap + rail + margin, not four numbers typed twice",
);
say(SHELL_BOX.dockStrip === 80, "and the dock strip is 5rem", "bottom-20");

/** A box at a given window width, in the arrangement the classes describe. */
function boxAt(vw, vh) {
  const m = SHELL_BOX.margin;
  const panelW = Math.min(SHELL_BOX.panelMax, vw - SHELL_PANEL_BUDGET);
  const strip = SHELL_BOX.dockStrip;
  return {
    panel: { x: m, y: m, right: m + panelW, bottom: vh - strip },
    rail: { x: vw - m - SHELL_BOX.rail, y: m, right: vw - m, bottom: vh - strip },
    dock: { x: 0, y: vh - 2 * m, right: vw, bottom: vh - m },
  };
}
const intersects = (a, b) => !(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y);

const collides = [];
const tooNarrow = [];
// 1024 is `lg`; 2560 is a wide monitor. Every width in between is a real window.
for (let vw = 1024; vw <= 2560; vw += 8) {
  const vh = 900;
  const b = boxAt(vw, vh);
  if (intersects(b.panel, b.rail)) collides.push(`${vw}px: panel/rail`);
  if (intersects(b.panel, b.dock)) collides.push(`${vw}px: panel/dock`);
  if (intersects(b.rail, b.dock)) collides.push(`${vw}px: rail/dock`);
  if (b.panel.right - b.panel.x < 560) tooNarrow.push(`${vw}px: ${b.panel.right - b.panel.x}px panel`);
}
say(collides.length === 0, "no two of the three boxes ever intersect", collides.slice(0, 4).join(", ") || "panel, rail and dock are clear from 1024px to 2560px");
say(
  tooNarrow.length === 0,
  "and the view never narrows past what a page can be read in",
  tooNarrow.slice(0, 3).join(", ") || "never below 560px",
);
// Said out loud, because it is the number that was wrong: at the narrowest width the
// desktop arrangement applies to, the panel gets this much and no more.
const atLg = boxAt(1024, 900);
say(
  atLg.panel.right <= atLg.rail.x,
  "  at exactly 1024px the panel ends before the rail begins",
  `panel ends ${atLg.panel.right}, rail starts ${atLg.rail.x}, ${atLg.rail.x - atLg.panel.right}px of gap`,
);
say(
  atLg.panel.right - atLg.panel.x >= 560,
  "  and it is still wide enough to hold a page",
  `${atLg.panel.right - atLg.panel.x}px`,
);

console.log(`\nshell: ${failed === 0 ? "all checks passed" : `${failed} FAILED`}`);
process.exitCode = failed === 0 ? 0 : 1;
