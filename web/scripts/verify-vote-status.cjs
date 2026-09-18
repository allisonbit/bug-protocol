/**
 * Verify the vote-withdrawn migration did what it claims.
 *
 * Not "did the file run", which the migration itself reports. This checks the
 * PROPERTIES it exists to create, and the load bearing one is a negative: no OPEN
 * proposal may name a subject that is gone or taken back. That is the shape the
 * bug had - a vote that outlived its proposal and would have been tallied into a
 * verdict about nothing - and it is invisible in any single row, because each row
 * is individually well formed.
 *
 * It also checks the thing that makes 'withdrawn' worth having as a status rather
 * than folding it into 'failed': the constraint has to permit it, the four older
 * statuses have to survive, and the column comment has to describe the transitions
 * that actually happen.
 *
 *   PGPASSWORD=... node scripts/verify-vote-status.cjs
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

  let failures = 0;
  let checks = 0;
  const check = (label, ok, detail) => {
    checks++;
    if (ok) console.log(`  PASS  ${label}`);
    else {
      failures++;
      console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`);
    }
  };

  try {
    await client.connect();

    const { rows: constraints } = await client.query(`
      select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
      where conrelid = 'public.votes'::regclass and contype = 'c'
      order by conname`);

    console.log("\n=== the constraint ===");
    for (const c of constraints) console.log(`  ${c.conname}: ${c.def}`);

    const status = constraints.find((c) => c.conname === "votes_status_check");
    console.log("");
    if (!status) {
      check("votes_status_check exists", false, "votes.status is unconstrained");
    } else {
      check("the constraint allows 'withdrawn'", status.def.includes("'withdrawn'"));
      for (const s of ["open", "passed", "failed", "executed"]) {
        check(`the constraint still allows '${s}'`, status.def.includes(`'${s}'`));
      }
    }

    // The pointer, not the slug. Two votes about one place both match the row on a
    // slug join, so a duplicate its row never referenced reads as healthy; what a
    // vote is about is the ground whose `vote_id` names it.
    console.log("\n=== proposals that outlived their subject ===");
    const { rows: strays } = await client.query(`
      select v.id, v.kind, v.title, v.payload -> 'zone' ->> 'slug' as slug
      from public.votes v
      where v.kind = 'zone'
        and v.status = 'open'
        and not exists (
          select 1 from public.world_zones z
          where z.vote_id = v.id and z.status <> 'withdrawn'
        )`);
    check(
      `no open proposal lacks ground pointing back at it (${strays.length} found)`,
      strays.length === 0,
      strays.map((s) => `${s.slug ?? "no subject"} (${s.id.slice(0, 8)})`).join(", "),
    );

    console.log("\n=== a proposal in flight still has a live one ===");
    const { rows: live } = await client.query(`
      select v.id, v.status, v.payload -> 'zone' ->> 'slug' as slug, z.status as ground
      from public.votes v
      left join public.world_zones z on z.id = v.payload -> 'zone' ->> 'slug'
      where v.status = 'open'`);
    for (const r of live) console.log(`  open: ${r.kind ?? ""} ${r.slug ?? "(not about ground)"} ${r.ground ? `-> ground ${r.ground}` : ""}`);
    const zones = live.filter((r) => r.slug);
    check(
      "every open proposal about ground names ground that still exists",
      zones.every((r) => r.ground === "proposed" || r.ground === "built"),
      zones.map((r) => `${r.slug} -> ${r.ground}`).join(", "),
    );

    console.log("\n=== the statuses that are actually stored ===");
    const { rows: counts } = await client.query(`select status, count(*)::int as n from public.votes group by status order by status`);
    for (const r of counts) console.log(`  ${r.status}: ${r.n}`);

    console.log("\n=== the comment a reader of the schema gets ===");
    const { rows: cols } = await client.query(`
      select col_description('public.votes'::regclass, ordinal_position) as comment
      from information_schema.columns
      where table_schema='public' and table_name='votes' and column_name='status'`);
    const comment = (cols[0] && cols[0].comment) || "";
    console.log(`  ${comment || "(none)"}\n`);
    check("votes.status has a comment", Boolean(comment));
    check("the comment says a withdrawal is not a verdict", comment.includes("not a verdict"));

    console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ""}\n`);
  } catch (e) {
    console.error(`verify-vote-status could not run: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();
