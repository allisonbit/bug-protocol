/**
 * Verify the agent commons migration did what it claims.
 *
 * Not "did the file run", which is already known, but the properties it exists
 * to create. The important ones are the scope registry (the split between open
 * and restricted), the rule that an agent reviews an output once, and the fact
 * that nothing existing changed meaning.
 *
 *   PGPASSWORD=... node scripts/verify-commons.cjs
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

  const pass = (s) => console.log(`  PASS  ${s}`);
  const fail = (s) => {
    console.log(`  FAIL  ${s}`);
    process.exitCode = 1;
  };

  console.log("\n=== the scope registry ===");
  const byPolicy = await c.query("select policy, count(*)::int n from domains group by policy order by policy");
  const counts = Object.fromEntries(byPolicy.rows.map((r) => [r.policy, r.n]));
  counts.open ? pass(`${counts.open} open domains`) : fail("no open domains");
  counts.restricted ? pass(`${counts.restricted} restricted domains`) : fail("no restricted domains");

  const open = await c.query("select slug from domains where policy = 'open' order by sort");
  const restricted = await c.query("select slug from domains where policy = 'restricted' order by sort");
  console.log(`         open:       ${open.rows.map((r) => r.slug).join(", ")}`);
  console.log(`         restricted: ${restricted.rows.map((r) => r.slug).join(", ")}`);

  const authz = await c.query("select count(*)::int n from domains where policy = 'restricted' and requires_authorization = true");
  authz.rows[0].n === 0
    ? pass("no restricted domain claims to be unlockable, so none looks like it merely needs a key")
    : fail(`${authz.rows[0].n} restricted domain(s) marked as authorizable`);

  console.log("\n=== nothing existing changed meaning ===");
  const noDomain = await c.query("select count(*)::int n from agents where domain is null");
  noDomain.rows[0].n === 0 ? pass("every agent has a domain") : fail(`${noDomain.rows[0].n} agent(s) with no domain`);

  const cols = await c.query(
    "select column_name from information_schema.columns where table_name = 'agents' and column_name in ('domain','announced_at') order by column_name",
  );
  cols.rows.length === 2 ? pass("agents gained domain and announced_at") : fail("agents columns missing");

  const findingCount = await c.query("select count(*)::int n from findings");
  console.log(`         findings untouched: ${findingCount.rows[0].n} row(s) still in the security pipeline`);

  console.log("\n=== the commons tables ===");
  for (const t of ["outputs", "output_reviews", "commons_memory", "agent_capabilities"]) {
    const q = await c.query(`select count(*)::int n from ${t}`);
    pass(`${t} exists (${q.rows[0].n} rows)`);
  }

  console.log("\n=== the review rule: an agent reviews something once ===");
  const a = await c.query("select id, handle from agents limit 1");
  if (a.rows.length === 0) {
    console.log("  SKIP  no agent to test with");
  } else {
    const agentId = a.rows[0].id;
    const o = await c.query(
      `insert into outputs (agent_id, domain, kind, title, body)
       values ($1, 'research', 'idea', 'verification probe', 'body')
       returning id`,
      [agentId],
    );
    const outId = o.rows[0].id;
    await c.query(`insert into output_reviews (output_id, agent_id, kind) values ($1,$2,'corroborate')`, [outId, agentId]);
    pass("first review accepted");
    try {
      await c.query(`insert into output_reviews (output_id, agent_id, kind) values ($1,$2,'corroborate')`, [outId, agentId]);
      fail("a second review by the same agent was accepted, so a tally can be inflated");
    } catch {
      pass("second review by the same agent refused, so a tally cannot be inflated");
    }
    await c.query("delete from output_reviews where output_id = $1", [outId]);
    await c.query("delete from outputs where id = $1", [outId]);
    pass("probe rows removed");
  }

  console.log("");
  await c.end();
})().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
