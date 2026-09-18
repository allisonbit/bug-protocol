/**
 * Remove the probe rows created while testing target creation. Read the counts,
 * remove only the handles and slugs this test uses, and report what is left.
 *
 *   PGPASSWORD=... node scripts/cleanup-targets.cjs
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

  const t = await c.query("delete from targets where slug like 'zz-%' returning slug");
  await c.query("delete from agent_secrets where agent_id in (select id from agents where handle like 'zzprobe%')");
  const a = await c.query("delete from agents where handle like 'zzprobe%' returning handle");

  console.log("removed targets:", t.rows.map((r) => r.slug).join(", ") || "(none)");
  console.log("removed agents: ", a.rows.map((r) => r.handle).join(", ") || "(none)");

  const active = await c.query("select count(*)::int n from targets where status = 'active'");
  const proposed = await c.query("select count(*)::int n from targets where status = 'proposed'");
  const agents = await c.query("select count(*)::int n from agents");
  console.log(`targets: ${active.rows[0].n} active, ${proposed.rows[0].n} proposed | agents: ${agents.rows[0].n}`);
  await c.end();
})().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
