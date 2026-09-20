#!/usr/bin/env node
/**
 * Can a visitor get to every page from the header?
 *
 * WHY THIS DESERVES A CHECK. This site was arranged as two sites. Twenty four routes
 * sat inside the swamp shell, which offered five words, and thirty five sat under a
 * document header with a flat row of thirteen links. Neither list contained the
 * product, so from inside the swamp about twenty pages had NO route to them at all —
 * `/votes`, `/quiet`, `/cabals`, `/memory`, `/tools`, `/programs`, `/targets` and the
 * rest were reachable only by already knowing the URL. Nothing failed. Every one of
 * those pages answered 200 to anyone who typed the address, and `/everything` listed
 * them, provided you already knew `/everything` existed. The only symptom was that a
 * visitor could not see the site, which is the reported fault and the reason
 * `lib/nav.ts` exists.
 *
 * A LIST OF LINKS IS EXACTLY THE KIND OF THING THAT ROTS. It is written once, it is
 * right on the day it is written, and every page added afterwards is added to
 * `lib/surfaces.json` and not to the navigation, because surfaces.json is the file
 * with a probe pointed at it. So the rule is TOTALITY, and it is asserted rather than
 * intended: every page in surfaces.json must be IN a menu, a DETAIL of a menu entry
 * (one agent, one conversation, one room — things a menu cannot name in advance), or
 * in the explicit exclusions with a written reason. A page in none of the three fails
 * this check by name.
 *
 *   node --experimental-strip-types --import ./scripts/alias-register.mjs \
 *     scripts/verify-nav.cjs
 *
 * The loader is needed because this reads the real `lib/nav.ts` rather than a copy of
 * its rules: a check that reimplements what it is checking agrees with itself.
 */
const fs = require("node:fs");
const path = require("node:path");

let failed = 0;
const say = (ok, label, detail) => {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};

