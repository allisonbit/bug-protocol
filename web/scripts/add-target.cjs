/**
 * Create a target, and optionally authorize it.
 *
 * READ THIS BEFORE RUNNING IT. Setting `opted_in = true` is the act that
 * authorizes the runtime to make real HTTP requests to those hosts on behalf of
 * agents. It is the one switch in this system that points at somebody else's
 * server, which is why the schema makes it service-role-only and why this script
 * refuses to do it without the explicit `--opt-in` flag.
 *
 * Only ever opt in a host you own or have written permission to test. The
 * platform cannot check that for you, and the scope fence it enforces is only
 * as meaningful as the authorization behind it.
 *
 *   PGPASSWORD=... node scripts/add-target.cjs <slug> "<Name>" <domain[,domain...]> [--opt-in] [--contact you@example.com]
 *
 * Safe by default: without --opt-in it creates the target un-opted-in, which
 * means agents can see it exists and cannot touch it.
 */
const { Client } = require("pg");

const REF = process.env.SUPABASE_REF || "uivjzobqkecessqetyno";

(async () => {
  const args = process.argv.slice(2);
  let optIn = false;
  let contact = null;
  const positional = [];
  // Walk the arguments rather than filtering them. Filtering has to know each
  // flag's arity, and getting that wrong silently ate the slug whenever
  // --contact was absent, so the script reported a usage error for a
  // perfectly valid command. One pass cannot make that mistake.
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--opt-in") optIn = true;
    else if (args[i] === "--contact") contact = args[++i] ?? null;
    else positional.push(args[i]);
  }

  const [slug, name, domainArg] = positional;
  if (!slug || !name || !domainArg) {
    console.error('usage: node scripts/add-target.cjs <slug> "<Name>" <domain[,domain...]> [--opt-in] [--contact you@example.com]');
    process.exit(1);
  }

  const domains = domainArg
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (domains.length === 0) {
    console.error("at least one domain is required: an agent needs a host to check.");
    process.exit(1);
  }

  if (optIn) {
    console.log("AUTHORIZING live passive checks against:");
    for (const d of domains) console.log("   ", d);
    console.log("Only proceed for hosts you own or are permitted to test.\n");
  }

  const c = new Client({
    host: "aws-1-eu-west-1.pooler.supabase.com",
    port: 6543,
    user: `postgres.${REF}`,
    password: process.env.PGPASSWORD,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const r = await c.query(
    `insert into targets (slug, name, domains, security_contact, opted_in, status, notes)
     values ($1,$2,$3,$4,$5,'active',$6)
     on conflict (slug) do update
       set name = excluded.name,
           domains = excluded.domains,
           security_contact = coalesce(excluded.security_contact, targets.security_contact),
           opted_in = excluded.opted_in,
           updated_at = now()
     returning id, slug, name, domains, opted_in, status`,
    [slug, name, domains, contact, optIn, optIn ? "Authorized by the operator." : "Not authorized yet: opted_in is false, so no agent may act against it."],
  );
  const t = r.rows[0];
  console.log(`target ${t.slug} | domains ${JSON.stringify(t.domains)} | opted_in=${t.opted_in} | ${t.status}`);
  if (!t.opted_in) {
    console.log("It is visible and inert. Re-run with --opt-in to authorize it.");
  }
  await c.end();
})().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
