#!/usr/bin/env node
/**
 * Watch for the API to come back.
 *
 * On 2026-09-23 the Supabase project behind this deployment lost its HTTPS API
 * while keeping its database. Two paths to the same instance therefore had two
 * different answers, and that is the whole reason this file exists: a watcher
 * that checks "is Supabase up" would have answered yes, and a watcher that
 * checks "does the site look right" would have answered no, and neither would
 * have said which half was missing.
 *
 * So it checks four separate things on every tick and reports them side by side.
 *
 *   1. REST. PostgREST over HTTPS, the path the app itself uses. This is the one
 *      that was dead: Cloudflare 522 to every request, for hours.
 *   2. DB. The Postgres pooler on port 6543, which stayed alive the whole time
 *      and is why we know nothing was lost. Used here to prove writes resume by
 *      watching the newest event timestamp advance, not just to prove reads work.
 *   3. Health. The deployment's own /api/health, from outside, so this measures
 *      what a visitor gets rather than what this machine can reach.
 *   4. Rows. /api/world/state on the same deployment, whose `seq` is zero
 *      whenever the bus read failed. That is the difference between the API being
 *      up and the site actually showing data again.
 *
 * It prints one line per tick, announces each transition the moment it happens,
 * and exits when both the API and the site are back. The timeout on every check
 * is deliberate: a watcher that hangs on its own check is the disease it is
 * meant to be watching for.
 *
 * Usage
 *   node scripts/watch-recovery.cjs              # every 60s until recovered
 *   node scripts/watch-recovery.cjs --once       # one pass, for a manual look
 *   WATCH_INTERVAL_MS=15000 node scripts/watch-recovery.cjs
 *
 * The database probe needs PGPASSWORD in the environment (the same variable
 * scripts/apply-migration.cjs uses). With no password it still watches REST and
 * the deployment, and says so instead of pretending the DB column is fine.
 */
const fs = require("node:fs");
const path = require("node:path");

const SITE = (process.env.WATCH_SITE || "https://www.swampai.world").replace(/\/$/, "");
const INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS || 60_000);
const PROBE_TIMEOUT_MS = Number(process.env.WATCH_PROBE_TIMEOUT_MS || 25_000);
const ONCE = process.argv.includes("--once");

/** Read web/.env.local, so the URL and key come from the same place the app gets them. */
function localEnv() {
  const file = path.join(__dirname, "..", ".env.local");
  const out = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  } catch {
    /* no env file: the probes below report what they can */
  }
  return out;
}

const env = localEnv();
const SUPABASE_URL = (env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY || "";
const PROJECT_REF = SUPABASE_URL ? new URL(SUPABASE_URL).hostname.split(".")[0] : "";

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

async function getJson(url, headers) {
  const started = Date.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: "no-store" });
    const ms = Date.now() - started;
    const body = await res.text().catch(() => "");
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      /* an HTML error page is a result too */
    }
    return { ok: res.ok, status: res.status, ms, json, body: body.slice(0, 200) };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - started, json: null, body: e.message };
  }
}

/** Path 1: what the app uses. */
async function probeRest() {
  if (!SUPABASE_URL || !SERVICE_KEY) return { ok: false, status: 0, ms: 0, note: "no env file, cannot probe" };
  return getJson(`${SUPABASE_URL}/rest/v1/events?select=id&limit=1`, {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
  });
}

/** Path 3 and 4: what a visitor gets. */
async function probeSite() {
  const [health, world] = await Promise.all([
    getJson(`${SITE}/api/health`, { accept: "application/json" }),
    getJson(`${SITE}/api/world/state`, { accept: "application/json" }),
  ]);
  const status = health.json && typeof health.json === "object" ? health.json.status : null;
  const database = health.json && typeof health.json === "object" ? health.json.database : null;
  const seq = world.json && typeof world.json === "object" ? world.json.seq : null;
  return { health, world, status, database, seq, rowsShown: typeof seq === "number" && seq > 0 };
}

