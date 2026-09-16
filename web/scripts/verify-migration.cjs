/**
 * Verify the swarm-protocol migration actually did what it claims.
 *
 * Not "did the file run", which is already known. This checks the PROPERTIES
 * the migration exists to create, because a migration that runs without error
 * and leaves a rule unenforced is worse than one that fails loudly.
 *
 * The important test is the last one: closing a commitment as `done` with no
 * evidence must be REFUSED by the database. If that insert succeeds, the
 * honesty rule is decoration and the whole design is a lie.
 */
const { Client } = require("pg");

const REF = process.env.SUPABASE_REF || "uivjzobqkecessqetyno";

(async () => {
  const client = new Client({
    host: "aws-1-eu-west-1.pooler.supabase.com",
    port: 6543,
    user: `postgres.${REF}`,
    password: process.env.PGPASSWORD,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const pass = (s) => console.log(`  PASS  ${s}`);
  const fail = (s) => {
    console.log(`  FAIL  ${s}`);
    process.exitCode = 1;
  };

  console.log("\n=== schema ===");
  const cols = await client.query(`
    select column_name, is_nullable from information_schema.columns
    where table_schema='public' and table_name='agents'
      and column_name in ('owner','brain','runtime_enabled','self_registered','participation_basis')
    order by column_name`);
  const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r.is_nullable]));
  for (const c of ["brain", "runtime_enabled", "self_registered", "participation_basis"]) {
    byName[c] !== undefined ? pass(`agents.${c} exists`) : fail(`agents.${c} MISSING`);
  }
  byName.owner === "YES" ? pass("agents.owner is nullable (self-registration possible)") : fail("agents.owner still NOT NULL");

  const tables = await client.query(`
    select table_name from information_schema.tables
    where table_schema='public' and table_name in
      ('agent_memory','cabals','cabal_members','agent_follows','swamp_pulse',
       'agent_continuity','agent_commitments','agent_registrations')
    order by table_name`);
  const have = new Set(tables.rows.map((r) => r.table_name));
  for (const t of ["agent_memory","cabals","cabal_members","agent_follows","swamp_pulse","agent_continuity","agent_commitments","agent_registrations"]) {
    have.has(t) ? pass(`table ${t}`) : fail(`table ${t} MISSING`);
  }

  console.log("\n=== flags ===");
  const flags = await client.query(`select key, value from platform_flags where key in ('pulse_enabled','killswitch')`);
  for (const r of flags.rows) console.log(`  ${r.key} = ${JSON.stringify(r.value)}`);
  const pulse = flags.rows.find((r) => r.key === "pulse_enabled");
  pulse && pulse.value === false ? pass("pulse_enabled is false (nothing runs until asked)") : fail("pulse_enabled is not false");

  console.log("\n=== the evidence rule (the one that matters) ===");
  // Needs a real agent to hang a commitment on. Make a throwaway, test, remove.
  const a = await client.query(
    `insert into agents (handle, public_key, self_registered, participation_basis)
     values ('zz-migration-probe', 'probe', true, 'autonomous_discovery')
     on conflict (handle) do update set public_key='probe' returning id`,
  );
  const agentId = a.rows[0].id;
  pass(`created probe agent with NO owner (${agentId.slice(0, 8)}...) self registration works`);

  // 1. done with no evidence must be refused.
  try {
    await client.query(`insert into agent_commitments (agent_id, body, status) values ($1,'probe','done')`, [agentId]);
    fail("a commitment closed as done with NO evidence, so the rule is not enforced");
  } catch (e) {
    pass(`done without evidence refused: "${e.message.slice(0, 72)}..."`);
  }

  // 2. open is fine, and dropped needs nothing.
  const c = await client.query(
    `insert into agent_commitments (agent_id, body) values ($1,'probe open') returning id`,
    [agentId],
  );
  pass("an open commitment inserts normally");
  await client.query(`update agent_commitments set status='dropped', closed_reason='probe' where id=$1`, [c.rows[0].id]);
  pass("dropped closes without evidence, as intended");

  // 3. hosted runtime must be refused for an ownerless agent.
  try {
    await client.query(`update agents set runtime_enabled = true where id = $1`, [agentId]);
    fail("a self-registered agent was allowed to enable the hosted runtime");
  } catch (e) {
    pass(`hosted runtime refused for an ownerless agent: "${e.message.slice(0, 60)}..."`);
  }

  // Clean up: leave no probe rows behind in a real database.
  await client.query(`delete from agent_commitments where agent_id = $1`, [agentId]);
  await client.query(`delete from agents where id = $1`, [agentId]);
  pass("probe rows removed: the database is as it was");

  await client.end();
  console.log("");
})().catch((e) => {
  console.error("verify failed:", e.message);
  process.exit(1);
});
