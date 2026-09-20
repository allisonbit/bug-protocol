#!/usr/bin/env node
/**
 * Can a visitor's browser tell this platform that one of its pages threw, and does the
 * reporting path keep nothing it should not?
 *
 * WHY THIS EXISTS AT ALL. The one fault this workspace could not see was the one that
 * happened in somebody else's browser: a Supabase Realtime channel collision threw
 * `cannot add 'postgres_changes' callbacks ... after 'subscribe()'` on two routes, every
 * route answered 200 the whole time, nothing reached any log, and the only reason it was
 * found is that a person pasted the error page into a chat. There was no `app/error.tsx`
 * and no `app/global-error.tsx` at all.
 *
 * WHAT IT PINS.
 *
 *   1. THE SCRUBBING, which is the part that has to be right. A message built by string
 *      interpolation is exactly where a visitor's token, address or password ends up, so
 *      URLs, emails, long opaque runs and long digit runs are removed BEFORE the message
 *      is stored and before it is fingerprinted. Its limit is asserted too: a bare word
 *      with no shape is not scrubbed, and pretending otherwise would be worse than
 *      saying so.
 *   2. TWO SIGHTINGS ARE ONE FAULT, and a frame is kept only if it is this site's own.
 *   3. THE REPORTER CANNOT THROW: it runs on a page that has already failed, so it may
 *      not import the server module, may not loop, and must be wrapped in try/catch.
 *   4. THE WIRING: both error boundaries exist and report, the beacon is mounted once,
 *      the endpoint is public and throttled, and `client.fault` is in the union,
 *      labelled, routed and allowed by the database's own constraint.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-faults.cjs [--live]
 */
const fs = require("node:fs");
const path = require("node:path");

let failed = 0;
let skipped = 0;
const say = (ok, label, detail) => {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};
const note = (label) => {
  skipped += 1;
  console.log(`skip ${label}`);
};

const LIVE = process.argv.includes("--live");
const ROOT = process.cwd();
const read = (rel) => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    return null;
  }
};

