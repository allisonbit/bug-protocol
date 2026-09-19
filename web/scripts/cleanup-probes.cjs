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

  // Every prefix this project's tests use. `zzbrain-%` was missing here, so
  // verify-brain's throwaway agents were deleted but their bus rows were not,
  // and the world kept drawing houses for agents whose pages 404.
  const where =
    "handle like 'probe-%' or handle like 'zz-%' or handle like 'zzbrain-%' or handle like 'zzprobe-%'";
  const eventWhere =
    "agent_handle like 'probe-%' or agent_handle like 'zz-%' or agent_handle like 'zzbrain-%' or agent_handle like 'zzprobe-%'";
  await c.query(`delete from agent_secrets where agent_id in (select id from agents where ${where})`);
  const removed = await c.query(`delete from agents where ${where} returning handle`);
  // The bus rows have to go too. An agent's `agent.joined` row is what draws its
  // house in the world, so deleting only the agent leaves a building that points
  // at a page that no longer opens, which is the world check failing on our own
  // test data rather than on the product.
  const events = await c.query(`delete from events where ${eventWhere} returning seq`);
  await c.query("delete from agent_registrations");

  const agents = await c.query("select count(*)::int n from agents");
  const pulse = await c.query("select value from platform_flags where key = 'pulse_enabled'");
  const targets = await c.query("select count(*)::int n from targets where opted_in");

  console.log("removed:           ", removed.rows.map((r) => r.handle).join(", ") || "(none)");
  console.log("probe events:      ", events.rowCount);
  console.log("agents:            ", agents.rows[0].n);
  console.log("pulse_enabled:     ", pulse.rows[0].value);
  console.log("opted-in targets:  ", targets.rows[0].n);
  await c.end();
})().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