/** Path 2: the one that never went down, and the proof that writes are landing again. */
async function probeDb() {
  if (!process.env.PGPASSWORD) return { ok: false, note: "PGPASSWORD not set, skipping the direct database probe" };
  let Client;
  try {
    ({ Client } = require("pg"));
  } catch {
    return { ok: false, note: "pg is not installed, skipping the direct database probe" };
  }
  const client = new Client({
    host: process.env.PGHOST || "aws-1-eu-west-1.pooler.supabase.com",
    port: Number(process.env.PGPORT || 6543),
    user: process.env.PGUSER || `postgres.${PROJECT_REF}`,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE || "postgres",
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: PROBE_TIMEOUT_MS * 4,
    statement_timeout: PROBE_TIMEOUT_MS * 4,
  });
  const started = Date.now();
  try {
    await client.connect();
    const r = await client.query("select count(*)::int as n, max(created_at) as newest from events");
    return { ok: true, ms: Date.now() - started, count: r.rows[0].n, newest: r.rows[0].newest };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, note: `${e.code || ""} ${e.message}`.trim() };
  } finally {
    await client.end().catch(() => {});
  }
}

const started = Date.now();
let apiWasBack = false;
let siteWasShowingRows = false;
let lastNewest = null;
let announcedFirstTick = false;

async function tick() {
  const [rest, db, site] = await Promise.all([probeRest(), probeDb(), probeSite()]);

  const restLabel = rest.ok ? `REST ok ${rest.status} ${rest.ms}ms` : `REST down (${rest.status || rest.body}) ${rest.ms}ms`;
  const dbLabel = db.ok
    ? `DB ok ${db.ms}ms, ${db.count} events, newest ${db.newest && db.newest.toISOString ? db.newest.toISOString() : db.newest}`
    : `DB ${db.note}`;
  const siteLabel = site.rowsShown
    ? `site ok, showing ${site.seq} events`
    : `site ${site.status || "unreachable"}${site.seq === 0 ? ", showing no rows" : ""}`;

  console.log(`${stamp()}  ${restLabel}  |  ${dbLabel}  |  ${siteLabel}`);

  if (!announcedFirstTick) {
    announcedFirstTick = true;
    console.log(
      `           watching ${SUPABASE_URL || "(no supabase url)"} and ${SITE} every ${Math.round(INTERVAL_MS / 1000)}s`,
    );
  }

  /** Reads coming back is one event. */
  if (rest.ok && !apiWasBack) {
    apiWasBack = true;
    console.log(`${stamp()}  ===== SUPABASE HTTPS API IS BACK (${rest.ms}ms on the first successful read) =====`);
    console.log(
      `${stamp()}  the deployed breaker may refuse reads for up to 30s after the outage, so the site can lag this by one tick`,
    );
  }
  if (!rest.ok && apiWasBack) {
    apiWasBack = false;
    console.log(`${stamp()}  ===== THE API WENT AWAY AGAIN (${rest.status || rest.body}) =====`);
  }

  /** Writes landing again is a different event, and only the database can show it. */
  if (db.ok && db.newest) {
    const newest = db.newest.toISOString ? db.newest.toISOString() : String(db.newest);
    if (lastNewest && newest !== lastNewest) {
      console.log(`${stamp()}  ===== WRITES RESUMED: newest event advanced to ${newest} =====`);
    }
    lastNewest = newest;
  }

  /** The site showing rows is the one that answers the question that was asked. */
  if (site.rowsShown && !siteWasShowingRows) {
    siteWasShowingRows = true;
    console.log(`${stamp()}  ===== THE SITE IS SHOWING REAL ROWS AGAIN (${site.seq} events on /api/world/state) =====`);
    console.log(`${stamp()}  healthy in ${Math.round((Date.now() - started) / 1000)}s of watching. Nothing to restore.`);
  }
  if (!site.rowsShown && siteWasShowingRows) {
    siteWasShowingRows = false;
    console.log(`${stamp()}  ===== THE SITE STOPPED SHOWING ROWS =====`);
  }

  return { rest, db, site };
}

(async () => {
  const first = await tick();
  if (ONCE) {
    console.log(
      `\nverdict: api ${first.rest.ok ? "up" : "DOWN"}, database ${first.db.ok ? "up" : "unknown"}, site ${
        first.site.rowsShown ? "showing rows" : "showing none"
      }`,
    );
    process.exit(0);
  }
  if (first.rest.ok && first.site.rowsShown) {
    console.log("\nalready healthy, nothing to wait for.");
    process.exit(0);
  }
  console.log("\nwaiting for recovery. Ctrl+C to stop.\n");

  for (;;) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
    const t = await tick();
    if (t.rest.ok && t.site.rowsShown) {
      console.log("\nrecovered. watches end here.");
      process.exit(0);
    }
  }
})();
