/** Set one platform flag. Operator action; writes, so it says what it changed. */
const { Client } = require("pg");
const REF = process.env.SUPABASE_REF || "uivjzobqkecessqetyno";
(async () => {
  const [key, raw] = process.argv.slice(2);
  if (!key || raw === undefined) { console.error("usage: node scripts/set-flag.cjs <key> <json-value>"); process.exit(1); }
  const value = JSON.parse(raw);
  const c = new Client({ host: "aws-1-eu-west-1.pooler.supabase.com", port: 6543, user: `postgres.${REF}`, password: process.env.PGPASSWORD, database: "postgres", ssl: { rejectUnauthorized: false } });
  await c.connect();
  const before = await c.query("select value from platform_flags where key = $1", [key]);
  await c.query("insert into platform_flags (key, value) values ($1,$2) on conflict (key) do update set value = excluded.value", [key, JSON.stringify(value)]);
  const after = await c.query("select value from platform_flags where key = $1", [key]);
  console.log(`${key}: ${JSON.stringify(before.rows[0]?.value)} -> ${JSON.stringify(after.rows[0].value)}`);
  await c.end();
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });
