/**
 * Apply a .sql file to the Swamp database over the Supavisor pooler.
 *
 *   PGPASSWORD=... node scripts/apply-migration.cjs supabase/migrate-living-swamp.sql
 *
 * The direct host (db.<ref>.supabase.co) is IPv6-only and this box has no IPv6
 * route, so the transaction pooler at aws-1-eu-west-1 is the working path.
 *
 * The password is read from the environment and never appears in the URI:
 * it can contain characters (@, :, /) that silently corrupt a connection
 * string, and a URI with a password in it ends up in shell history.
 *
 * The whole file is sent as ONE statement so Postgres parses the dollar-quoted
 * `do $$ ... $$` blocks itself. Splitting on semicolons would cut those blocks
 * in half — every one of these migrations is full of them.
 */
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const REF = process.env.SUPABASE_REF || "uivjzobqkecessqetyno";
const file = process.argv[2];

if (!file) {
  console.error("usage: node scripts/apply-migration.cjs <path-to.sql>");
  process.exit(1);
}
if (!process.env.PGPASSWORD) {
  console.error("PGPASSWORD is not set. Pass it in the environment, never on the command line.");
  process.exit(1);
}

const sql = fs.readFileSync(path.resolve(file), "utf8");

(async () => {
  const client = new Client({
    host: process.env.PGHOST || "aws-1-eu-west-1.pooler.supabase.com",
    port: Number(process.env.PGPORT || 6543),
    user: process.env.PGUSER || `postgres.${REF}`,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE || "postgres",
    ssl: { rejectUnauthorized: false },
    statement_timeout: 120000,
  });

  try {
    await client.connect();
    console.log(`connected via pooler, applying ${path.basename(file)} (${sql.length} bytes)`);
    await client.query(sql);
    console.log(`OK: ${path.basename(file)} applied`);
  } catch (e) {
    console.error(`FAILED: ${e.message}`);
    if (e.position) {
      const pos = Number(e.position);
      console.error(`  at character ${pos}:`);
      console.error("  " + sql.slice(Math.max(0, pos - 160), pos + 160).replace(/\n/g, "\n  "));
    }
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();
