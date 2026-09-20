#!/usr/bin/env node
/**
 * Has anything been taken away?
 *
 * WHY THIS EXISTS. Everything on this platform is addressed by a name that somebody
 * else already holds. A page is cited by `lib/surfaces.json`, which `/everything`
 * renders and `verify-surfaces` probes. An endpoint is a door an agent's client
 * calls. A tool name is the only handle MCP gives a client, so a rename is not a
 * tidy-up: every client keyed by the old name loses the door, and the loser keeps
 * compiling, keeps answering its own route and simply stops existing from outside.
 *
 * That failure has already happened here once — `read_skills` was declared twice and
 * one of the two became unreachable — which is why a name-level check exists at all
 * (`verify-tool-names`). This file is the other half of it. That one asks whether two
 * doors share a name; this one asks whether a door that used to be here is still
 * here, in any of the three inventories that are read from outside this repository.
 *
 * WHAT IS FROZEN, and where each is read from rather than from memory:
 *
 *   pages      `lib/surfaces.json` `.pages`      — the registry `/everything` renders
 *   endpoints  `lib/surfaces.json` `.endpoints`  — the same registry's doors
 *   tools      `lib/mcp/tools.ts` descriptor names, at four spaces of indentation
 *
 * The tool pass reads the same pattern `verify-tool-names` does, deliberately, so a
 * name that stops being a literal is caught there rather than being silently absent
 * here.
 *
 * WHY A BASELINE FILE AND NOT A COUNT. A count says `103`, and a substitution keeps
 * the count while losing a door. The baseline names them, so the failure names the
 * one that went.
 *
 * HOW TO ADD. Adding is the normal case and needs nothing: a new page, endpoint or
 * tool is simply not in the baseline, which is allowed. To record it, run the writer
 * below, which only ever grows the file:
 *
 *   node scripts/verify-additive.cjs --write
 *
 * HOW TO REMOVE, WHICH IS DELIBERATE. The writer refuses to drop an entry unless it
 * is told to, because a removal is a breaking change to somebody outside this repo
 * and should be a decision rather than a side effect of editing a registry:
 *
 *   node scripts/verify-additive.cjs --write --accept-removals
 *
 * It prints what it is about to drop before it drops it, so the diff in a pull
 * request carries the name of every door that closed.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It is pure: no network, no database, no built
 * server. Whether a surface ANSWERS is `verify-surfaces`' job, against a running
 * site, which is the only place that can be checked. This asks the question that can
 * be asked of the source: is it still there.
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const BASELINE = path.join(ROOT, "lib", "surface-baseline.json");
const SURFACES = path.join(ROOT, "lib", "surfaces.json");
const TOOLS = path.join(ROOT, "lib", "mcp", "tools.ts");
const APP = path.join(ROOT, "app");

const args = process.argv.slice(2);
const write = args.includes("--write");
const acceptRemovals = args.includes("--accept-removals");

let failed = 0;
const say = (ok, label, detail) => {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};

/** The three inventories as they stand right now, each sorted so diffs are stable. */
function current() {
  const surfaces = JSON.parse(fs.readFileSync(SURFACES, "utf8"));
  const toolsSource = fs.readFileSync(TOOLS, "utf8");
  return {
    pages: surfaces.pages.map((p) => p.path).sort(),
    endpoints: surfaces.endpoints.map((e) => `${e.method} ${e.path}`).sort(),
    tools: [...toolsSource.matchAll(/^ {4}name: "([a-z0-9_]+)",$/gm)].map((m) => m[1]).sort(),
  };
}

/** Entries the baseline holds and the source no longer does — the whole point. */
function gone(base, now) {
  return {
    pages: base.pages.filter((p) => !now.pages.includes(p)),
    endpoints: base.endpoints.filter((e) => !now.endpoints.includes(e)),
    tools: base.tools.filter((t) => !now.tools.includes(t)),
  };
}

/** Entries the source has gained. Always allowed, and reported so it is visible. */
function grown(base, now) {
  return {
    pages: now.pages.filter((p) => !base.pages.includes(p)),
    endpoints: now.endpoints.filter((e) => !base.endpoints.includes(e)),
    tools: now.tools.filter((t) => !base.tools.includes(t)),
  };
}

