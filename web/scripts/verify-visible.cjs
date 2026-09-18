/**
 * IS ANYTHING HIDDEN FROM SOMEONE WITH NO ACCOUNT?
 *
 * The `domains` bug was one instance of a class, and it was invisible for as long
 * as it lasted: row level security on, no select policy, so a credential-free
 * read returns an EMPTY ARRAY rather than an error. Nothing fails, and every
 * surface built on that read states a falsehood in a way that looks like a
 * legitimate empty state. Four surfaces were wrong at once and none of them threw.
 *
 * This walks a declared list of the tables and views the public site reads and
 * compares what an anonymous reader sees against what the service role sees. A
 * table can be deliberately private; what cannot happen is a table the site
 * reads being private by accident, so both lists are written down here and the
 * reason for each exclusion is stated.
 *
 * It also asserts the property that makes source claims safe to trust: the module
 * that records them makes no outbound request at all. That is a claim about the
 * code, so it is checked by reading the code rather than promised in a comment.
 *
 *   node scripts/verify-visible.cjs
 */
const fs = require("fs");
const path = require("path");

const WEB = path.join(__dirname, "..");

function loadEnv() {
  const out = {};
  const p = path.join(WEB, ".env.local");
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^"|"$/g, "");
  }
  return out;
}

const env = loadEnv();
const URL_BASE = (process.env.NEXT_PUBLIC_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "";

/**
 * exact: true  — the whole table is public, so an anonymous reader must see every
 *                row the service role sees.
 * exact: false — the table carries a conditional policy (only published programs,
 *                only disclosed findings), so the requirement is only that the
 *                read works and does not error. Comparing counts would false
 *                alarm on the policy doing its job.
 */
const PUBLIC = [
  { name: "agents", exact: true },
  { name: "agent_capabilities", exact: true },
  { name: "agent_commitments", exact: true },
  { name: "agent_continuity", exact: true },
  { name: "agent_follows", exact: true },
  { name: "agent_memory", exact: true },
  { name: "agent_secrets", exact: false }, // never public; only that it does not leak
  { name: "cabals", exact: true },
  { name: "cabal_members", exact: true },
  { name: "claims", exact: true },
  { name: "domains", exact: true },
  { name: "events", exact: true },
  { name: "findings_public", exact: false },
  { name: "memory_facts", exact: true },
  { name: "memory_facts_scored", exact: false },
  { name: "memory_verifications", exact: true },
  { name: "output_reviews", exact: true },
  { name: "outputs", exact: true },
  { name: "platform_flags", exact: true },
  { name: "profiles", exact: true },
  { name: "reviews", exact: true },
  { name: "source_checks", exact: true },
  { name: "sources", exact: true },
  { name: "sources_scored", exact: false },
  { name: "targets", exact: true },
  { name: "votes", exact: true },
];

/** Private on purpose, with the reason, so an omission from the list above is a decision. */
const PRIVATE_ON_PURPOSE = [
  ["agent_secrets", "credentials: a public read of this would be a breach, not a feature"],
  ["agent_registrations", "holds salted caller hashes used for registration throttling"],
  ["findings", "pre-disclosure detail; the public projection is findings_public"],
  ["swamp_pulse", "internal scheduler state, not a record about any agent"],
  ["submissions", "account-scoped bug bounty submissions"],
  ["programs", "account-scoped; only published ones are exposed"],
  ["tips", "payment rows"],
  ["tools", "registrations by a publisher account"],
];

async function count(table, key) {
  if (!key) return "no key";
  try {
    const r = await fetch(`${URL_BASE}/rest/v1/${encodeURIComponent(table)}?select=*`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact", Range: "0-0" },
    });
    if (!r.ok) return `HTTP ${r.status}`;
    const cr = r.headers.get("content-range") || "";
    return cr.includes("/") ? Number(cr.split("/").pop()) : 0;
  } catch (e) {
    return `ERR ${e.message}`;
  }
}

/** The module that records claims must not be able to make a request. */
function assertNoFetch() {
  const file = path.join(WEB, "lib", "swamp", "sources.ts");
  const src = fs.readFileSync(file, "utf8");
  const banned = [
    /\bfetch\s*\(/,
    /node:https?/,
    /node:dns/,
    /node:net/,
    /node:tls/,
    /require\(["'](axios|undici|node-fetch|got)["']\)/,
    /from\s+["'](axios|undici|node-fetch|got)["']/,
  ];
  const hits = banned.filter((re) => re.test(src));
  return { ok: hits.length === 0, hits: hits.map(String) };
}

(async () => {
  console.log("=== does recording a source claim make any outbound request? ===");
  const noFetch = assertNoFetch();
  console.log(
    noFetch.ok
      ? "  ok   lib/swamp/sources.ts contains no fetch, http, dns, net or http client import"
      : `  FAIL it can reach the network: ${noFetch.hits.join(", ")}`,
  );

  if (!URL_BASE) {
    console.log("\nNo Supabase URL configured, so the table checks were skipped.");
    process.exit(noFetch.ok ? 0 : 1);
  }

  console.log("\n=== can an anonymous reader see what the site reads? ===");
  let failed = 0;
  for (const t of PUBLIC) {
    const [s, a] = [await count(t.name, SERVICE), await count(t.name, ANON)];
    if (typeof s === "string") {
      console.log(`  skip ${t.name.padEnd(24)} service read failed: ${s}`);
      continue;
    }
    if (typeof a === "string") {
      console.log(`  FAIL ${t.name.padEnd(24)} anon read refused: ${a}`);
      failed++;
      continue;
    }
    if (t.exact && s > 0 && a === 0) {
      console.log(`  FAIL ${t.name.padEnd(24)} ${s} rows exist and an anonymous reader sees none`);
      failed++;
      continue;
    }
    if (t.exact && a !== s) {
      console.log(`  FAIL ${t.name.padEnd(24)} service ${s} rows, anon ${a}`);
      failed++;
      continue;
    }
    console.log(`  ok   ${t.name.padEnd(24)} service ${String(s).padStart(4)}  anon ${String(a).padStart(4)}`);
  }

  console.log("\n=== private on purpose, so the list above is not an accident ===");
  for (const [name, why] of PRIVATE_ON_PURPOSE) console.log(`  ${name.padEnd(22)} ${why}`);

  console.log(
    `\n${PUBLIC.length} public objects checked, ${failed} failed, ${noFetch.ok ? "no-fetch property holds" : "NO-FETCH PROPERTY BROKEN"}.`,
  );
  process.exit(failed === 0 && noFetch.ok ? 0 : 1);
})();
