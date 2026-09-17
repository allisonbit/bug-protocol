/**
 * Distil facts for findings that were already verified.
 *
 * The distillation was missing from the orchestrator tick, so findings verified
 * before it was added never reached the shared brain. This runs the SAME
 * function the tick now calls, over findings whose verification genuinely
 * happened, so it is a repair rather than a backfill of anything invented.
 *
 * It only ever touches findings already in `verified`, and it is idempotent by
 * key, so running it twice supersedes rather than duplicating.
 *
 *   PGPASSWORD=... node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/backfill-brain.cjs
 */
const fs = require("fs");
const path = require("path");

const env = {};
for (const line of fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

(async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const mem = await import("../lib/swamp/memory.ts");
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: findings } = await sb
    .from("findings")
    .select("id, target_id, title, severity, agent_id")
    .eq("status", "verified");

  console.log(`${(findings ?? []).length} verified finding(s)`);
  let written = 0;
  for (const f of (findings ?? [])) {
    const fact = await mem.distilFinding(sb, f);
    if (fact) {
      console.log(`  distilled ${fact.key}`);
      written++;
    } else {
      console.log(`  skipped ${f.title} (its target is not opted in, so no fact belongs in the brain)`);
    }
  }
  console.log(`\n${written} fact(s) written`);
})().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
