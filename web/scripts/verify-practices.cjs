#!/usr/bin/env node
/**
 * Practices: the second and last step of self-modification, and every bound on it.
 *
 * WHY THIS FILE EXISTS. This is the pipeline that turns the swarm's own conclusions
 * into something its rules may read, which is exactly the surface a careless design
 * would let become a silent prompt rewrite. Every check below pins one of the
 * bounds that keeps that from happening: the vote gate, the executor-only write,
 * the ceiling, the chain to counted evidence, the closed action set.
 *
 * WHAT IT PINS:
 *
 *   1. The draft gate. Only an ADOPTED lesson; statement bounds; the evidence
 *      hash present, so the chain to counted events is never broken.
 *   2. The payload round trip. What the proposer writes is what the executor
 *      reads, byte for byte, and a foreign payload reads as null.
 *   3. The consult. Capped at MAX_PRACTICES, newest first, stable ties; the
 *      killswitch suspends every practice at once.
 *   4. The wiring. The migration's constraints (statement bounds in SQL, status
 *      closed set, one practice per lesson, RLS with no agent-insert policy),
 *      the two topics in the type union and the migration's union call, the
 *      executor branch in the tick route, the MCP tool, and the vote kind.
 *   5. The safety prose. The action set in policy.ts is untouched by practices:
 *      no new intent may exist because a practice row does.
 *
 * PURE. No database, no network, no clock.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-practices.cjs
 */
const fs = require("fs");
const path = require("path");

(async () => {
  const P = await import("../lib/swamp/practices.ts");

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`ok   ${name}`);
    else {
      failed += 1;
      console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`);
    }
  };

  const HASH = "a".repeat(64);
  const src = (over = {}) => ({
    lessonId: "11111111-1111-1111-1111-111111111111",
    lessonStatus: "adopted",
    statement: "Cite a mirrored skill rather than copying its instructions into behaviour.",
    evidenceHash: HASH,
    ...over,
  });

  // ------------------------------------------------------------- draft gate

  check("an adopted lesson passes the draft gate",
    P.checkPracticeDraft(src()).ok === true);

  for (const status of ["proposed", "refuted", "open", ""]) {
    check(`a ${status || "blank"} lesson is refused`,
      P.checkPracticeDraft(src({ lessonStatus: status })).ok === false);
  }

  check("a 15-character statement is refused (floor is 16)",
    P.checkPracticeDraft(src({ statement: "123456789012345" })).ok === false);

  check("a 401-character statement is refused (cap is 400)",
    P.checkPracticeDraft(src({ statement: "x".repeat(401) })).ok === false);

  check("a missing evidence hash is refused, because the chain would break",
    P.checkPracticeDraft(src({ evidenceHash: "" })).ok === false &&
    P.checkPracticeDraft(src({ evidenceHash: "not-a-hash" })).ok === false);

  // ------------------------------------------------------ payload round trip

  const payload = P.practiceVotePayload(src());
  const back = P.practiceFromPayload(payload);
  check("the payload round trips: lesson, statement and hash survive",
    back !== null && back.lessonId === src().lessonId && back.statement === src().statement && back.evidenceHash === HASH);

  check("a payload naming no practice reads as null",
    P.practiceFromPayload({ flag: "vote_pass_pct", value: 90 }) === null &&
    P.practiceFromPayload(null) === null &&
    P.practiceFromPayload({ practice: { lesson_id: 7 } }) === null);

  // ---------------------------------------------------------------- consult

  const mk = (i, at) => ({
    id: `p${i}`,
    statement: `Practice ${i}`,
    lessonId: `l${i}`,
    evidenceHash: HASH,
    voteId: `v${i}`,
    adoptedAt: at,
  });

  const many = Array.from({ length: P.MAX_PRACTICES + 5 }, (_, i) => mk(i, new Date(Date.parse("2026-09-01T00:00:00Z") + i * 60_000).toISOString()));
  const consulted = P.consultablePractices(many);
  check(`the consult is capped at ${P.MAX_PRACTICES}`,
    consulted.length === P.MAX_PRACTICES);

  check("the consult is newest first",
    consulted[0].id === `p${P.MAX_PRACTICES + 4}` && consulted[consulted.length - 1].id === "p5");

  check("consultation refuses under the killswitch",
    P.isConsultable(mk(0, "2026-09-01T00:00:00Z"), { killswitch: true }) === false &&
    P.isConsultable(mk(0, "2026-09-01T00:00:00Z"), { killswitch: false }) === true &&
    P.isConsultable(mk(0, "2026-09-01T00:00:00Z"), { killswitch: false, suspended: true }) === false);

  // ----------------------------------------------------------------- wiring

  const mig = fs.readFileSync(path.join(__dirname, "../supabase/migrate-practices.sql"), "utf8");
  check("the migration bounds the statement in SQL",
    mig.includes("char_length(statement) between 16 and 400"));
  check("the migration closes the status set",
    mig.includes("status in ('active', 'suspended', 'withdrawn')"));
  check("one practice per lesson, by unique index",
    mig.includes("practices_lesson_uniq"));
  check("RLS is on, the public reads, and no agent-insert policy exists",
    mig.includes("alter table public.practices enable row level security") &&
    mig.includes('"practices public read"') &&
    !/for insert to authenticated/.test(mig));
  check("both topics are unioned by procedure",
    mig.includes("select public.add_event_topics(array['practice.adopted', 'practice.withdrawn'])"));

  const types = fs.readFileSync(path.join(__dirname, "../lib/agents/types.ts"), "utf8");
  check("the type union carries both topics",
    types.includes('| "practice.adopted"') && types.includes('| "practice.withdrawn"'));

  const tick = fs.readFileSync(path.join(__dirname, "../app/api/orchestrator/tick/route.ts"), "utf8");
  check("the executor branch runs on a carried practice vote, and only there",
    tick.includes("adoptPractice(sb, v.payload ?? {}, { voteId: v.id })") &&
    tick.includes("practiceFromPayload(v.payload ?? {})"));

  const store = fs.readFileSync(path.join(__dirname, "../lib/swamp/practice-store.ts"), "utf8");
  check("the executor re-checks the lesson is still adopted before writing",
    store.includes("no longer adopted"));

  check("adoption writes the bus event with the whole chain",
    /topic: "practice\.adopted"[\s\S]{0,400}lesson_id: practice\.lessonId[\s\S]{0,200}vote_id: practice\.voteId/.test(store));

  const tools = fs.readFileSync(path.join(__dirname, "../lib/mcp/tools.ts"), "utf8");
  check("the MCP door refuses the proposer's own lesson",
    tools.includes("propose_practice") && store.includes("You cannot put your own lesson forward"));

  const actions = fs.readFileSync(path.join(__dirname, "../lib/agents/actions.ts"), "utf8");
  check("the vote kind is registered in the propose door",
    actions.includes('"zone", "practice"'));

  const observations = fs.readFileSync(path.join(__dirname, "../lib/swamp/observations.ts"), "utf8");
  check("the brain reads practices from the observation, not the database",
    observations.includes("listActivePractices") && observations.includes("practices,"));

  // The action set: a practice must not have added an intent. The set in
  // policy.ts is compared against the intents the synthesis and practice work
  // added — if a "consult_practice" intent ever appears here, that is the
  // silent capability growth this module exists to prevent.
  const policy = fs.readFileSync(path.join(__dirname, "../lib/swamp/policy.ts"), "utf8");
  check("no practice-specific intent exists in the closed action set",
    !policy.includes("consult_practice") && !policy.includes("follow_practice"));

  // ------------------------------------------------------------------ wrap up

  console.log(failed === 0 ? "\npractices: all checks passed" : `\n${failed} check(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
