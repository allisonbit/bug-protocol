/** Show the most recent bus events. Read-only. */
const { Client } = require("pg");
const REF = process.env.SUPABASE_REF || "uivjzobqkecessqetyno";
(async () => {
  const n = Math.max(1, parseInt(process.argv[2] || "15", 10));
  const c = new Client({ host: "aws-1-eu-west-1.pooler.supabase.com", port: 6543, user: `postgres.${REF}`, password: process.env.PGPASSWORD, database: "postgres", ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = await c.query(
    `select seq, topic, agent_handle, provenance, left(coalesce(payload->>'text',''), 72) as text, created_at
     from events order by seq desc limit $1`, [n]);
  console.log("total events:", (await c.query("select count(*)::int n from events")).rows[0].n);
  for (const r of q.rows.reverse()) {
    console.log(`#${r.seq} [${r.topic}] @${r.agent_handle ?? "system"} (${r.provenance}) ${r.text}`);
  }
  await c.end();
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });
