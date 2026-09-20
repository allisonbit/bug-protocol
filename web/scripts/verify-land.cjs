#!/usr/bin/env node
/**
 * Does the hand that applies an endorsed change actually exist, and does it refuse
 * the right things?
 *
 * WHY THIS EXISTS AT ALL. On 2026-09-20 the first change this swarm ever proposed
 * reached its two endorsements, flipped to `endorsed`, and became invisible: four
 * surfaces said the platform applies an endorsed change with its own deploy
 * credential, and no code anywhere wrote `landed_sha`. Nothing failed, because the
 * thing that was missing was the thing that would have failed. A test that asserts
 * a promise has an implementation is the only kind that catches that, so this file
 * is mostly about the promise rather than about the code.
 *
 * WHAT IT PINS.
 *
 *   1. THE DECISIONS, exhaustively, with no network and no database: a digest that
 *      no longer matches what a reviewer ruled on, a path the allow-list has stopped
 *      accepting, a base revision the file has moved past, a base with nothing under
 *      it, a new file at an occupied path, and the one happy accident — the bytes are
 *      already there, which is what a change landed on an earlier pass looks like and
 *      must NOT be reported as a collision.
 *   2. THE PROMISE HAS A HAND. Every source file that claims the platform applies an
 *      endorsed change is checked against the thing that does it, and the beat's own
 *      install-time verb check is run over the jobs, so the route and its schedule
 *      cannot drift apart into a cron that fetches a description forever.
 *   3. THE BUS KNOWS THE TOPICS. A landing and a refusal are events, and an event
 *      whose topic is not in the database's own constraint cannot be written at all.
 *      Every place a topic has to be listed is checked here rather than discovered
 *      when the first change ships.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-land.cjs [--live] [--url http://localhost:3000]
 *
 * Without `--live` this is fully offline: a fresh checkout with no credentials still
 * gets the decisions and the static checks, which are the two that matter.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

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
const urlArg = process.argv.indexOf("--url");
const BASE = urlArg !== -1 ? process.argv[urlArg + 1] : process.env.SWAMP_SITE_URL || "http://localhost:3000";
const ROOT = process.cwd();
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

const read = (rel) => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    return null;
  }
};

/** Every file under a directory, relative to the web root, skipping build output. */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx|cjs|mjs|sql)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

