#!/usr/bin/env node
/**
 * Pacing: the swarm's own cooldowns, tuned by carried vote.
 *
 * WHAT IT PINS:
 *
 *   1. The bounds. Every key has a floor above zero and a ceiling; below-floor
 *      and above-ceiling values are refused with the reason stated; the default
 *      for every key is the constant the consumer used before any vote spoke.
 *   2. The round trip. What a proposer writes is what the executor reads, and a
 *      foreign payload reads as null (so it resolves as `passed`, not executed).
 *   3. The consumers. supervisionDecision, pickAuditCandidate,
 *      pickChallengeToSettle, pickGapToReport and citeCooldownElapsed all accept
 *      the swarm's value, and the brain actually passes obs.pacing at every call
 *      site. A key nobody voted on still gets the constant.
 *   4. The wiring. The executor branch, the pacing kind in the proposal door,
 *      the table with no agent-write policy, and the shared topic set.
 *
 * PURE. No database, no network, no clock.
 */
const fs = require("fs");

(async () => {
  const PC = await import("../lib/swamp/pacing.ts");
  const A = await import("../lib/audit/candidates.ts");
  const RG = await import("../lib/registry/reflex.ts");
  const MS = await import("../lib/swamp/machine-supervision.ts");

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`ok   ${name}`);
    else {
      failed += 1;
      console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    }
  };

  // ---- 1. The bounds ---------------------------------------------------------
  for (const key of PC.PACING_KEYS) {
    const b = PC.PACING_BOUNDS[key];
    check(`${key} has a floor above zero and a ceiling above it`, b.floorMs > 0 && b.ceilingMs > b.floorMs);
    check(`${key}'s default is inside its own bounds`, b.defaultMs >= b.floorMs && b.defaultMs <= b.ceilingMs);
    const below = PC.pacingFromPayload({ pacing: { key, value_ms: b.floorMs - 1 } });
    check(`${key} below its floor is refused`, below === null && /flood|paces between/.test(PC.pacingRefusal({ pacing: { key, value_ms: b.floorMs - 1 } })));
    const above = PC.pacingFromPayload({ pacing: { key, value_ms: b.ceilingMs + 1 } });
    check(`${key} above its ceiling is refused`, above === null);
    const at = PC.pacingFromPayload({ pacing: { key, value_ms: b.ceilingMs } });
    check(`${key} at its ceiling is accepted`, at?.valueMs === b.ceilingMs);
  }
  check("an unknown key is not ours and reads as null", PC.pacingFromPayload({ pacing: { key: "everything", value_ms: 1000 } }) === null);
  check("a missing pacing object reads as null", PC.pacingFromPayload({}) === null);

  // ---- 2. The values a reader sees -------------------------------------------
  const rows = [
    { key: "audit", value_ms: 5 * 60_000 },
    { key: "nonsense", value_ms: 42 },
    { key: "challenge", value_ms: -1 },
  ];
  const vals = PC.pacingValues(rows);
  check("a voted key carries the voted value", vals.audit === 5 * 60_000);
  check("a key without a vote holds the constant", vals.machine_command === PC.PACING_BOUNDS.machine_command.defaultMs);
  check("an out-of-bounds row in the table cannot poison a reader", vals.challenge === PC.PACING_BOUNDS.challenge.defaultMs);

  // ---- 3. The consumers take the value ----------------------------------------
  // An ACTUATOR: pulse_relay is actuator/robot only in the closed palette, so the
  // actuation path can actually fire here (a sensor would correctly fall back to
  // report_now, which would make the first two checks vacuous).
  const machine = {
    id: "m1", name: "atlas", kind: "actuator", liveness: "live",
    last_report_at: new Date(Date.now() - 3_600_000).toISOString(),
    thresholds: { min: 0, max: 100, expected_interval_secs: 60 },
    latest: { metric: "temperature", value: 150, unit: "c" },
    pending: 0,
  };
  const nowIso = new Date().toISOString();
  // An actuation one hour ago: inside the default 30-min-cooldown's reach but past
  // it, so the default actuates — and a swarm-voted 6-hour cooldown holds the same
  // act back and falls to report_now. That contrast IS the pacing working.
  const lastAct = { name: "pulse_relay", at: new Date(Date.now() - 3_600_000).toISOString(), machine: "atlas" };
  const withDefault = MS.supervisionDecision({ machine, nowIso, last: null, lastActuation: lastAct, pending: 0 });
  const withPaced = MS.supervisionDecision({ machine, nowIso, last: null, lastActuation: lastAct, pending: 0, cooldowns: { actuationMs: 6 * 3_600_000 } });
  check("supervisionDecision actuates with the default cooldowns", withDefault?.actuation === true);
  check("a paced actuation cooldown holds the act back", withPaced !== null && withPaced.actuation === false && withPaced.name === "report_now");
  const lastJust = { name: "report_now", at: new Date(Date.now() - PC.PACING_BOUNDS.machine_command.floorMs + 1000).toISOString(), machine: "atlas" };
  const heldByFloor = MS.supervisionDecision({ machine, nowIso, last: lastJust, lastActuation: null, pending: 0, cooldowns: { commandMs: PC.PACING_BOUNDS.machine_command.floorMs } });
  check("even the floor holds a second command back inside its window", heldByFloor === null);

  check("pickAuditCandidate accepts the swarm's cooldown", A.pickAuditCandidate({ board: [{ seq: 1, url: "https://x/skill.md", title: "s", mine: false }], audited: new Set(), lastAuditAt: new Date(Date.now() - PC.PACING_BOUNDS.audit.floorMs + 1000).toISOString(), now: nowIso, cooldownMs: PC.PACING_BOUNDS.audit.floorMs }) === null);
  check("pickChallengeToSettle accepts the swarm's cooldown", A.pickChallengeToSettle({ open: [{ id: "c1", audit_id: "a1", finding_code: "sec_headers_missing", claim: "x", created_at: nowIso }], handle: "me", lastClaimAt: new Date(Date.now() - PC.PACING_BOUNDS.challenge.floorMs + 1000).toISOString(), now: nowIso, cooldownMs: PC.PACING_BOUNDS.challenge.floorMs }) === null);
  check("pickGapToReport accepts the swarm's cooldown", RG.pickGapToReport({ gaps: [{ topic: "t", skill_count: 10, total_installs: 100, reported_at: null }], lastReportedAt: new Date(Date.now() - PC.PACING_BOUNDS.registry_gap.floorMs + 1000).toISOString(), now: nowIso, cooldownMs: PC.PACING_BOUNDS.registry_gap.floorMs }) === null);
  check("citeCooldownElapsed accepts the swarm's cooldown", RG.citeCooldownElapsed(new Date(Date.now() - PC.PACING_BOUNDS.registry_cite.floorMs + 1000).toISOString(), nowIso, PC.PACING_BOUNDS.registry_cite.floorMs) === false);

  const brain = fs.readFileSync("lib/swamp/brain.ts", "utf8");
  for (const [key, where] of [["audit", "pickAuditCandidate"], ["challenge", "pickChallengeToSettle"], ["registry_gap", "pickGapToReport"], ["registry_cite", "citeCooldownElapsed"]]) {
    check(`the brain passes obs.pacing.${key} into ${where}`, brain.includes(`obs.pacing.${key}`));
  }
  check("the brain passes both machine cooldowns", brain.includes("obs.pacing.machine_command") && brain.includes("obs.pacing.machine_actuation"));

  // ---- 4. The wiring -----------------------------------------------------------
  const tick = fs.readFileSync("app/api/orchestrator/tick/route.ts", "utf8");
  check("the executor enacts pacing beside the practice branch", /else if \(pacingFromPayload\(v\.payload \?\? \{\}\)\)/.test(tick) && /adoptPacing\(sb, v\.payload \?\? \{\}, \{ voteId: v\.id \}\)/.test(tick));
  const actions = fs.readFileSync("lib/agents/actions.ts", "utf8");
  check("pacing is a registered vote kind", actions.includes('"pacing"'));
  const migration = fs.readFileSync("supabase/migrate-self-rule.sql", "utf8");
  check("the pacing table exists with a closed key set", migration.includes("create table if not exists public.pacing") && migration.includes("'machine_actuation'"));
  check("the pacing table has no agent write policy", !/policy .* on public\.pacing\s+for (insert|update)/i.test(migration));
  const store = fs.readFileSync("lib/swamp/pacing-store.ts", "utf8");
  check("the store refuses an out-of-bounds proposal before a ballot exists", store.includes("pacingRefusal"));
  check("one open vote per cooldown key", store.includes("already open"));
  const obs = fs.readFileSync("lib/swamp/observations.ts", "utf8");
  check("observations read the active pacing rows once per beat", obs.includes("listActivePacing(sb)") && obs.includes("pacingValues("));

  console.log(failed === 0 ? "\nall pacing checks pass" : `\n${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
