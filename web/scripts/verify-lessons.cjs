#!/usr/bin/env node
/**
 * What this deployment noticed about itself, and every way it refuses to act on it.
 *
 * WHY THIS FILE EXISTS. Every branch here fails quietly, and four of them would be lies.
 * A derivation that runs on too small a window turns a quiet afternoon into a dead rule. A
 * rule counted as barren when some of its actions actually landed reports work as failure,
 * which is the direction that gets a good rule deleted. An adoption path that lets a resident
 * adopt its own lesson makes the swarm agree with itself and call it correction. And a
 * refutation that fires when nothing has been recorded since the proposal decides a question
 * by rereading the rows the proposer already used, which is not a second opinion at all.
 *
 * WHAT IT PINS, in the order the layer runs:
 *
 *   1. The window. A beat with no parseable time, a beat outside the window, and a window
 *      below the beat floor, which must produce nothing rather than a weak claim.
 *   2. The three patterns. A rule that never fired, a rule that fired and landed nothing, a
 *      rule that fired and landed something, and a brain that degraded enough times.
 *   3. The evidence. Sequence numbers, the beat count they were counted from, and a hash that
 *      does not move when the same numbers arrive in a different order.
 *   4. Adoption. Five refusals and one permission, including the one that matters: nobody
 *      adopts its own lesson.
 *   5. The recount. Refused when nothing is newer, adopted when the pattern reproduces,
 *      refuted when it does not, and never a refusal dressed up as a refutation.
 *   6. The record's own guards: the migration's uniqueness, its decision-completeness
 *      constraint, and that its deletes qualify themselves.
 *   7. The surfaces: the door, the page and the tool are registered rather than claimed.
 *
 * PURE, except for reading three files off disk to check the registration. No database, no
 * network, no clock: every fixture carries its own `now`.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-lessons.cjs
 */
const fs = require("fs");
const path = require("path");

(async () => {
  const L = await import("../lib/swamp/lessons.ts");

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`ok   ${name}`);
    else {
      failed += 1;
      console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`);
    }
  };

  const NOW = "2026-09-22T12:00:00.000Z";
  const at = (minutesAgo) => new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString();
  const beat = (seq, o = {}) => ({
    seq,
    at: o.at ?? at(seq),
    agent_handle: o.agent ?? "resident-a",
    brain: o.brain ?? "reflex",
    planned: o.planned ?? 1,
    ran: o.ran ?? 1,
    failed: o.failed ?? 0,
    dropped: o.dropped ?? 0,
    degraded: o.degraded ?? null,
    // `?? []` here would quietly turn a span that cannot answer into a span that answered
    // "nothing fired", which is the exact defect the checks below exist to catch.
    rules: "rules" in o ? o.rules : [],
  });
  const many = (n, o = {}) => Array.from({ length: n }, (_, i) => beat(i + 1, typeof o === "function" ? o(i) : o));

  // ---- 1. the window ------------------------------------------------------------------
  console.log("\n== the window ==");
  const quiet = L.deriveLessons({ beats: [], policyRules: ["r1"], now: NOW });
  check("an empty window produces nothing", quiet.length === 0, JSON.stringify(quiet));

  const few = L.deriveLessons({ beats: many(L.MIN_BEATS - 1, { rules: ["r1"] }), policyRules: ["r1"], now: NOW });
  check("a window below the beat floor produces nothing", few.length === 0, `floor is ${L.MIN_BEATS}`);

  // The field is newer than the log it is read from. A span that predates it cannot say which
  // rule fired, so it is not evidence that a rule did not fire: counting it as silence would
  // propose a lesson about every rule in the policy on the first beat after a deploy.
  const predates = many(L.MIN_BEATS, { rules: null });
  check(
    "a span that predates the rule field is not read as a rule that did not fire",
    L.deriveLessons({ beats: predates, policyRules: ["r1", "r2"], now: NOW }).length === 0,
    "this is the absent install count read as zero, in a different table",
  );
  const mixedBeats = [...predates.slice(0, L.MIN_BEATS - 2), ...many(2, { rules: ["r1"] })];
  check(
    "and the beat floor is measured against spans that can answer",
    L.deriveLessons({ beats: mixedBeats, policyRules: ["r1"], now: NOW }).length === 0,
    "a window of two answerable beats is not twenty-four",
  );

  const stale = L.deriveLessons({
    beats: [...many(L.MIN_BEATS, { rules: [] }), beat(999, { at: "2020-01-01T00:00:00.000Z", rules: ["r1"] })],
    policyRules: ["r1"],
    now: NOW,
  });
  check(
    "a beat outside the window is not counted",
    stale.every((l) => !l.evidence.seqs.includes(999)),
    "an old beat inside a current window would make a dead rule look alive",
  );
  const undated = L.windowBeats([beat(1, { at: "not a date" }), ...many(3, {})], NOW);
  check("a beat whose time will not parse is dropped rather than placed at the epoch", undated.length === 3);

  // ---- 2. the three patterns -----------------------------------------------------------
  console.log("\n== the three patterns ==");
  const silent = L.deriveLessons({ beats: many(L.MIN_BEATS, { rules: ["r1"] }), policyRules: ["r1", "r9"], now: NOW });
  const silentLesson = silent.find((l) => l.subject === "r9");
  check("a rule that never fired is noticed", silentLesson?.kind === "rule_silent", JSON.stringify(silentLesson?.kind));
  check("and the rule that did fire is not", !silent.some((l) => l.subject === "r1" && l.kind === "rule_silent"));
  check("with the beat count it was counted from", silentLesson?.evidence.beats === L.MIN_BEATS, String(silentLesson?.evidence.beats));
  check("and every beat as its evidence, because silence is a fact about all of them", silentLesson?.evidence.seqs.length === L.MIN_BEATS);

  const barren = L.deriveLessons({
    beats: many(L.MIN_BEATS, (i) => (i < L.MIN_FIRINGS ? { rules: ["r7"], planned: 2, ran: 0, failed: 1, dropped: 1 } : { rules: ["r1"] })),
    policyRules: ["r7"],
    now: NOW,
  });
  check("a rule that fired and landed nothing is noticed", barren.some((l) => l.kind === "rule_barren" && l.subject === "r7"));

  const landsSome = L.deriveLessons({
    beats: many(L.MIN_BEATS, (i) => (i < L.MIN_FIRINGS ? { rules: ["r7"], planned: 2, ran: 1, failed: 1, dropped: 0 } : { rules: ["r1"] })),
    policyRules: ["r7"],
    now: NOW,
  });
  check(
    "a rule whose work partly landed is not called barren",
    landsSome.length === 0,
    "reporting landed work as failure is how a good rule gets deleted",
  );

  const twoFirings = L.deriveLessons({
    beats: many(L.MIN_BEATS, (i) => (i < L.MIN_FIRINGS - 1 ? { rules: ["r7"], planned: 1, ran: 0, failed: 1 } : { rules: ["r1"] })),
    policyRules: ["r7"],
    now: NOW,
  });
  check("two firings is not yet a pattern", twoFirings.length === 0, `floor is ${L.MIN_FIRINGS}`);

  const degraded = L.deriveLessons({
    beats: many(L.MIN_BEATS, (i) => (i < L.MIN_DEGRADED ? { agent: "resident-b", degraded: "gateway_timeout", rules: ["r1"] } : { rules: ["r1"] })),
    policyRules: ["r1"],
    now: NOW,
  });
  const degradedLesson = degraded.find((l) => l.kind === "brain_degraded");
  check("a brain that kept degrading is noticed", degradedLesson?.subject === "resident-b", JSON.stringify(degradedLesson?.subject));
  check("and the reason is carried rather than summarised away", /gateway_timeout/.test(degradedLesson?.statement ?? ""));
  const noDegradedField = many(L.MIN_BEATS, { rules: ["r1"] }).map((b) => {
    const { degraded, ...rest } = b;
    return rest;
  });
  check(
    "a span that cannot say whether it degraded is not counted as degrading",
    L.deriveLessons({ beats: noDegradedField, policyRules: ["r1"], now: NOW }).every((l) => l.kind !== "brain_degraded"),
  );
  check("one degradation is not a pattern", L.deriveLessons({ beats: many(L.MIN_BEATS, (i) => (i === 0 ? { degraded: "x", rules: ["r1"] } : { rules: ["r1"] })), policyRules: ["r1"], now: NOW }).some((l) => l.kind === "brain_degraded") === false);

  // ---- 3. the evidence -----------------------------------------------------------------
  console.log("\n== the evidence ==");
  const ev = { seqs: [3, 1, 2], from: at(60), to: NOW, count: 3, beats: 40, window_ms: L.LESSON_WINDOW_MS };
  const reordered = { ...ev, seqs: [2, 3, 1] };
  const h1 = L.lessonEvidenceHash("rule_silent", "r9", ev);
  const h2 = L.lessonEvidenceHash("rule_silent", "r9", reordered);
  check("the same rows hash the same however they arrive", h1 === h2, `${h1} vs ${h2}`);
  check("and a different subject hashes differently", h1 !== L.lessonEvidenceHash("rule_silent", "r8", ev));
  check("and a different count does too", h1 !== L.lessonEvidenceHash("rule_silent", "r9", { ...ev, count: 4 }));
  check("the digest is a sha256 in hex", /^[0-9a-f]{64}$/.test(h1));
  check("the canonical form names the kind, the subject and every number", /^lesson=rule_silent\nsubject=r9\n/m.test(L.canonicalEvidence("rule_silent", "r9", ev)));

  const lesson = {
    id: "L1",
    kind: "rule_silent",
    subject: "r9",
    statement: "the rule r9 did not fire",
    evidence: { ...ev, seqs: [10, 11, 12] },
    evidence_hash: h1,
    confidence: 60,
    status: "proposed",
    proposed_by: "agent-a",
    adopted_by: null,
    decided_at: null,
    decision_note: null,
    created_at: at(30),
  };

  // ---- 4. adoption ---------------------------------------------------------------------
  console.log("\n== adoption ==");
  check("another resident may adopt it", L.adoptionDecision({ lesson, deciderId: "agent-b" }).decision === "adopt");
  const own = L.adoptionDecision({ lesson, deciderId: "agent-a" });
  check("and its author may not", own.decision === "refuse", own.reason);
  check("with the reason naming why", /cannot adopt its own/.test(own.reason), own.reason);
  check("an already decided lesson is not reopened", L.adoptionDecision({ lesson: { ...lesson, status: "adopted" }, deciderId: "agent-b" }).decision === "refuse");
  check("a lesson with no sequence numbers never becomes behaviour", L.adoptionDecision({ lesson: { ...lesson, evidence: { ...ev, seqs: [] } }, deciderId: "agent-b" }).decision === "refuse");
  check("a window below the beat floor is refused", L.adoptionDecision({ lesson: { ...lesson, evidence: { ...ev, beats: 3 } }, deciderId: "agent-b" }).decision === "refuse");
  check("and so is a lesson under the confidence floor", L.adoptionDecision({ lesson: { ...lesson, confidence: L.MIN_CONFIDENCE - 1 }, deciderId: "agent-b" }).decision === "refuse");
  check("a statement longer than a lesson may be is refused", L.adoptionDecision({ lesson: { ...lesson, statement: "x".repeat(L.MAX_STATEMENT + 1) }, deciderId: "agent-b" }).decision === "refuse");

  // ---- 5. the recount ------------------------------------------------------------------
  console.log("\n== the recount ==");
  const sameRows = L.refutationVerdict({ lesson, deciderId: "agent-b", latestSeq: 12, reproduced: true });
  check("nothing newer means no second opinion", sameRows.decision === "refuse", sameRows.reason);
  check("and the reason says the rows would be the same", /same rows/.test(sameRows.reason), sameRows.reason);
  const holds = L.refutationVerdict({ lesson, deciderId: "agent-b", latestSeq: 40, reproduced: true });
  check("a pattern that still holds is adopted", holds.decision === "adopt", holds.reason);
  const gone = L.refutationVerdict({ lesson, deciderId: "agent-b", latestSeq: 40, reproduced: false });
  check("a pattern that does not reproduce is refuted", gone.decision === "refute", gone.reason);
  check(
    "refuting and refusing are different answers",
    gone.decision !== sameRows.decision,
    "a refusal is a decider declining; a refutation is a decider who measured",
  );
  check("a proposer cannot settle its own lesson by this path either", L.refutationVerdict({ lesson, deciderId: "agent-a", latestSeq: 99, reproduced: false }).decision === "refuse");

  // ---- 6. what is read, and the pacing -------------------------------------------------
  console.log("\n== what is read, and the pacing ==");
  const adopted = { ...lesson, id: "L2", status: "adopted", confidence: 70, decided_at: at(10) };
  const weak = { ...lesson, id: "L3", status: "adopted", confidence: L.MIN_CONFIDENCE - 1, decided_at: at(5) };
  const read = L.readableLessons([lesson, adopted, weak]);
  check("only adopted lessons are readable", read.every((l) => l.status === "adopted"));
  check("and only ones above the confidence floor", read.length === 1 && read[0].id === "L2", read.map((l) => l.id).join(","));
  check("newest first, because a policy reads the recent state of things", L.readableLessons([{ ...adopted, id: "old", decided_at: at(600) }, adopted])[0].id === "L2");
  check("a proposal cannot be read as behaviour", !L.readableLessons([lesson]).some((l) => l.id === "L1"));
  const queue = L.openProposals([lesson, { ...lesson, id: "L4", proposed_by: "agent-b" }], "agent-a");
  check("the proposal queue excludes my own", queue.length === 1 && queue[0].id === "L4", queue.map((l) => l.id).join(","));
  check("a fresh note is not due", L.proposalCooldownElapsed(NOW, NOW) === false);
  check("and a missing note means never proposed, which is due", L.proposalCooldownElapsed(null, NOW) === true);
  check("an unreadable timestamp is not treated as due", L.proposalCooldownElapsed("nonsense", NOW) === false);

  // ---- 7. the record's own guards ------------------------------------------------------
  console.log("\n== the record's own guards ==");
  const sql = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrate-lessons.sql"), "utf8");
  const bareDeletes = sql.split("\n").filter((l) => /^\s*delete\s+from\s+[\w."]+\s*;\s*$/i.test(l));
  check("every delete in the migration states what it deletes", bareDeletes.length === 0, bareDeletes.join(" | "));
  check("the same pattern counted twice is one lesson", /unique index if not exists lessons_once_idx on public\.lessons \(kind, subject, evidence_hash\)/.test(sql));
  check("a decided lesson must say when and by whom", /lessons_decision_complete/.test(sql) && /status = 'proposed' and adopted_by is null and decided_at is null/.test(sql));
  check("the status vocabulary is closed in the schema", /check \(status in \('proposed', 'adopted', 'refuted', 'retired'\)\)/.test(sql));
  check("and so is the kind vocabulary", /check \(kind in \('rule_silent', 'rule_barren', 'brain_degraded'\)\)/.test(sql));
  check("the record is publicly readable", /create policy lessons_read on public\.lessons for select using \(true\)/.test(sql));
  check("the three topics go through the widening helper", /add_event_topics\(array\['lesson\.proposed', 'lesson\.adopted', 'lesson\.refuted'\]\)/.test(sql));

  // ---- 8. the surfaces -----------------------------------------------------------------
  console.log("\n== the surfaces ==");
  const source = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  check("the door exists", /export async function GET/.test(source("app/api/lessons/route.ts")));
  check("the page exists", fs.existsSync(path.join(__dirname, "..", "app", "lessons", "page.tsx")));
  check("the tool is registered, not just written", /\.\.\.LESSON_TOOLS/.test(source("lib/mcp/tools.ts")));
  const surfaces = JSON.parse(source("lib/surfaces.json"));
  check("the door is on the surface register", surfaces.endpoints.some((e) => e.path === "/api/lessons"));
  check("and so is the page", surfaces.pages.some((p) => p.path === "/lessons"));
  const manifest = source("lib/actions/manifest.ts");
  check("the capability is joined to its projections in the manifest", /read-what-the-swarm-concluded-about-itself/.test(manifest));
  const types = source("lib/agents/types.ts");
  check("the three topics are named in the closed topic vocabulary", ["lesson.proposed", "lesson.adopted", "lesson.refuted"].every((t) => types.includes(`"${t}"`)));
  const feed = source("lib/agents/feed-render.ts");
  check("and every one of them has a sentence on the feed", ["lesson.proposed", "lesson.adopted", "lesson.refuted"].every((t) => feed.includes(`case "${t}"`)));
  const observations = source("lib/swamp/observations.ts");
  check(
    "the pacing note is in the shared-key read, or the guard silently lets everything through",
    /key\.like\.lesson:%/.test(observations),
    "a guard that reads a key nobody wrote does not fail, it lets everything through",
  );

  console.log(`\nlessons: ${failed === 0 ? "all checks passed" : `${failed} check(s) FAILED`}`);
  if (failed > 0) process.exit(1);
})();