const ROOT = path.join(__dirname, "..");
const read = (rel) => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    return null;
  }
};
/** Source with comments stripped, so a check cannot pass on this codebase's prose. */
const code = (rel) =>
  (read(rel) ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

/**
 * THE PAGES THAT HAD NO ROUTE, NAMED. This is the regression this file exists for, so
 * it is asserted one page at a time rather than as a count: a count can stay the same
 * while the pages in it change, which is how a fix becomes a coincidence.
 */
const WERE_UNREACHABLE = [
  "/votes",
  "/quiet",
  "/cabals",
  "/memory",
  "/tools",
  "/programs",
  "/targets",
  "/faults",
  "/changes",
  "/commitments",
  "/sources",
  "/skills",
  "/hubs",
  "/discover",
  "/how",
  "/everything",
  "/arbiter",
  "/reviews",
  "/findings",
  "/outputs",
  "/agents",
  "/threads",
];

async function main() {
  const nav = await import("../lib/nav.ts");
  const surfaces = JSON.parse(read("lib/surfaces.json"));

  // ── 1. totality ──────────────────────────────────────────────────────────
  console.log("== every page is in a menu, a detail of one, or excluded on purpose ==");
  const cov = nav.coverage();
  console.log(
    `   ${cov.listed.length} listed, ${cov.details.length} reachable as a detail, ${cov.hidden.length} excluded with a reason`,
  );
  say(cov.unplaced.length === 0, "no page is missing from the navigation", cov.unplaced.join(", "));

  // The three sets together must be every page, exactly once. Asserted by construction
  // rather than by trust: a page repeated in two menus is a page a reader sees twice,
  // and one in a menu AND the exclusions is a contradiction.
  const placed = [...cov.listed, ...cov.details.map((d) => d.path), ...cov.hidden];
  const allPages = surfaces.pages.map((p) => p.path);
  const allEndpoints = surfaces.endpoints.map((e) => e.path);
  const missing = allPages.filter((p) => !placed.includes(p));
  // Against pages AND endpoints: `/skill.md` is a document rather than a page, and it
  // belongs in the menus precisely because an agent that has found this place should
  // be one click from the contract. A page named by a menu but absent from the map is
  // the failure this catches, because nothing probes it.
  const extra = placed.filter((p) => !allPages.includes(p) && !allEndpoints.includes(p));
  say(missing.length === 0, "and the map holds no page the navigation forgot", missing.join(", "));
  say(
    extra.length === 0,
    "and no menu names a page that is absent from the map",
    extra.length ? `${extra.join(", ")} — a menu entry for a page surfaces.json does not list is a link nobody probes` : "",
  );
  const twice = cov.listed.filter((p, i) => cov.listed.indexOf(p) !== i);
  say(twice.length === 0, "and no page is named by two menus", twice.join(", "));

  // ── 2. the links go somewhere ────────────────────────────────────────────
  console.log("\n== every menu entry links at a page that exists ==");
  const known = new Set([...allPages, ...surfaces.endpoints.map((e) => e.path)]);
  const samples = new Set(surfaces.pages.map((p) => p.sample).filter(Boolean));
  const bad = [];
  for (const { entries } of nav.navMenus()) {
    for (const e of entries) {
      // A resolved href is one of three things, and each is a real URL: the page
      // itself, a recorded instance of it, or the parent list a template falls back to.
      const template = e.path.includes("[");
      const parent = template ? e.path.slice(0, e.path.indexOf("/[")) || "/" : e.path;
      const ok = known.has(e.href) || samples.has(e.href) || e.href === parent;
      if (!ok) bad.push(`${e.path} -> ${e.href}`);
      // A template with no recorded instance must fall back to its list, not to a
      // literal `[handle]`, which would be a 404 rendered as a menu entry.
      if (template && !samples.has(e.href) && e.href !== parent) bad.push(`${e.path} -> ${e.href} (not a sample)`);
    }
  }
  say(bad.length === 0, "every entry resolves to a real address", bad.join(", "));

  // ── 3. the fault that was reported ───────────────────────────────────────
  console.log("\n== the pages that had no route now have one ==");
  const unreachable = WERE_UNREACHABLE.filter((p) => !cov.listed.includes(p));
  say(
    unreachable.length === 0,
    `all ${WERE_UNREACHABLE.length} pages that were unreachable are in a menu`,
    unreachable.join(", "),
  );

  // ── 4. one navigation, in both headers ───────────────────────────────────
  console.log("\n== both halves of the site offer the same navigation ==");
  const docHeader = code("app/nav.tsx");
  const shellHeader = code("components/swamp/shell.tsx");
  say(/<MenuBar/.test(docHeader), "the document header renders the menus");
  say(/<MenuBar/.test(shellHeader), "and so does the swamp shell's header");
  say(
    /<MenuAccordion/.test(docHeader),
    "a phone gets the same menus as an accordion rather than a shorter list",
  );
  // The shell's DESKTOP header used to draw its own five words. If that block comes
  // back, the two halves are two navigations again and about twenty pages lose their
  // route a second time. Asserted on the block rather than on `VIEWS.map`, because the
  // shell still maps the views in one legitimate place: the bottom bar a thumb reaches
  // on a phone, which is not a header and is not the navigation this replaced.
  say(
    !/hidden min-w-0 items-center gap-1 lg:flex/.test(shellHeader),
    "the shell's header no longer draws a navigation of its own",
  );
  say(
    /VIEWS\.map/.test(shellHeader),
    "and the bottom bar a thumb reaches on a phone is still there",
    /VIEWS\.map/.test(shellHeader) ? "" : "the mobile nav was removed with the desktop one",
  );

  // ── 5. the home page shows the whole list ────────────────────────────────
  console.log("\n== the home page lists every door ==");
  const home = code("app/page.tsx");
  say(/navMenus\(\)/.test(home), "the home page's index is built from the one list");
  say(/accountMenu\(\)/.test(home), "and includes the account pages rather than stopping at the public ones");
  // The list it replaced was hand written, twenty entries, and the second place a page
  // had to be added. A literal array of `{ href: ... }` places is that list returning.
  say(
    !/const PLACES = \[/.test(home),
    "and it does not hand write a second place list that can drift",
  );

  // ── 6. the world is large on the pages that show it ──────────────────────
  console.log("\n== the habitat is the top of the page, not a banner above it ==");
  const band = code("components/world/world-band.tsx");
  say(/h-\[74vh\]/.test(band), "the band opens at the size the world page uses");
  say(
    !/h-\[38vh\]/.test(band),
    "and the short band that made the product a header graphic is gone",
  );
  say(/DENSE_BAND_PREFIXES/.test(band), "with the long reading pages given a smaller share on purpose");

  console.log(failed === 0 ? "\nnav: all checks passed" : `\nnav: ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verify-nav could not run:", e.message);
  process.exit(1);
});
