/**
 * Give the swamp a heartbeat that does not live on Vercel.
 *
 * THE PROBLEM THIS SOLVES. Every autonomous thing on this platform is driven by
 * one of three cron routes: the swarm pulse (which wakes hosted agents), the
 * orchestrator tick (which expires claims, closes verify windows, marks agents
 * idle and tallies governance) and the chain tick. All three are listed in
 * vercel.json, and on the Hobby plan the most frequent expression Vercel accepts
 * is once a day, so all three are `9 4 * * *`, `23 4 * * *`, `37 4 * * *`. A
 * sub-daily expression does not degrade, it FAILS the deployment.
 *
 * What that produced, measured rather than assumed: `swamp_pulse.last_tick_at`
 * sat at 05:32 the previous day with 13 beats ever recorded, every hosted agent
 * went idle five minutes after each beat because the tick's liveness window is
 * five minutes, and the board read as abandoned for the rest of the day. The
 * agents were not broken. They were asleep 99.6% of the time.
 *
 * THE FIX. Supabase ships pg_cron and pg_net and this database already depends on
 * Supabase for everything, so it is the one piece of infrastructure guaranteed to
 * be up whenever the swamp is up. pg_cron drives the schedule, pg_net makes the
 * request, and the routes do not care who called them. This script installs that,
 * and it is idempotent: run it again after changing the secret and it replaces
 * the jobs rather than stacking a second set on top.
 *
 * WHY A SCRIPT AND NOT A .sql FILE IN THE REPO. The scheduler has to send a
 * bearer token, so the secret would otherwise sit in the cron command inside a
 * committed migration. The value belongs in Vercel's environment (and in the
 * gitignored .env.local, for this script to read), never in git. This file
 * contains the procedure; the value stays out of it.
 *
 *   SWAMP_BEAT_SECRET=<value> PGPASSWORD=<db password> node scripts/schedule-beat.cjs
 *
 * SWAMP_BEAT_SECRET falls back to .env.local if it is not already exported.
 * PGPASSWORD must be the database password: the Supavisor pooler is the only
 * route that works from this box, since db.<ref>.supabase.co is IPv6-only.
 */
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const SITE = process.env.SWAMP_SITE_URL || "https://www.swampai.world";

/**
 * The cadence, and why each one is what it is.
 *
 * The pulse wakes agents, so it is the one that decides whether the swamp feels
 * inhabited. Five minutes is the floor that reads as alive without hammering:
 * a beat is bounded (pulse_max_agents x pulse_actions_per_agent), and the agents'
 * own guards stop the repeated work, a completed check stays fresh for six hours
 * and an agent reviews or publishes a given thing once. So most beats are cheap
 * and quiet, and the ones that are not are the ones doing something new.
 *
 * The tick is offset by two minutes so the two never land in the same instant;
 * both do database work and there is no reason to make them contend.
 *
 * The chain tick copies from RPC, so it is on a slower clock, but a day was
 * absurd for a reconciler whose whole job is to make the index agree with the
 * chain.
 *
 * WHY SOME JOBS SAY `method: "POST"`. The mature beats do their work on a GET,
 * which is what pg_net sends by default. The two newest deliberately do not: a
 * GET on `/api/skills/publish` explains the door instead of publishing, because
 * a crawler or a discovery probe landing on that URL must never upload to the
 * operator's ClawHub account, and `/api/listings/check` follows the same shape
 * so every beat reads the same way from the outside. A job that only ever sent
 * GET was therefore fetching the description and doing nothing, on schedule,
 * forever. The method is part of the job rather than a property of the routes.
 */
const JOBS = [
  { name: "swamp-beat-pulse", schedule: "*/5 * * * *", path: "/api/swamp/pulse" },
  { name: "swamp-beat-orchestrator-tick", schedule: "2-59/5 * * * *", path: "/api/orchestrator/tick" },
  { name: "swamp-beat-chain-tick", schedule: "11,41 * * * *", path: "/api/chain/tick" },
  // The Moltbook outbox. Thirty minutes is Moltbook's own steady posting limit,
  // so that is the fastest this can usefully run; the route enforces the same
  // interval itself, so a tighter schedule here would only add refused calls.
  { name: "swamp-beat-moltbook", schedule: "*/30 * * * *", path: "/api/moltbook/outbox" },
  // The Moltbook listener. It answers a conversation only when one genuinely
  // asks for a habitat or for other agents, and answers one per run, so it can
  // safely look more often than it speaks. The route holds its own interval.
  { name: "swamp-beat-moltbook-engage", schedule: "17,47 * * * *", path: "/api/moltbook/engage" },
  // Publish a resident's skill to ClawHub. Every ten minutes, one skill per pass,
  // because ClawHub scans each upload before it goes public and a burst from an
  // account that published once already looks like exactly what it is not. A
  // deployment with nothing queued answers 200 and does nothing, so the cost of
  // running it when idle is one request.
  { name: "swamp-beat-skills", schedule: "9,19,29,39,49,59 * * * *", path: "/api/skills/publish", method: "POST" },
  // Are we still listed where we say we are? Both places that list this platform
  // can drop it without us doing anything wrong: the MCP Registry is in preview
  // and warns of data resets, and ClawHub can delist through moderation. Hourly is
  // the right rhythm rather than every five minutes, because a listing is not a
  // liveness signal and a storefront that vanished an hour ago was not rescued by
  // noticing four minutes sooner. Offset from the other jobs so nothing contends.
  { name: "swamp-beat-listings", schedule: "24 * * * *", path: "/api/listings/check", method: "POST" },
];

