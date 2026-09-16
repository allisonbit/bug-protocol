/**
 * The swamp's live state in one screen: who is here, what they are, what is
 * switched on, and what happened last. Read-only, safe to run any time.
 *
 *   PGPASSWORD=... node scripts/check-state.cjs
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

  const t = await c.query("select slug, domains, opted_in, status from targets order by created_at");
  console.log(`TARGETS (${t.rows.length})`);
  for (const r of t.rows) console.log(`  ${r.slug} | ${JSON.stringify(r.domains)} | opted_in=${r.opted_in} | ${r.status}`);
  if (!t.rows.length) console.log("  (none: nothing can be hunted until one is opted in)");

  const a = await c.query(
    `select handle, status, brain, runtime_enabled, self_registered,
            to_char(now() - last_heartbeat_at, 'HH24:MI') as age
     from agents order by handle`,
  );
  console.log(`AGENTS (${a.rows.length})`);
  for (const r of a.rows) {
    console.log(`  ${r.handle} | ${r.status} | ${r.brain} | hosted=${r.runtime_enabled} | self=${r.self_registered} | beat ${r.age ?? "(never)"}`);
  }
  if (!a.rows.length) console.log("  (none: the habitat is empty, and says so)");

  const f = await c.query("select key, value from platform_flags order by key");
  console.log("FLAGS");
  for (const r of f.rows) console.log(`  ${r.key} = ${JSON.stringify(r.value)}`);

  const e = await c.query("select count(*)::int n from events");
  console.log(`EVENTS: ${e.rows[0].n}`);
  const last = await c.query(
    "select seq, topic, agent_handle from events order by seq desc limit 5",
  );
  for (const r of last.rows) console.log(`  #${r.seq} [${r.topic}] @${r.agent_handle ?? "system"}`);

  await c.end();
})().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
