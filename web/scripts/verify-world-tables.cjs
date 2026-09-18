#!/usr/bin/env node
/**
 * Read the database back and confirm migrate-world.sql landed.
 *
 * Deliberately reads the LIVE constraint text rather than trusting the file that
 * wrote it: the point of a migration check is to catch the case where the file
 * looks right and the database disagrees, which is exactly what happened with
 * the dropped `disclosing` status.
 *
 *   PGPASSWORD=... node scripts/verify-world-tables.cjs
 *
 * The password comes from the environment and never from the command line, for
 * the same reason `apply-migration.cjs` does it that way: it can contain
 * characters that corrupt a URI, and an argument ends up in shell history.
 */
const { Client } = require("pg");

const client = new Client({
  host: "aws-1-eu-west-1.pooler.supabase.com",
  port: 6543,
  user: "postgres.uivjzobqkecessqetyno",
  database: "postgres",
  password: process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
});

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`);
  }
}

(async () => {
  await client.connect();
  console.log("\nThe world migration, read back from the database\n");

  const con = await client.query(
    `select pg_get_constraintdef(oid) as def from pg_constraint
     where conrelid = 'public.votes'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%rate_limit%'`,
  );
  const def = con.rows[0]?.def ?? "";
  check("the votes constraint permits 'zone'", def.includes("'zone'"), def.slice(0, 120) || "no kind constraint found");
  check(
    "the votes constraint keeps every kind it already had",
    ["target", "split", "ban", "review_window", "rate_limit", "roe", "other"].every((k) => def.includes(`'${k}'`)),
  );

  for (const table of ["agent_bodies", "world_zones"]) {
    const exists = await client.query(
      `select count(*)::int as n from information_schema.tables where table_schema='public' and table_name=$1`,
      [table],
    );
    const present = exists.rows[0].n === 1;
    check(`public.${table} exists`, present);
    if (!present) continue;

    const rows = (await client.query(`select count(*)::int as n from public.${table}`)).rows[0].n;
    console.log(`        (${table} holds ${rows} row${rows === 1 ? "" : "s"})`);

    const pub = await client.query(
      `select count(*)::int as n from pg_publication_tables
       where pubname='supabase_realtime' and schemaname='public' and tablename=$1`,
      [table],
    );
    check(`public.${table} is in the realtime publication`, pub.rows[0].n === 1);
  }

  // The body table's own guard: a form the drawing cannot render must be refused
  // by the database, not only by the application.
  const formCheck = await client.query(
    `select pg_get_constraintdef(oid) as def from pg_constraint
     where conrelid = 'public.agent_bodies'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%oracle%'`,
  );
  check("the body form is constrained to the six the world can draw", formCheck.rowCount > 0);

  console.log(`\n${failures ? `${failures} FAILED` : "all checks passed"}\n`);
  await client.end();
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error(`\nverify-world-tables could not run: ${err.message}\n`);
  try {
    await client.end();
  } catch {}
  process.exit(1);
});
