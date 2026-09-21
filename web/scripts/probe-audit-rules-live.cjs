/**
 * What the audit rules select, from the live rows, without writing anything.
 *
 *   PGPASSWORD=... node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/probe-audit-rules-live.cjs
 *
 * WHY A DRY RUN RATHER THAN A BEAT. The two rules were written to work on rows this
 * deployment already has: a document somebody linked on the board, and a dispute waiting
 * for a second agent. `verify-audit-rules.cjs` proves the judgements against samples it
 * wrote itself, which is exactly the shape of test that passes while the live board is
 * empty. This runs the REAL `observe()` over the REAL rows and the REAL `decideReflex()`
 * over what it returns, and then stops: no pulse, no fetch, no write, no event.
 *
 * It reports the three things that decide whether the swarm can work this surface:
 * whether a resident is awake to run either rule, whether the board holds a document in
 * scope, and whether a challenge is waiting. An empty answer is a fact about the rows
 * rather than a failure, and this prints it as one.
 */
const fs = require("fs");
const path = require("path");

// The service role key the way the app reads it, from .env.local, loaded BEFORE the app's
// modules are imported: `lib/supabase/index.ts` reads process.env at import time, so a
// script that sets these afterwards gets a client with no URL and reports "no backend"
// against a deployment that is entirely configured. This is how run-pulse.cjs does it.
for (const line of fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

(async () => {
  const { supabaseAdmin, SUPABASE_CONFIGURED } = await import("../lib/supabase/index.ts");
  const { observe } = await import("../lib/swamp/observations.ts");
  const { decideReflex } = await import("../lib/swamp/brain.ts");
  const candidates = await import("../lib/audit/candidates.ts");

  if (!SUPABASE_CONFIGURED) {
    console.log("no backend configured on this checkout: nothing to read");
    process.exit(0);
  }
  const sb = supabaseAdmin();
  const { data: agents } = await sb
    .from("agents")
    .select("*")
    .eq("runtime_enabled", true)
    .order("handle")
    .limit(25);
  const residents = agents ?? [];
  console.log(`\nresidents the swamp would wake: ${residents.length}${residents.length ? ` (${residents.map((a) => a.handle).join(", ")})` : ""}`);
  if (residents.length === 0) {
    console.log("  nothing to run the rules for: no hosted resident exists, which is a fact about the roster rather than about the rules");
  }

  const { data: challenges } = await sb
    .from("audit_challenges")
    .select("id, audit_id, challenger, finding_code, status, created_at")
    .in("status", ["open", "under_review"]);
  const { data: audits } = await sb.from("audits").select("subject, engine, verdict").not("subject", "is", null);

  console.log(`\nthe queue: ${(challenges ?? []).length} challenge(s) open or under review, ${(audits ?? []).length} subject(s) already on the record`);
  for (const c of challenges ?? []) console.log(`  ${c.status.padEnd(12)} @${c.challenger} disputes ${c.finding_code} on audit ${c.audit_id.slice(0, 8)}`);

  let audited = 0;
  let settled = 0;
  let inScope = 0;
  for (const agent of residents) {
    const obs = await observe(sb, agent);
    const plan = decideReflex(obs);
    const board = obs.board?.items ?? [];
    const links = board.filter((b) => b.url);
    for (const b of links) {
      const classified = candidates.classifyAuditUrl(b.url);
      if (classified) inScope += 1;
    }
    const hits = plan.filter((p) => p.kind === "audit_document" || p.kind === "settle_audit_challenge");
    for (const hit of hits) {
      if (hit.kind === "audit_document") {
        audited += 1;
        console.log(`\n@${agent.handle} would read a document (rule ${hit.rule}): ${hit.url}\n  kind: ${hit.subject}\n  why:  ${hit.why}`);
      } else {
        settled += 1;
        console.log(`\n@${agent.handle} would settle a challenge (rule ${hit.rule}): audit ${hit.auditId.slice(0, 8)}, finding ${hit.findingCode}`);
      }
    }
    if (hits.length === 0) {
      const reasons = [];
      if (links.length === 0) reasons.push("the board holds no link at all");
      else if (inScope === 0) reasons.push(`the board holds ${links.length} link(s) and none names a SKILL.md or an MCP endpoint`);
      if ((challenges ?? []).length === 0) reasons.push("no challenge is waiting");
      if (reasons.length > 0) console.log(`  @${agent.handle}: nothing to do — ${reasons.join("; ")}`);
    }
  }

  console.log(
    `\nsummary: ${inScope} in-scope link(s) on the board, ${audited} resident(s) would read a document, ${settled} would settle a challenge. Nothing was fetched and nothing was written.`,
  );
  process.exit(0);
})().catch((e) => {
  console.error("probe failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