const counts = (o) => `pages:${o.pages.length} endpoints:${o.endpoints.length} tools:${o.tools.length}`;
const listed = (o, limit = 8) => {
  const all = [...o.pages, ...o.endpoints, ...o.tools];
  return all.length === 0 ? "" : all.slice(0, limit).join(", ") + (all.length > limit ? `, +${all.length - limit} more` : "");
};

const now = current();

if (write) {
  const before = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")) : { pages: [], endpoints: [], tools: [] };
  const dropped = gone(before, now);
  const added = grown(before, now);

  console.log(`baseline: ${counts(before)}`);
  console.log(`source:   ${counts(now)}`);
  if (listed(added)) console.log(`added:    ${listed(added)}`);

  if (listed(dropped)) {
    console.log(`\nREMOVED:  ${listed(dropped)}`);
    if (!acceptRemovals) {
      console.log(
        "\nNot writing: this would close a door somebody outside this repository may " +
          "hold. If that is really intended, say so — and put the names above in the " +
          "commit message:\n\n  node scripts/verify-additive.cjs --write --accept-removals\n",
      );
      process.exit(2);
    }
    console.log("  (accepted, because --accept-removals was passed)");
  }

  fs.writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        _readme:
          "Every page, endpoint and MCP tool name this platform has ever published, frozen " +
          "so one cannot disappear unnoticed. Grown only by `node scripts/verify-additive.cjs --write`; " +
          "shrunk only with `--accept-removals`, which prints what it is about to close. " +
          "Do not hand-edit: the next writer run will rewrite the file it reads.",
        pages: now.pages,
        endpoints: now.endpoints,
        tools: now.tools,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`\nwrote ${path.relative(ROOT, BASELINE)}`);
  process.exit(0);
}

console.log("== the frozen inventory is still here ==");
if (!fs.existsSync(BASELINE)) {
  say(false, "lib/surface-baseline.json exists", "create it with: node scripts/verify-additive.cjs --write");
  console.log(`\nadditive: ${failed} FAILED`);
  process.exit(1);
}

const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
say(true, "the baseline is readable", counts(base));

// Counted first and separately, so a shrunken inventory says so in one plain
// sentence before the names are listed beneath it.
for (const kind of ["pages", "endpoints", "tools"]) {
  say(
    now[kind].length >= base[kind].length,
    `  ${kind} have not shrunk`,
    `${base[kind].length} -> ${now[kind].length}`,
  );
}

console.log("\n== and nothing took one with it ==");
const dropped = gone(base, now);
for (const kind of ["pages", "endpoints", "tools"]) {
  say(
    dropped[kind].length === 0,
    `  every ${kind.slice(0, -1)} in the baseline still exists`,
    dropped[kind].join(", ") || "none missing",
  );
}

console.log("\n== and each page is still routed to something ==");
// A path can survive in the registry while its directory is deleted, which is the
// quietest way to lose a page: `/everything` keeps listing it and nothing serves it.
// Endpoints are not held to this, because the twelve `/.well-known/*` doors are
// served through rewrites in `next.config.ts` rather than from a directory of that
// name — guessing at the mechanism from the file tree is how a verifier ends up red
// on something innocent, which `verify-shell` already learned once.
const unrouted = [];
for (const p of base.pages) {
  const dir = path.join(APP, p.replace(/^\//, ""));
  if (!fs.existsSync(dir)) unrouted.push(p);
}
say(
  unrouted.length === 0,
  `every one of the ${base.pages.length} registered pages still has a route directory`,
  unrouted.slice(0, 6).join(", ") || "all present",
);

const added = grown(base, now);
if (listed(added)) {
  console.log(`\ngrown since the baseline (allowed, and not yet recorded): ${listed(added)}`);
  console.log("record it with: node scripts/verify-additive.cjs --write");
}

console.log(`\nadditive: ${failed === 0 ? "all checks passed" : `${failed} FAILED`}`);
process.exitCode = failed === 0 ? 0 : 1;
