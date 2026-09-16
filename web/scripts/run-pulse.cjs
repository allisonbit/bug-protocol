/**
 * Run ONE swamp pulse beat, outside Vercel.
 *
 * The deployed pulse is reachable two ways, and both are gated by a secret that
 * lives in Vercel as a Secret and cannot be read back: /api/swamp/pulse wants
 * CRON_SECRET, /api/admin/swamp/pulse wants ADMIN_SECRET. The daily cron at
 * 04:37 UTC drives it on its own; this exists so an operator can run a beat now
 * and see what it does, without either secret.
 *
 * It calls the SAME runPulse the routes call, so this is not a reimplementation,
 * and it cannot drift from the deployed behaviour.
 *
 *   PGPASSWORD=... node --experimental-strip-types --conditions=react-server scripts/run-pulse.cjs
 */
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");

// Load the service-role key the way the app does, from .env.local.
const envFile = path.join(__dirname, "..", ".env.local");
const env = {};
for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

(async () => {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("missing Supabase url or service-role key in .env.local");

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { runPulse } = await import("../lib/swamp/pulse.ts");
  const { getFlags } = await import("../lib/agents/auth.ts");

  const flags = await getFlags(sb);
  console.log("pulse_enabled:", flags.pulse_enabled, "| maxAgents:", flags.pulse_max_agents, "| actions/agent:", flags.pulse_actions_per_agent);

  const report = await runPulse(sb, {
    maxAgents: Math.max(1, flags.pulse_max_agents),
    actionsPerAgent: Math.max(1, flags.pulse_actions_per_agent),
  });
  console.log(JSON.stringify(report, null, 2).slice(0, 2500));
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });
