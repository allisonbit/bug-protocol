#!/usr/bin/env node
/**
 * Can a cabal stand with nobody on it, and would anybody find out?
 *
 * WHY THIS EXISTS AT ALL. Measured on 2026-09-20: `cabal_members` is keyed
 * `(cabal_id, agent_id)`, the planner built the roster one row per CLAIM, and on the
 * single target that has ever formed a cabal one agent held three live claims and two
 * others held two each. A payload naming the same agent repeatedly is refused WHOLE by
 * the composite key — `23505 duplicate key value violates unique constraint
 * "cabal_members_pkey"`, reproduced in a rolled-back transaction — and `pulse.ts`
 * discarded the result one line after a neighbouring insert checked its own.
 *
 * So both cabals this swarm has ever formed stood with ZERO member rows, every reader
 * filters `left_at is null` and drew a team with nobody in it, `CabalCard` rendered the
 * absence as history ("the crew left when it ended"), and each cabal's own purpose line
 * announced "2 agents" and "5 agents" — a count of claims wearing the word agents.
 *
 * WHAT IT PINS.
 *
 *   1. THE DECISIONS, with no database: a repeated agent collapses to one member, the
 *      first subtask survives as the role, a claim with no agent is dropped rather than
 *      taking the whole roster down with it, a missing handle falls back to the id, and
 *      every one of those is idempotent.
 *   2. A TEAM NEEDS TWO AGENTS, checked in both planners, because `claims.length >= 2`
 *      is satisfied by one agent claiming twice.
 *   3. A REFUSAL IS WRITTEN DOWN: the insert's error reaches `roster_note` on the cabal
 *      and `cabal.roster_failed` on the bus, and that topic is in the union, labelled,
 *      routed and allowed by the database's own constraint.
 *   4. WITH --live: no cabal stands with neither a roster nor a note. That is the exact
 *      condition the two existing cabals were in.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-cabal-roster.cjs [--live]
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
  const roster = await import("@/lib/swamp/roster");

  // ── 1. the decisions ─────────────────────────────────────────────────────
  console.log("== who is actually in the group ==");
  const handles = new Map([
    ["a", "ada"],
    ["b", "bram"],
  ]);
  const claims = [
    { agent_id: "a", subtask: "sweep" },
    { agent_id: "b", subtask: "review" },
    { agent_id: "a", subtask: "report" },
    { agent_id: "a", subtask: "report again" },
    { agent_id: "b", subtask: "review" },
  ];
  const members = roster.rosterFromClaims(claims, handles);
  say(members.length === 2, "five claims held by two agents make two members", `${members.length} members`);
  say(
    members.map((m) => m.agentId).join(",") === "a,b",
    "the order is the order they first appear",
    members.map((m) => m.handle).join(", "),
  );
  say(members[0].role === "sweep", "a member's role is the first thing it claimed", String(members[0].role));
  say(
    members.every((m) => m.role === "sweep" || m.role === "review"),
    "a later claim does not overwrite the role",
    members.map((m) => m.role).join(", "),
  );
  say(
    roster.distinctMembers(members).length === members.length,
    "run again over its own output, nothing changes",
  );
  const withGap = roster.rosterFromClaims(
    [{ agent_id: null, subtask: "x" }, ...claims],
    handles,
  );
  say(
    withGap.length === 2 && withGap.every((m) => m.agentId),
    "a claim with no agent is dropped rather than taking the roster down with it",
    `${withGap.length} members`,
  );
  const unknown = roster.rosterFromClaims([{ agent_id: "ghost", subtask: null }], handles);
  say(unknown[0].handle === "ghost", "a handle nobody has falls back to the id, never to blank", unknown[0].handle);
  say(unknown[0].role === null, "a claim with no subtask gives a member with no role");
  say(roster.distinctMembers([]).length === 0, "nobody is a valid empty roster");
  say(
    roster.distinctMembers([{ agentId: "  ", handle: "x", role: null }]).length === 0,
    "a blank id is dropped too, because the foreign key would refuse it",
  );

  // ── 2. a team needs two agents ───────────────────────────────────────────
  console.log("\n== a team needs two people, not two claims ==");
  const brain = read("lib/swamp/brain.ts") || "";
  const guards = [...brain.matchAll(/members\.length\s*<\s*2/g)].length;
  say(guards === 2, "both planners refuse a group of one", `${guards} guards`);
  say(
    /rosterFromClaims\(claims, peerHandles\)/.test(brain) && /rosterFromClaims\(claims, handles\)/.test(brain),
    "both planners build the roster from agents rather than from claims",
  );
  say(!/claims\.map\(\(c\) => \(\{ agentId: c\.agent_id/.test(brain), "no planner still maps claims straight onto members");

  // ── 3. a refusal is written down ─────────────────────────────────────────
  console.log("\n== and a refused roster says so ==");
  const pulse = read("lib/swamp/pulse.ts") || "";
  say(/const \{ error \} = await sb[\s\S]{0,160}cabal_members[\s\S]{0,160}\.insert\(/.test(pulse), "the roster insert reads its own error");
  say(/roster_note/.test(pulse), "and writes the refusal onto the cabal");
  say(/cabal\.roster_failed/.test(pulse), "and publishes it");
  say(/distinctMembers\(plan\.members\)/.test(pulse), "the write dedupes as well as the planner");
  const topic = "cabal.roster_failed";
  const types = read("lib/agents/types.ts") || "";
  const feed = read("lib/agents/feed-render.ts") || "";
  const zones = read("lib/world/zones.ts") || "";
  const helper = read("supabase/migrate-event-topics-union.sql") || "";
  say(types.includes(`"${topic}"`), `${topic} is in the event-topic union`);
  say(feed.includes(`"${topic}"`), `${topic} has a feed label`);
  say(zones.includes(`"${topic}"`), `${topic} is routed in the world`);
  say(helper.includes(`'${topic}'`), `${topic} is in the migration that widens the constraint`);
  const changes = read("app/cabals/page.tsx") || "";
  say(/roster_note/.test(changes), "the page a reader judges this by shows the note");
  say(
    /Roster unknown/.test(changes),
    "and it says unknown rather than letting an empty list read as history",
  );

  // ── 4. live ──────────────────────────────────────────────────────────────
  if (!LIVE) {
    note("the live check (--live): no cabal with no roster and no note");
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
      const col = await c.query(
        "select column_name from information_schema.columns where table_name='cabals' and column_name='roster_note'",
      );
      say(col.rows.length === 1, "the database has the column the refusal is recorded in", "cabals.roster_note");
      const orphans = await c.query(
        "select c.slug from cabals c where c.roster_note is null and not exists (select 1 from cabal_members m where m.cabal_id = c.id)",
      );
      say(
        orphans.rows.length === 0,
        "no cabal stands with neither a roster nor a note",
        orphans.rows.length === 0 ? "" : `silent: ${orphans.rows.map((r) => r.slug).join(", ")}`,
      );
      const total = await c.query("select count(*)::int n from cabals");
      const noted = await c.query("select count(*)::int n from cabals where roster_note is not null");
      console.log(`     ${total.rows[0].n} cabal(s), ${noted.rows[0].n} recorded as unknown`);
      await c.end();
    }
  }

  console.log(
    failed === 0 ? `\ncabal-roster: all checks passed${skipped ? ` (${skipped} skipped)` : ""}` : `\ncabal-roster: ${failed} check(s) failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
