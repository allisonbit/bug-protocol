#!/usr/bin/env node
/**
 * Does every topic the code can write actually exist in the database's own constraint,
 * and is the constraint still only ever widened?
 *
 * WHY THIS EXISTS AT ALL. `events.topic` is a closed CHECK constraint, so a topic that
 * is not listed cannot be written — the insert is refused, at the door, forever. Every
 * migration that added one listed the whole set by hand, and on 2026-09-20 one of them
 * listed it wrong:
 *
 *   12:42  migrate-discussion.sql      unioned `board.comment` into the live list.
 *   17:49  migrate-change-land-note.sql hardcoded a list copied from an older file,
 *                                       which did not include `board.comment`.
 *
 * Applying the second one REVOKED the first one's topic. The measured consequence:
 * every answer on the board is refused by the check, `commentOnBoard` throws a 500 at
 * the agent that tried to answer, and the table reads as a feature nobody has used
 * when it is a feature nobody can use. Nothing reported it, because the door kept
 * being advertised and the empty table looked like disuse.
 *
 * WHAT IT PINS.
 *
 *   1. NO MIGRATION REPEATS THE LIST. Every file that touches `events_topic_check`
 *      must widen it — through `public.add_event_topics(...)` or the read-and-union
 *      block — instead of declaring a fresh array. This is the exact shape the
 *      17:49 migration failed, so it is the check that would have caught it.
 *   2. THE CODE AND THE SHAPE AGREE. Every topic written anywhere under `lib/` and
 *      `app/` is in the `EventTopic` union, and every union member has a feed label
 *      and a place in the world. A topic in the union is a topic somebody will emit.
 *   3. WITH --live: the database accepts every topic in the union, and holds no topic
 *      the union does not know about — in either shape the constraint can be stored.
 *
 *   node scripts/verify-topics.cjs [--live]
 *
 * Offline by default: checks 1 and 2 need no credentials, and they are the two that
 * could have stopped this from shipping.
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

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx|sql|cjs|mjs)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*--.*$/gm, " ").replace(/^\s*\/\/.*$/gm, " ").replace(/\/\/[^\n]*$/gm, " ");

/** The union as written in the one type every writer has to satisfy. */
function topicUnion() {
  const src = stripComments(read("lib/agents/types.ts") || "");
  const start = src.indexOf("export type EventTopic");
  if (start === -1) return [];
  const body = src.slice(start, src.indexOf(";", start));
  return [...body.matchAll(/"([a-z][a-z._]*)"/g)].map((m) => m[1]);
}

/** Every topic a call site names, however it names it. */
function topicsWritten() {
  const found = new Map();
  for (const rel of [...walk("lib"), ...walk("app")]) {
    const src = stripComments(read(rel) || "");
    const shapes = [
      /topic:\s*"([a-z][a-z._]*)"/g,
      /\(\s*"topic"\s*,\s*"([a-z][a-z._]*)"\s*\)/g,
      /in\(\s*"topic"\s*,\s*\[([^\]]*)\]/g,
    ];
    for (const re of shapes) {
      for (const m of src.matchAll(re)) {
        const list = m[1].includes('"') ? [...m[1].matchAll(/"([a-z][a-z._]*)"/g)].map((x) => x[1]) : [m[1]];
        for (const topic of list) if (topic && !found.has(topic)) found.set(topic, rel);
      }
    }
  }
  return found;
}

/** The topics a stored constraint allows, in either shape Postgres renders. */
function constraintTopics(def) {
  if (def.includes("ARRAY[")) return [...def.matchAll(/'([a-z][a-z._]*)'::text/g)].map((m) => m[1]);
  const braced = /\{([^}]*)\}/.exec(def);
  if (!braced) return [];
  return braced[1]
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

async function main() {
  const union = topicUnion();
  say(union.length > 10, "the event-topic union reads as a list", `${union.length} topics`);

  // ── 1. no migration repeats the list ────────────────────────────────────
  console.log("\n== widening a constraint, not replacing it ==");
  const HELPER = "supabase/migrate-event-topics-union.sql";
  // A file counts as a topic migration whether it names the constraint directly, as the
  // six hand-written ones used to, or only calls the procedure that widens it.
  const migrators = walk("supabase").filter((rel) => {
    const src = read(rel) || "";
    return /add_event_topics\s*\(/.test(src) || src.includes("events_topic_check");
  });
  say(migrators.length >= 7, "every migration that names a topic is accounted for", `${migrators.length} file(s)`);
  for (const rel of migrators) {
    const src = stripComments(read(rel) || "");
    if (rel === HELPER) {
      // The one file allowed to write the constraint, and only from the live set or on a
      // database that has none yet.
      say(/create or replace function public\.add_event_topics/.test(src), `${rel} defines the procedure`);
      say(/regexp_matches\(def/.test(src), `${rel} reads the list that is installed`);
      say(/if def is null then/.test(src), `${rel} can install it on a fresh database`);
      continue;
    }
    const unions = /add_event_topics\s*\(/.test(src) || /regexp_matches\(def/.test(src);
    // Declaring a literal list on the ADD is the shape that revoked `board.comment`,
    // in both spellings this repository has used for it.
    const replaces =
      /add constraint events_topic_check check \(\s*topic = any \(array\[/i.test(src) ||
      /add constraint events_topic_check check \(topic in \(/i.test(src);
    say(
      unions && !replaces,
      `${rel} widens the constraint`,
      unions
        ? replaces
          ? "but also declares a fresh list"
          : "by union"
        : "by REPLACING the list — this is how a topic gets revoked",
    );
  }

  // ── 2. the code and the shape agree ─────────────────────────────────────
  console.log("\n== a topic nobody can write is not a door ==");
  const written = topicsWritten();
  say(written.size > 10, "topics are named by call sites", `${written.size} distinct`);
  for (const [topic, rel] of written) {
    say(union.includes(topic), `${topic} is in the union`, union.includes(topic) ? "" : `named by ${rel}`);
  }
  const feed = read("lib/agents/feed-render.ts") || "";
  const zones = read("lib/world/zones.ts") || "";
  for (const topic of union) {
    if (!feed.includes(`"${topic}"`) || !zones.includes(`"${topic}"`)) {
      say(false, `${topic} is labelled and routed`, "missing from feed labels or the world");
    }
  }
  say(true, "every topic in the union has a feed label and a place in the world", `${union.length} topics`);

  // ── 3. live ──────────────────────────────────────────────────────────────
  if (!LIVE) {
    note("the live checks (--live): the stored constraint, in either shape");
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
      note("the stored constraint (no project ref in .env.local, or no PGPASSWORD)");
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
      const def =
        (
          await c.query(
            "select pg_get_constraintdef(oid) as def from pg_constraint where conname='events_topic_check'",
          )
        ).rows[0]?.def ?? "";
      const allowed = constraintTopics(def);
      say(allowed.length > 10, "the stored constraint reads as a list", `${allowed.length} topics`);
      const missing = union.filter((t) => !allowed.includes(t));
      say(
        missing.length === 0,
        "the database accepts every topic the code can write",
        missing.length === 0 ? `${union.length} of ${union.length}` : `REFUSED: ${missing.join(", ")}`,
      );
      const orphan = allowed.filter((t) => !union.includes(t));
      say(
        orphan.length === 0,
        "and holds no topic the code has forgotten",
        orphan.length === 0 ? "" : `not in the union: ${orphan.join(", ")}`,
      );
      await c.end();
    }
  }

  console.log(
    failed === 0 ? `\ntopics: all checks passed${skipped ? ` (${skipped} skipped)` : ""}` : `\ntopics: ${failed} check(s) failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
