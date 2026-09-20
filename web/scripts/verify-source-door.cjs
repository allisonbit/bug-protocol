#!/usr/bin/env node
/**
 * Does the read door serve what the change door would accept, and is a blind
 * overwrite actually refused?
 *
 * WHY THIS IS A SCRIPT AND NOT A SENTENCE. Three separate things have to agree for
 * `read_source` to be the door that makes `propose_change` walkable, and each one
 * fails quietly on its own:
 *
 *   1. THE SNAPSHOT IS WHAT IS ON DISK. It is generated, gitignored and carried
 *      into the bundle, so a stale copy is invisible: an agent would read a file as
 *      it was three commits ago, write a faithful replacement of the OLD version,
 *      and two peers would endorse it. This regenerates the snapshot from the real
 *      files and compares.
 *   2. THE READER AND THE WRITER ARE THE SAME SET. A path `read_source` will serve
 *      and `propose_change` will refuse sends a writer to compose a replacement it
 *      cannot propose; the other way round is worse, because it means a file can be
 *      replaced without ever having been readable. Every listed path is checked
 *      against `checkPath` here, and the refusals are checked in both directions.
 *   3. THE BASE REVISION IS ENFORCED. That is the part with teeth: the door carries
 *      complete contents, so replacing a file whose current revision the writer has
 *      not read is a guess about every line it is not changing. This test needs the
 *      database, so it is run against whatever deployment the environment points
 *      at, and it CLEANS UP after itself: the probe's change row is deleted, which
 *      is exact because proposing writes one row and appends no event.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-source-door.cjs [--live]
 *
 * Without `--live` the database test is skipped and the offline checks still run,
 * so this is usable in a fresh checkout with no credentials.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

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

const SNAPSHOT_FILE = path.join(process.cwd(), "lib", "source", "snapshot.json");
const LIVE = process.argv.includes("--live");

async function main() {
  // ── 1. the snapshot cannot drift from the files it describes ───────────────
  console.log("== the snapshot against the files ==");
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    say(false, "a snapshot exists", "run `npm run source-index`");
    summary();
    return;
  }
  const before = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
  execFileSync(process.execPath, [path.join(process.cwd(), "scripts", "build-source-index.cjs")], {
    stdio: "pipe",
  });
  const after = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
  say(before.rev === after.rev, "regenerating the snapshot reproduces it exactly", `${after.fileCount} file(s)`);
  say(after.fileCount > 0, "the snapshot carries files", `${after.fileCount}`);

  // Every file it claims to carry has to be byte-identical to the file on disk,
  // and the digest it publishes has to be the digest of those bytes. A digest that
  // describes something else is worse than no digest, because a change names it as
  // the base it was written against.
  let mismatched = [];
  let badDigest = [];
  for (const [p, entry] of Object.entries(after.files)) {
    const onDisk = fs.readFileSync(path.join(process.cwd(), p), "utf8");
    if (onDisk !== entry.content) mismatched.push(p);
    if (crypto.createHash("sha256").update(onDisk, "utf8").digest("hex") !== entry.sha256) badDigest.push(p);
  }
  say(mismatched.length === 0, "every carried file matches what is on disk", mismatched.slice(0, 3).join(", "));
  say(badDigest.length === 0, "every published digest is the digest of those bytes", badDigest.slice(0, 3).join(", "));

  // ── 2. the reader and the writer are one set ──────────────────────────────
  console.log("\n== the read door and the change door agree ==");
  const source = await import(pathToFileURL(path.join(process.cwd(), "lib", "source", "index.ts")).href);
  const changes = await import(pathToFileURL(path.join(process.cwd(), "lib", "swamp", "changes.ts")).href);

  const listing = source.listSource();
  say(listing.rev === after.rev, "the reader reports the snapshot's revision", String(listing.rev).slice(0, 12));
  const refusedButListed = listing.files.filter((f) => !changes.checkPath(f.path).ok).map((f) => f.path);
  say(
    refusedButListed.length === 0,
    "every listed path is one the change door accepts",
    refusedButListed.slice(0, 3).join(", "),
  );

  // The narrow half, in both directions: a route is not a page, and a page is.
  for (const p of ["app/api/mcp/route.ts", "app/quiet/route.ts", "app/agents/[handle]/page.tsx", "app/theme.css"]) {
    const ok = changes.checkPath(p).ok;
    if (p.endsWith("route.ts")) say(!ok, `${p} is refused: a route answers a URL and runs in this environment`);
    else say(ok, `${p} is accepted`);
  }
  for (const p of ["lib/supabase.ts", ".env.local", "package.json", "scripts/build-source-index.cjs"]) {
    say(!changes.checkPath(p).ok, `${p} is still refused`);
  }

  // ── 2b. reading a file returns its real bytes and a usable digest ─────────
  const target = "app/quiet/page.tsx";
  const reading = source.readSourceFile(target);
  const onDisk = fs.readFileSync(path.join(process.cwd(), target), "utf8");
  say(reading.content === onDisk, `reading ${target} returns the file, byte for byte`);
  say(reading.sha256 === after.files[target].sha256, "and the digest a change must name as its base");
  say(reading.rev === after.rev, "and the whole-source revision it was read at");
  let refused = null;
  try {
    source.readSourceFile("app/api/mcp/route.ts");
  } catch (e) {
    refused = e.message;
  }
  say(Boolean(refused), "a server route cannot be read through this door", refused || "no refusal");
  let missing = null;
  try {
    source.readSourceFile("app/nothing-here/page.tsx");
  } catch (e) {
    missing = e.message;
  }
  say(Boolean(missing), "a file that does not exist is refused by name", missing || "no refusal");

  // ── 3. a blind overwrite is refused ───────────────────────────────────────
  console.log("\n== the base revision ==");
  if (!LIVE) {
    note("the database test (pass --live to run it against the environment's database)");
    summary();
    return;
  }
  const supabase = await import(pathToFileURL(path.join(process.cwd(), "lib", "supabase", "index.ts")).href);
  const sb = supabase.supabaseAdmin();
  if (!sb) {
    note("the database test (no service-role client)");
    summary();
    return;
  }
  const { data: agentRow } = await sb.from("agents").select("*").eq("runtime_enabled", true).limit(1).maybeSingle();
  if (!agentRow) {
    note("the database test (no agent to act as)");
    summary();
    return;
  }

  const created = [];
  const attempt = async (label, input, expect) => {
    try {
      const row = await changes.proposeChange(sb, agentRow, input);
      created.push(row.id);
      say(expect === "ok", label, expect === "ok" ? row.path : `it was accepted (${row.id})`);
      return row;
    } catch (e) {
      say(expect !== "ok", label, `${e.status ?? ""} ${e.message}`.trim().slice(0, 140));
      return null;
    }
  };

  // An existing file with no base: refused, and the message says what to do.
  await attempt(
    "replacing an existing file with no base_rev is refused",
    { path: target, content: reading.content, reason: "probe: no base given" },
    "refused",
  );
  // An existing file with a base that is not the file's: refused.
  await attempt(
    "replacing an existing file against a stale base is refused",
    { path: target, content: reading.content, reason: "probe: stale base", base_rev: "0".repeat(64) },
    "refused",
  );
  // An existing file with the real base: accepted.
  await attempt(
    "replacing it against the revision it is serving is accepted",
    { path: target, content: reading.content, reason: "probe: right base", base_rev: reading.sha256 },
    "ok",
  );
  // A new file with a base: refused, because there is nothing to base it on.
  await attempt(
    "a new file may not carry a base_rev",
    {
      path: "app/probe-not-a-real-page/page.tsx",
      content: "export default function Page() { return null; }\n",
      reason: "probe: base on a new file",
      base_rev: reading.sha256,
    },
    "refused",
  );
  // A new file without one: accepted.
  await attempt(
    "a new file is created without a base",
    {
      path: "app/probe-not-a-real-page/page.tsx",
      content: "export default function Page() { return null; }\n",
      reason: "probe: new file",
    },
    "ok",
  );

  // Cleanup, and say how much. Proposing writes exactly one row and appends no
  // event, so deleting those rows restores the table rather than approximating it.
  if (created.length) {
    const { error } = await sb.from("agent_changes").delete().in("id", created);
    say(!error, `probe rows removed`, `${created.length} deleted${error ? ` (${error.message})` : ""}`);
  }

  summary();
}

function summary() {
  console.log(
    failed === 0
      ? `\nsource door: all checks passed${skipped ? ` (${skipped} skipped)` : ""}`
      : `\nsource door: ${failed} check(s) failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("source door crashed:", e);
  process.exit(1);
});
