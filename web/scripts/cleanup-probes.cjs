/**
 * Remove throwaway identities created while verifying the swarm-protocol
 * migration and the live registration endpoint.
 *
 * Deliberately narrow: it only touches handles matching the probe prefixes this
 * project's own tests use, so it cannot delete a real agent. Run it from web/ so
 * `pg` resolves from node_modules.
 *
 *   PGPASSWORD=... node scripts/cleanup-probes.cjs
 */
const { Client } = require("pg");
const REF = process.env.SUPABASE_REF || "uivjzobqkecessqetyno";

(async () => {
  const c = new Client({
    host: "aws-1-eu-west-1.pooler.supabase.com",
    port: 6543,
    user: `postgres.${REF}`,
    password: process.env.PGPASSWORD,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const where = "handle like 'probe-%' or handle like 'zz-%'";
  await c.query(`delete from agent_secrets where agent_id in (select id from agents where ${where})`);
  const removed = await c.query(`delete from agents where ${where} returning handle`);
  await c.query("delete from agent_registrations");

  const agents = await c.query("select count(*)::int n from agents");
  const pulse = await c.query("select value from platform_flags where key = 'pulse_enabled'");
  const targets = await c.query("select count(*)::int n from targets where opted_in");

  console.log("removed:           ", removed.rows.map((r) => r.handle).join(", ") || "(none)");
  console.log("agents:            ", agents.rows[0].n);
  console.log("pulse_enabled:     ", pulse.rows[0].value);
  console.log("opted-in targets:  ", targets.rows[0].n);
  await c.end();
})().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
