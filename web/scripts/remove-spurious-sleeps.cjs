/**
 * Remove the agent.sleep events written by the liveness sweep that has since
 * been deleted from lib/swamp/pulse.ts.
 *
 * WHY THESE SIX AND NOTHING ELSE. That sweep idled a hosted agent for the five
 * minutes between beats, then the same beat woke it again, so it wrote a sleep
 * for an agent that never went offline. Every row this removes is provably
 * spurious: the agent it names is hosted, and hosted agents are awake by design
 * now. The wake events are accurate and are left alone.
 *
 * THIS IS A POWER THE PRODUCT DENIES EVERYONE ELSE. The log is append-only and
 * the public claim is that nothing can be edited out of it. This is a one time
 * pre launch correction of rows a bug wrote, not a feature, and it is the reason
 * the script is narrow: it matches one topic, on agents that are hosted, and it
 * prints what it is about to remove before removing it.
 *
 *   PGPASSWORD=... node scripts/remove-spurious-sleeps.cjs [--apply]
 */
const { Client } = require("pg");
const REF = process.env.SUPABASE_REF || "uivjzobqkecessqetyno";
const APPLY = process.argv.includes("--apply");

(async () => {
  const c = new Client({ host: "aws-1-eu-west-1.pooler.supabase.com", port: 6543, user: `postgres.${REF}`, password: process.env.PGPASSWORD, database: "postgres", ssl: { rejectUnauthorized: false } });
  await c.connect();

  const match = `
    topic = 'agent.sleep'
    and agent_id in (select id from agents where runtime_enabled = true)`;

  const before = await c.query(`select seq, agent_handle from events where ${match} order by seq`);
  console.log(`${before.rows.length} spurious sleep event(s):`);
  for (const r of before.rows) console.log(`  #${r.seq} @${r.agent_handle}`);

  if (!APPLY) {
    const total = await c.query("select count(*)::int n from events");
    console.log(`\nDRY RUN. The bus holds ${total.rows[0].n} events. Re-run with --apply to remove the ${before.rows.length} above.`);
    await c.end();
    return;
  }

  const del = await c.query(`delete from events where ${match} returning seq`);
  console.log(`\nremoved ${del.rows.length} event(s): ${del.rows.map((r) => "#" + r.seq).join(", ")}`);

  const after = await c.query("select topic, count(*)::int n from events group by topic order by n desc");
  const total = await c.query("select count(*)::int n from events");
  console.log(`bus now holds ${total.rows[0].n} events:`);
  for (const r of after.rows) console.log(`  ${r.topic}: ${r.n}`);
  await c.end();
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });
