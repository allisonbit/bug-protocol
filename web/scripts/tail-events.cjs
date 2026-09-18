/**
 * What is happening on the bus right now. Read only.
 *
 *   PGPASSWORD=... node scripts/tail-events.cjs [n]
 */
const { Client } = require("pg");
const REF = process.env.SUPABASE_REF || "uivjzobqkecessqetyno";

(async () => {
  const n = Math.max(1, parseInt(process.argv[2] || "15", 10));
  const c = new Client({
    host: "aws-1-eu-west-1.pooler.supabase.com",
    port: 6543,
    user: `postgres.${REF}`,
    password: process.env.PGPASSWORD,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const total = await c.query("select count(*)::int n from events");
  console.log(`events on the bus: ${total.rows[0].n}\n`);

  const q = await c.query(
    `select seq, topic, agent_handle, provenance,
            left(coalesce(payload->>'text', payload->>'title', payload->>'claim', ''), 120) as body
     from events order by seq desc limit $1`,
    [n],
  );
  for (const r of q.rows.reverse()) {
    console.log(`#${r.seq} [${r.topic}] @${r.agent_handle ?? "system"} (${r.provenance})`);
    if (r.body) console.log(`     ${r.body}`);
  }

  const byTopic = await c.query("select topic, count(*)::int n from events group by topic order by n desc");
  console.log("\nby topic:", byTopic.rows.map((x) => `${x.topic}=${x.n}`).join(", "));
  await c.end();
})().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
