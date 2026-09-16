/**
 * Verify the shared swarm memory does what it claims.
 *
 * The important ones are not "did the tables get created". They are the rules
 * the layer rests on: that an agent cannot raise its own skill, that one agent
 * counts once toward a fact's confidence, that confidence is arithmetic over
 * real rows rather than a number anybody declared, and that a superseded fact is
 * kept rather than replaced.
 *
 *   PGPASSWORD=... node scripts/verify-memory.cjs
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

  console.log("\n=== the five layers exist ===");
  for (const t of ["memory_facts", "memory_hypotheses", "memory_skills", "memory_meta", "memory_verifications", "memory_skill_endorsements"]) {
    const q = await c.query(`select count(*)::int n from ${t}`);
    pass(`${t} (${q.rows[0].n} rows)`);
  }

  const views = await c.query(
    "select table_name from information_schema.views where table_schema='public' and table_name in ('memory_facts_scored','memory_skills_ranked')",
  );
  views.rows.length === 2 ? pass("both computed views exist") : fail("computed views missing");

  // Two real agents are needed: every rule below is about the relationship
  // between agents, so one agent cannot test any of them.
  const a = await c.query("select id, handle from agents order by handle limit 2");
  if (a.rows.length < 2) {
    console.log("  SKIP  need two agents to test the rules");
    await c.end();
    return;
  }
  const [one, two] = a.rows;
  console.log(`         using @${one.handle} and @${two.handle}`);

  console.log("\n=== a skill cannot be raised by the agent that holds it ===");
  try {
    await c.query(
      "insert into memory_skill_endorsements (agent_id, skill, endorser_id) values ($1,'ssrf',$1)",
      [one.id],
    );
    fail("an agent endorsed its own skill, so proficiency can be self inflated");
  } catch {
    pass("self endorsement refused by the database, not by a route");
  }

  await c.query("insert into memory_skills (agent_id, skill, domain, self_assessed) values ($1,'ssrf','security-research',0.95) on conflict do nothing", [one.id]);
  const solo = await c.query("select self_assessed, proficiency, endorsements, corroborated from memory_skills_ranked where agent_id=$1 and skill='ssrf'", [one.id]);
  Number(solo.rows[0].proficiency) === Number(solo.rows[0].self_assessed) && !solo.rows[0].corroborated
    ? pass(`an agent's own number stands uncapped (${solo.rows[0].proficiency}) and is marked uncorroborated`)
    : fail("the agent's own skill number was overridden");

  await c.query("insert into memory_skill_endorsements (agent_id, skill, endorser_id) values ($1,'ssrf',$2) on conflict do nothing", [one.id, two.id]);
  const endorsed = await c.query("select proficiency, endorsements, corroborated from memory_skills_ranked where agent_id=$1 and skill='ssrf'", [one.id]);
  Number(endorsed.rows[0].proficiency) === Number(solo.rows[0].proficiency) && endorsed.rows[0].corroborated
    ? pass(`an endorsement marks it corroborated without changing the agent's number (${endorsed.rows[0].endorsements} vouch)`)
    : fail("an endorsement changed the agent's own number instead of sitting beside it");

  console.log("\n=== one agent counts once toward a confidence ===");
  const f = await c.query(
    `insert into memory_facts (key, value, claimed_confidence, source_agent, domain, evidence)
     values ('verify:probe','{}'::jsonb, 0.50, $1, 'security-research', 'probe') returning id`,
    [one.id],
  );
  const factId = f.rows[0].id;
  await c.query("insert into memory_verifications (fact_id, agent_id, kind) values ($1,$2,'confirm')", [factId, two.id]);
  try {
    await c.query("insert into memory_verifications (fact_id, agent_id, kind) values ($1,$2,'confirm')", [factId, two.id]);
    fail("the same agent confirmed twice, so confidence can be inflated by repetition");
  } catch {
    pass("a second confirmation from the same agent refused");
  }

  const scored = await c.query("select claimed_confidence, confirms, confidence from memory_facts_scored where id=$1", [factId]);
  const s = scored.rows[0];
  Number(s.confidence) > Number(s.claimed_confidence)
    ? pass(`confidence is arithmetic: claimed ${s.claimed_confidence}, ${s.confirms} confirm, now ${s.confidence}`)
    : fail("confidence did not rise with a confirmation");

  console.log("\n=== supersede, never replace ===");
  const f2 = await c.query(
    `insert into memory_facts (key, value, claimed_confidence, source_agent, domain, supersedes)
     values ('verify:probe','{"v":2}'::jsonb, 0.60, $1, 'security-research', $2) returning id`,
    [one.id, factId],
  );
  await c.query("update memory_facts set superseded_by=$1 where id=$2", [f2.rows[0].id, factId]);

  const both = await c.query("select count(*)::int n from memory_facts where key='verify:probe'");
  both.rows[0].n === 2 ? pass("both the old and the new fact are still on the record") : fail("the old fact was lost");

  const heads = await c.query("select count(*)::int n from memory_facts_scored where key='verify:probe' and is_current");
  heads.rows[0].n === 1 ? pass("exactly one is marked current") : fail(`${heads.rows[0].n} rows marked current`);

  // Clean up every probe row. Nothing here is real knowledge and none of it
  // should survive into the swarm's memory.
  await c.query("delete from memory_verifications where fact_id in ($1,$2)", [factId, f2.rows[0].id]);
  await c.query("delete from memory_facts where key='verify:probe'");
  await c.query("delete from memory_skill_endorsements where agent_id=$1 and skill='ssrf'", [one.id]);
  await c.query("delete from memory_skills where agent_id=$1 and skill='ssrf'", [one.id]);
  pass("probe rows removed, including the skills, which the swarm should not inherit");

  console.log("");
  await c.end();
})().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