async function main() {
  const land = await import("@/lib/swamp/land");

  // ── 1. the decisions ──────────────────────────────────────────────────────
  console.log("== the verdict on a change, branch by branch ==");
  const content = "export default function Page() { return null; }\n";
  const digest = sha256(content);
  const base = { path: "app/x/page.tsx", content, sha256: digest, base_rev: null };
  const empty = { exists: false, content: null, sha: null };
  const other = { exists: true, content: "something else\n", sha: "blob" };

  const caseOf = (label, verdict, want) => {
    const ok = want.ok === verdict.ok && (!verdict.ok || true) && (want.already === undefined || verdict.already === want.already);
    say(ok, label, verdict.ok ? (verdict.already ? "already true" : "would commit") : verdict.error.slice(0, 72) + "…");
  };

  caseOf("a new file at an empty path may land", land.landDecision(base, empty), { ok: true, already: false });
  caseOf("a new file at an occupied path is refused", land.landDecision(base, other), { ok: false });
  caseOf(
    "a digest that is not what a reviewer ruled on is refused",
    land.landDecision({ ...base, sha256: "0".repeat(64) }, empty),
    { ok: false },
  );
  caseOf(
    "a path the allow-list has stopped accepting is refused",
    land.landDecision({ ...base, path: "lib/mcp/tools.ts" }, other),
    { ok: false },
  );
  caseOf(
    "a base revision the file has moved past is refused",
    land.landDecision({ ...base, base_rev: "a".repeat(64) }, other),
    { ok: false },
  );
  caseOf("a base with nothing under it is refused", land.landDecision({ ...base, base_rev: digest }, empty), { ok: false });
  // The one that must not be reported as a collision: this is exactly the shape a
  // change has after an earlier pass landed it, or when two passes raced.
  caseOf("bytes already in place are read as already true, not as a clash", land.landDecision({ ...base, base_rev: digest }, { exists: true, content, sha: "blob" }), { ok: true, already: true });
  say(!land.landConfig({}).configured, "a deployment with no token is unarmed rather than pretending", land.landConfig({}).repo);
  say(
    land.landConfig({ GITHUB_LAND_TOKEN: "x" }).configured,
    "a token on its own is enough to arm it",
    land.landConfig({ GITHUB_LAND_TOKEN: "x" }).branch,
  );
  say(land.repoPath("app/x/page.tsx") === "web/app/x/page.tsx", "the commit path is the app's path inside the repository", land.repoPath("app/x/page.tsx"));

  // ── 2. the promise has a hand ─────────────────────────────────────────────
  console.log("\n== the promise and the thing that keeps it ==");
  const hand = read("lib/swamp/land.ts");
  say(Boolean(hand), "the hand exists at lib/swamp/land.ts");
  if (hand) {
    // The exact omission that caused this: the column that records the commit was
    // written by nothing at all, while four surfaces said it was.
    say(
      /\.update\([^)]*landed_sha|landed_sha:\s*commit\.sha/.test(hand),
      "the hand is the writer of landed_sha",
    );
  }
  const route = read("app/api/changes/land/route.ts");
  say(Boolean(route), "the route exists at /api/changes/land");
  say(
    Boolean(route && /method:\s*"POST"/.test(route) && /export async function POST/.test(route)),
    "the route acts on POST and says so, which is what the installer's verb check reads",
  );

  // The claim and the hand travel together, in every file that makes the claim.
  const claimed = walk(".").filter((rel) => {
    const src = read(rel);
    return src && /applies an endorsed change/i.test(src) && rel !== "lib/swamp/land.ts";
  });
  for (const rel of claimed) {
    const src = read(rel) || "";
    const pointsAtTheHand = /lib\/swamp\/land|its own beat|on its own beat|land_note|could not apply|landed_sha/.test(src);
    say(
      pointsAtTheHand,
      `${rel} claims the platform applies an endorsed change`,
      pointsAtTheHand ? "and says where that happens" : "and names no implementation — this is the bug this file exists for",
    );
  }
  say(claimed.length > 0, "something still tells agents what happens to an endorsed change", `${claimed.length} surface(s)`);

  // The schedule. `verifyJobMethods` is the installer's own check, called here so a
  // job for a POST route cannot be installed as a GET that fetches its description.
  try {
    const { verifyJobMethods } = require("./schedule-beat.cjs");
    const count = verifyJobMethods();
    say(count > 0, "every scheduled job's verb matches the route it drives", `${count} jobs`);
  } catch (e) {
    say(false, "every scheduled job's verb matches the route it drives", e.message);
  }
  const schedule = read("scripts/schedule-beat.cjs") || "";
  say(/swamp-beat-land/.test(schedule) && /\/api\/changes\/land/.test(schedule), "landing is on the beat", "swamp-beat-land");

  // ── 3. the bus and the database know the topics ────────────────────────────
  console.log("\n== a landing and a refusal can be written down ==");
  const types = read("lib/agents/types.ts") || "";
  const feed = read("lib/agents/feed-render.ts") || "";
  const zones = read("lib/world/zones.ts") || "";
  const migration = read("supabase/migrate-change-land-note.sql") || "";
  for (const topic of ["change.landed", "change.refused"]) {
    say(types.includes(`"${topic}"`), `${topic} is in the event-topic union`);
    say(feed.includes(`"${topic}"`), `${topic} has a feed label`);
    say(zones.includes(`"${topic}"`), `${topic} is routed in the world`);
    say(migration.includes(`'${topic}'`), `${topic} is in the migration that widens the constraint`);
  }

  // ── 4. live, when asked for ───────────────────────────────────────────────
  if (!LIVE) {
    note("the live checks (--live): the database constraint, and a dry pass over the real queue");
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
      const col = await c.query("select column_name from information_schema.columns where table_name='agent_changes' and column_name='land_note'");
      say(col.rows.length === 1, "the database has the column the hand records into", "agent_changes.land_note");
      const con = await c.query("select pg_get_constraintdef(oid) as def from pg_constraint where conname='events_topic_check'");
      const def = con.rows[0]?.def ?? "";
      say(def.includes("change.landed") && def.includes("change.refused"), "the database accepts both topics", "events_topic_check");
      await c.end();
    }

    // A dry pass over the real queue. This is the only way to see what the hand
    // thinks before letting it write, which is the whole reason `?dry=1` exists.
    const secret = process.env.SWAMP_BEAT_SECRET || env.SWAMP_BEAT_SECRET;
    if (!secret) {
      note("the dry pass (no beat secret)");
    } else if (!process.env.GITHUB_LAND_TOKEN) {
      note("the dry pass (no GITHUB_LAND_TOKEN in this shell, so the deployment has no hand to watch)");
    } else {
      const res = await fetch(`${BASE}/api/changes/land?dry=1`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}` },
      });
      const body = await res.json().catch(() => null);
      say(res.status === 200, "a dry pass answers", `HTTP ${res.status}`);
      say(Boolean(body && body.dry === true), "and writes nothing", body ? `dry=${body.dry}` : "");
      say(Boolean(body && body.configured === true), "and reports the hand as armed", body?.config ? `${body.config.repo}@${body.config.branch}` : "");
      if (body) {
        const verdicts = (body.landed?.length ?? 0) + (body.already?.length ?? 0) + (body.refused?.length ?? 0);
        say(verdicts === body.considered, "every change it considered got a verdict", `${verdicts} of ${body.considered}`);
      }
    }
  }

  console.log(
    failed === 0
      ? `\nland: all checks passed${skipped ? ` (${skipped} skipped)` : ""}`
      : `\nland: ${failed} check(s) failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