async function main() {
  const faults = await import("@/lib/swamp/faults");

  // ── 1. the scrubbing ─────────────────────────────────────────────────────
  console.log("== what a fault may keep about the person it happened to ==");
  const email = faults.scrub("Login failed for sam.rivera@example.com while saving");
  say(!email.includes("sam.rivera@example.com"), "an email address is removed", email);
  const url = faults.scrub("GET https://api.example.com/v2/me?token=abc123def456ghi789 failed");
  say(!/token=/.test(url) && !url.includes("abc123def456ghi789"), "a url and its query are removed", url);
  // The case a full-URL rule misses and a length rule misses too, and the one that leaked
  // in the first live report: a BARE path carrying a short token. A stack trace and an
  // interpolated message both look like this, and the value is what has to go.
  const bareQuery = faults.scrub("at /reset?token=abc123 while loading /api/v1/board?key=zz9");
  say(!bareQuery.includes("abc123"), "a short token in a bare path's query is removed", bareQuery);
  say(!bareQuery.includes("zz9"), "and a second parameter's value goes with it", bareQuery);
  say(/token=<redacted>/.test(bareQuery), "the parameter's NAME is kept, so the leak is still readable", bareQuery);
  const prose = faults.scrub("Did it fail? yes it did, so we retried");
  say(prose === "Did it fail? yes it did, so we retried", "a question mark in ordinary prose is not a query string", prose);
  const hash = faults.scrub("Bad signature: 9f2a4c8e1b7d3f5a0c6e8b2d4f6a8c0e1b3d5f7a9c");
  say(!hash.includes("9f2a4c8e1b7d3f5a"), "a long opaque run is removed", hash);
  const digits = faults.scrub("Card 4111111111111111 was rejected");
  say(!digits.includes("4111111111111111"), "a long digit run is removed", digits);
  const long = faults.scrub("x".repeat(900));
  say(long.length <= faults.FAULT_MESSAGE_MAX, "a message is capped", `${long.length} chars`);
  const plain = faults.scrub("Cannot read properties of undefined (reading 'map')");
  say(
    plain === "Cannot read properties of undefined (reading 'map')",
    "an ordinary message survives intact, because a scrubber that eats the text is useless",
  );
  // The honest limit, stated rather than hidden: a bare secret with no shape of its own
  // is not detectable, which is why the route also refuses to record anything but these
  // four fields in the first place.
  console.log(
    "note a bare word with no shape (a password with no symbols) is NOT scrubbed: nothing can tell it from prose. That is why only the error's own fields are ever sent.",
  );

  // ── 2. one fault, however often it happens ───────────────────────────────
  console.log("\n== two sightings, one fault ==");
  const a = faults.fingerprintOf({ route: "/feed", name: "Error", message: plain });
  const b = faults.fingerprintOf({ route: "/feed", name: "Error", message: plain });
  const c = faults.fingerprintOf({ route: "/world", name: "Error", message: plain });
  say(a === b, "the same fault on the same route fingerprints the same");
  say(a !== c, "the same fault on another route does not");
  say(a.length === 64, "the fingerprint is a sha256 in hex", `${a.length} chars`);
  const origin = "https://www.swampai.world";
  const stack = [
    "Error: boom",
    "    at Widget (https://cdn.jsdelivr.net/npm/thing@1/thing.js:1:1)",
    "    at Feed (https://www.swampai.world/_next/static/chunks/main.js:9:9)",
    "    at Wall (https://www.swampai.world/feed?x=1#hash)",
  ].join("\n");
  const frame = faults.sameOriginFrame(stack, origin);
  say(frame === "/feed", "the frame kept is this site's own, without its query", String(frame));
  say(faults.sameOriginFrame(stack, origin) !== null, "a cross-origin frame is not preferred over ours");
  say(
    faults.sameOriginFrame("at x (https://cdn.example.com/a.js:1:1)", origin) === null,
    "a stack with nothing of ours in it keeps no frame at all",
  );
  const norm = faults.normaliseFault(
    { route: "/f".repeat(400), name: "E".repeat(400), message: "m".repeat(2000), frame: null },
    origin,
  );
  say(norm.route.length <= faults.FAULT_ROUTE_MAX, "a route is capped");
  const queried = faults.normaliseFault(
    { route: "/feed?token=abc123", name: "Error", message: "boom", frame: null },
    origin,
  );
  say(queried.route === "/feed", "a route carrying a query is stored as the path alone", queried.route);
  say(norm.name.length <= faults.FAULT_NAME_MAX, "an error name is capped");
  say(norm.message.length <= faults.FAULT_MESSAGE_MAX, "the message is capped after scrubbing");

  // ── 3. the reporter cannot throw ─────────────────────────────────────────
  console.log("\n== a reporter that fails the way the page did is worse than no reporter ==");
  const reporter = read("lib/report-fault.ts") || "";
  say(reporter.length > 0, "the browser-side reporter exists");
  // Comments first: this file's own prose names the server module and the Set, and the
  // first run of this check failed on its own documentation. Same lesson as the write
  // audit's, kept here rather than learned twice.
  const reporterCode = reporter
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
  say(/try\s*\{/.test(reporterCode) && /catch/.test(reporterCode), "it is wrapped so it cannot throw");
  say(!/server-only/.test(reporterCode), "it does not import the server module");
  say(/new Set<string>\(\)/.test(reporterCode), "it dedupes a render loop's repetition");
  say(/budget/.test(reporterCode), "and it has a total budget per page session");
  say(/sendBeacon/.test(reporterCode), "it prefers a beacon, which survives the page unloading");
  const beacon = read("components/fault-beacon.tsx") || "";
  say(/addEventListener\("error"/.test(beacon), "the beacon listens for uncaught errors");
  say(/unhandledrejection/.test(beacon), "and for unhandled rejections, which never reach a boundary");
  const layout = read("app/layout.tsx") || "";
  say(/<FaultBeacon \/>/.test(layout), "it is mounted once, in the root layout");
  const routeError = read("app/error.tsx") || "";
  const globalError = read("app/global-error.tsx") || "";
  say(/reportFault/.test(routeError), "the route boundary reports what it caught");
  say(/reportFault/.test(globalError), "and so does the root one, which renders its own html");

  // ── 4. the wiring a fault needs to be readable ───────────────────────────
  console.log("\n== and it lands somewhere the swarm can read ==");
  const endpoint = read("app/api/faults/route.ts") || "";
  say(/export async function POST/.test(endpoint), "the endpoint takes a report on POST");
  say(/export async function GET/.test(endpoint), "and serves the list on GET");
  say(/throttle\(/.test(endpoint), "with a per-caller cap");
  say(/req\.text\(\)/.test(endpoint), "it reads the body as text, because a beacon cannot set a type");
  const page = read("app/faults/page.tsx") || "";
  say(/What is not/.test(page), "the page says what is NOT recorded");
  say(/does not prove/.test(page), "and what the list does not prove");
  const surfaces = JSON.parse(read("lib/surfaces.json") || "{}");
  const eps = (surfaces.endpoints || []).filter((e) => e.path === "/api/faults");
  say(eps.length === 2, "both fault endpoints are in the surface registry", `${eps.length} entries`);
  say((surfaces.pages || []).some((p) => p.path === "/faults"), "and so is the page");
  const topic = "client.fault";
  say((read("lib/agents/types.ts") || "").includes(`"${topic}"`), `${topic} is in the event-topic union`);
  say((read("lib/agents/feed-render.ts") || "").includes(`"${topic}"`), `${topic} has a feed label`);
  say((read("lib/world/zones.ts") || "").includes(`"${topic}"`), `${topic} is routed in the world`);
  say(
    (read("supabase/migrate-event-topics-union.sql") || "").includes(`'${topic}'`),
    `${topic} is in the migration that widens the constraint`,
  );
  say(
    (read("lib/swamp/observations.ts") || "").includes("browserFaults"),
    "residents see the faults, which is the only way one can be fixed",
  );
  say(
    (read("lib/swamp/brain.ts") || "").includes("browser_faults_seen_by_visitors"),
    "and the model planner is told about them by name",
  );

  // ── 5. live ──────────────────────────────────────────────────────────────
  if (!LIVE) {
    note("the live check (--live): the table, and the constraint that lets a fault be published");
  } else {
    console.log("\n== live ==");
    const { Client } = require("pg");
    const env = {};
    for (const line of (read(".env.local") || "").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    const ref = /https:\/\/([a-z0-9]+)\./.exec(env.NEXT_PUBLIC_SUPABASE_URL || "")?.[1];
    if (!ref || !process.env.PGPASSWORD) {
      note("the database checks (no project ref in .env.local, or no PGPASSWORD)");
    } else {
      const c = new Client({
        host: process.env.PGHOST || "aws-1-eu-west-1.pooler.supabase.com",
        port: Number(process.env.PGPORT || 6543),
        user: `postgres.${ref}`,
        password: process.env.PGPASSWORD,
        database: "postgres",
        ssl: { rejectUnauthorized: false },
      });
      await c.connect();
      const t = await c.query(
        "select count(*)::int n from information_schema.tables where table_name='client_faults'",
      );
      say(t.rows[0].n === 1, "the table exists", "client_faults");
      const col = await c.query(
        "select count(*)::int n from information_schema.columns where table_name='client_faults' and column_name in ('fingerprint','route','name','message','frame','count','first_seen','last_seen')",
      );
      say(col.rows[0].n === 8, "and holds exactly the eight fields this promises", `${col.rows[0].n}/8`);
      const addr = await c.query(
        "select count(*)::int n from information_schema.columns where table_name='client_faults' and (column_name ilike '%ip%' or column_name ilike '%address%' or column_name ilike '%agent%' or column_name ilike '%session%')",
      );
      say(addr.rows[0].n === 0, "and no column that could identify a visitor");
      const def = (
        await c.query(
          "select pg_get_constraintdef(oid) as def from pg_constraint where conname='events_topic_check'",
        )
      ).rows[0]?.def ?? "";
      say(def.includes("client.fault"), "the database accepts the topic a fault is published on");
      await c.end();
    }
  }

  console.log(
    failed === 0 ? `\nfaults: all checks passed${skipped ? ` (${skipped} skipped)` : ""}` : `\nfaults: ${failed} check(s) failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
