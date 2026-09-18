/**
 * Verify the drop-disclosing-status migration did what it claims.
 *
 * Not "did the file run", which supabase/migrate-drop-disclosing-status.sql already
 * reports. This checks the PROPERTIES the migration exists to create: the live check
 * constraint must no longer permit a value the TypeScript union cannot produce, and
 * the column comment must describe the transitions that actually happen.
 *
 * The load bearing assertion is the negative one. A constraint that still lists
 * 'disclosing' would mean the platform allows a status no writer can reach, which is
 * how a guard ends up defending a state that cannot exist. That is exactly the shape
 * `withdrawn` had in three places before the retraction doors were added, and the fix
 * there was to build the writer rather than delete the value. Here the sweep is
 * correct, so the value is the redundant half and is removed.
 *
 *   PGPASSWORD=... node scripts/verify-status-constraint.cjs
 */
const { Client } = require("pg");

const REF = process.env.SUPABASE_REF || "uivjzobqkecessqetyno";

(async () => {
  const client = new Client({
    host: process.env.PGHOST || "aws-1-eu-west-1.pooler.supabase.com",
    port: Number(process.env.PGPORT || 6543),
    user: process.env.PGUSER || `postgres.${REF}`,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE || "postgres",
    ssl: { rejectUnauthorized: false },
    statement_timeout: 60000,
  });

  const pass = (s) => console.log(`  PASS  ${s}`);
  const fail = (s) => {
    console.log(`  FAIL  ${s}`);
    process.exitCode = 1;
  };

  try {
    await client.connect();

    const { rows: constraints } = await client.query(`
      select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
      where conrelid = 'public.findings'::regclass and contype = 'c'
      order by conname`);

    console.log("\n=== the constraint ===");
    for (const c of constraints) console.log(`  ${c.conname}: ${c.def}`);

    const status = constraints.find((c) => c.conname === "findings_status_check");
    console.log("");
    if (!status) {
      fail("findings_status_check is missing, so findings.status is unconstrained");
    } else {
      status.def.includes("disclosing")
        ? fail("the constraint still allows 'disclosing'")
        : pass("the constraint no longer allows 'disclosing'");
      for (const s of ["new", "under_review", "verified", "challenged", "rejected", "disclosed"]) {
        status.def.includes(`'${s}'`) ? pass(`allows '${s}'`) : fail(`does not allow '${s}'`);
      }
    }

    console.log("\n=== the rows, which is why the drop was safe ===");
    const { rows: counts } = await client.query(
      `select status, count(*)::int as n from public.findings group by status order by status`,
    );
    for (const r of counts) console.log(`  ${r.status}: ${r.n}`);
    const disclosing = counts.find((r) => r.status === "disclosing");
    disclosing
      ? fail(`${disclosing.n} row(s) still carry 'disclosing'`)
      : pass("no row carries 'disclosing'");

    console.log("\n=== the comment a reader of the schema gets ===");
    const { rows: cols } = await client.query(`
      select col_description('public.findings'::regclass, ordinal_position) as comment
      from information_schema.columns
      where table_schema='public' and table_name='findings' and column_name='status'`);
    const comment = (cols[0] && cols[0].comment) || "";
    console.log(`  ${comment || "(none)"}\n`);
    if (!comment) fail("findings.status has no comment");
    else if (comment.includes("disclosing")) fail("the comment still describes 'disclosing'");
    else pass("the comment describes the transitions that happen");
  } catch (e) {
    console.error(`FAILED: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();
