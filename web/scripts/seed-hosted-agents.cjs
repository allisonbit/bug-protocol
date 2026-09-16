/**
 * Register Swamp-hosted reflex agents, mirroring POST /api/admin/swamp/seed-agents.
 *
 * WHY THIS EXISTS ALONGSIDE THE ROUTE. The route is the sanctioned path and
 * stays it. It is gated by ADMIN_SECRET, which lives in Vercel as a Secret and
 * cannot be read back, so this exists for an operator who has database access
 * but not the secret.
 *
 * It mirrors the route deliberately and is not a second source of truth: same
 * placeholder key, same manifest, same policy descriptor, same idle status, and
 * no agent_secrets row (a hosted agent has no token: only the platform can act
 * as it). The policy hash is read FROM the policy module, never retyped, because
 * a hand-copied hash that drifts from the evaluated rules is precisely the lie
 * policy.ts exists to prevent.
 *
 *   PGPASSWORD=... node scripts/seed-hosted-agents.cjs <owner-email|uuid> [count]
 */
const { Client } = require("pg");

const REF = process.env.SUPABASE_REF || "uivjzobqkecessqetyno";
const NO_KEY = "runtime:no-key";
const MANIFEST_KIND = "swamp-hosted-reflex";
const COUNT_MAX = 12;

// Read from the module itself. The header says why.
async function reflexPolicy() {
  const mod = await import("../lib/swamp/policy.ts");
  return mod.policyFor("reflex");
}

(async () => {
  const ownerArg = process.argv[2];
  const count = Math.min(Math.max(parseInt(process.argv[3] || "6", 10) || 6, 1), COUNT_MAX);
  if (!ownerArg) {
    console.error("usage: node scripts/seed-hosted-agents.cjs <owner-email|uuid> [count]");
    process.exit(1);
  }

  const policy = await reflexPolicy();
  console.log("policy:", policy.name, policy.hash.slice(0, 16) + "...");

  const c = new Client({
    host: "aws-1-eu-west-1.pooler.supabase.com",
    port: 6543,
    user: `postgres.${REF}`,
    password: process.env.PGPASSWORD,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  // Owner: accept an email or a uuid, exactly as the route does.
  const ownerQ = ownerArg.includes("@")
    ? await c.query("select p.id, u.email from profiles p join auth.users u on u.id = p.id where u.email = $1", [ownerArg])
    : await c.query("select p.id, u.email from profiles p left join auth.users u on u.id = p.id where p.id = $1", [ownerArg]);
  if (ownerQ.rows.length === 0) {
    console.error(`no profile for ${ownerArg}`);
    process.exit(1);
  }
  const owner = ownerQ.rows[0];
  console.log("owner:", owner.email, owner.id.slice(0, 8));

  const created = [];
  const skipped = [];
  for (let i = 1; i <= count; i++) {
    const handle = `reflex-${String(i).padStart(2, "0")}`;
    const manifest = {
      kind: MANIFEST_KIND,
      capabilities: ["recon", "web", "tls", "dns"],
      hosted_by: "swamp",
      note:
        "Swamp-hosted agent. Real pulse beats, real passive checks, events labelled provenance=runtime. " +
        "Not an independent researcher; it has no owner-held key and no API token.",
    };
    try {
      const r = await c.query(
        `insert into agents (owner, handle, display_name, public_key, capability_manifest,
                             prompt_hash, model_hash, model_name, brain, runtime_enabled, status)
         values ($1,$2,$3,$4,$5,$6,null,$7,'reflex',true,'idle')
         returning id, handle`,
        [owner.id, handle, `${handle} (Swamp-hosted)`, NO_KEY, manifest, policy.hash, policy.name],
      );
      created.push(r.rows[0].handle);
    } catch (e) {
      if (e.code === "23505") { skipped.push(handle); continue; }
      throw e;
    }
  }

  console.log("created:", created.join(", ") || "(none)");
  if (skipped.length) console.log("skipped (handle taken):", skipped.join(", "));
  const n = await c.query("select count(*)::int n from agents where runtime_enabled");
  console.log("hosted agents now:", n.rows[0].n);
  await c.end();
})().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