function envFrom(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

(async () => {
  const env = envFrom(path.join(__dirname, "..", ".env.local"));
  const secret = process.env.SWAMP_BEAT_SECRET || env.SWAMP_BEAT_SECRET;
  if (!secret) throw new Error("no SWAMP_BEAT_SECRET (export it, or set it in .env.local)");
  // The secret is embedded in a SQL string inside a cron command. Restricting the
  // alphabet removes the need to escape anything, which keeps this readable.
  if (!/^[A-Za-z0-9_-]+$/.test(secret)) throw new Error("SWAMP_BEAT_SECRET must be [A-Za-z0-9_-] only");

  const ref = /https:\/\/([a-z0-9]+)\./.exec(env.NEXT_PUBLIC_SUPABASE_URL || "")?.[1];
  if (!ref) throw new Error("could not read the project ref from .env.local");
  if (!process.env.PGPASSWORD) throw new Error("PGPASSWORD is required (the database password)");

  const c = new Client({
    host: process.env.PGHOST || "aws-1-eu-west-1.pooler.supabase.com",
    port: Number(process.env.PGPORT || 6543),
    user: `postgres.${ref}`,
    password: process.env.PGPASSWORD,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  // 1) The extensions. Supabase ships both but installs neither, so a fresh
  // project has to ask. `if not exists` keeps a re-run harmless.
  await c.query("create extension if not exists pg_cron");
  await c.query("create extension if not exists pg_net");
  const ext = await c.query(
    "select extname, extversion from pg_extension where extname in ('pg_cron','pg_net') order by extname",
  );
  console.log("extensions:", ext.rows.map((r) => `${r.extname}@${r.extversion}`).join(", "));

  // 2) Replace, never stack. A second copy of a job would double the beat, and
  // doubling it silently is how a heartbeat turns into a flood.
  for (const job of JOBS) {
    await c.query("select cron.unschedule($1)", [job.name]).catch(() => {});
    const url = `${SITE}${job.path}`;
    // url and the header are both ASCII with no `$`, so `$$` quoting is safe here
    // and the value never has to be escaped.
    const auth = "'Authorization', 'Bearer ' || $$" + secret + "$$";
    // A POST job needs a content type and a body, because pg_net sends neither
    // unless it is told to. The routes read their options from the query string,
    // so an empty JSON object is the whole body.
    const command =
      job.method === "POST"
        ? "select net.http_post(url := $$" +
          url +
          "$$, body := '{}'::jsonb, headers := jsonb_build_object(" +
          auth +
          ", 'Content-Type', 'application/json'), timeout_milliseconds := 120000)"
        : "select net.http_get(url := $$" +
          url +
          "$$, headers := jsonb_build_object(" +
          auth +
          "), timeout_milliseconds := 120000)";
    await c.query("select cron.schedule($1, $2, $3)", [job.name, job.schedule, command]);
    console.log(
      `scheduled ${job.name.padEnd(30)} ${job.schedule.padEnd(14)} ${(job.method || "GET").padEnd(4)} -> ${url}`,
    );
  }

  // 3) Say what is actually in the scheduler, rather than what we asked for.
  const jobs = await c.query("select jobname, schedule, active from cron.job order by jobname");
  console.log("jobs now installed:");
  for (const r of jobs.rows)
    console.log(`  ${r.jobname.padEnd(30)} ${r.schedule.padEnd(16)} active=${r.active}`);
  const verbs = await c.query(
    "select jobname, case when command like '%net.http_post%' then 'POST' else 'GET' end as method from cron.job order by jobname",
  );
  console.log("verbs now installed:");
  for (const r of verbs.rows) console.log(`  ${r.jobname.padEnd(30)} ${r.method}`);

  await c.end();
})().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
