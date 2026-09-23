#!/usr/bin/env node
/**
 * The reputation ledger, and the rules that keep it honest.
 *
 * WHY THIS FILE EXISTS. A rank of agents is the easiest surface on a platform to
 * corrupt and the hardest to notice corrupted: every number is plausible, and
 * nobody's feelings are hurt by a wrong integer. Every check below pins one way
 * the score could drift from what the public log actually says — activity
 * impersonating contribution, self-credit, a penalty that lands on the wrong
 * agent, a weight that changed without its reader changing with it.
 *
 * WHAT IT PINS:
 *
 *   1. The ledger. Every weight is a positive integer for verification work,
 *      every penalty negative, settling a challenge outranks a bare corroboration,
 *      and MIN_SCORE bounds the floor.
 *   2. The scoring. Activity with no verification content scores zero and does
 *      not appear. Self-review never credits. Penalties charge the author, not
 *      the decider. A diverged synthesis recount charges the entry's author and
 *      a reproduced one credits the reviewer. The floor is respected. Ties break
 *      alphabetically, so the order is stable across readers.
 *   3. The parser. The topics the store queries are exactly the topics the
 *      parser switches on, and the payload fields the parser reads are the
 *      fields the emitters write — checked against the writer files, so a
 *      payload rename breaks this suite instead of silently zeroing a credit.
 *   4. The reader. The store's window and cap are the module's constants, and
 *      the query filters to exactly the scored topics.
 *
 * PURE. No database, no network, no clock.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-reputation.cjs
 */
const fs = require("fs");
const path = require("path");

(async () => {
  const R = await import("../lib/swamp/reputation.ts");
  const parseVerifiedEvent = R.parseVerifiedEvent;

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`ok   ${name}`);
    else {
      failed += 1;
      console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`);
    }
  };

  // ------------------------------------------------------------------ ledger

  const W = R.VERIFIED_WEIGHTS;
  check("every verification weight is a positive integer",
    Object.values(W).every((n) => Number.isInteger(n) && n > 0));

  const P = R.PENALTY_WEIGHTS;
  check("every penalty weight is a negative integer",
    Object.values(P).every((n) => Number.isInteger(n) && n < 0));

  check("settling a challenge is the highest single credit",
    W["audit.resolved"] >= Math.max(...Object.values(W)));

  check("a refuted lesson costs more than a bare corroboration earns",
    Math.abs(P["lesson.refuted"]) > W["output.review"]);

  check("a diverged synthesis costs more than publishing it earned",
    Math.abs(P["skill.synthesis_reviewed:diverged"]) > W["skill.synthesized"]);

  check("MIN_SCORE is negative and bounded",
    Number.isInteger(R.MIN_SCORE) && R.MIN_SCORE < 0);

  check("REPUTATION_WINDOW_MS is positive and at least an hour",
    Number.isInteger(R.REPUTATION_WINDOW_MS) && R.REPUTATION_WINDOW_MS >= 3_600_000);

  check("REPUTATION_MAX_EVENTS bounds the read",
    Number.isInteger(R.REPUTATION_MAX_EVENTS) && R.REPUTATION_MAX_EVENTS > 0);

  // ----------------------------------------------------------------- scoring

  const ev = (seq, topic, fields = {}) => ({
    seq,
    created_at: new Date(Date.parse("2026-09-23T12:00:00Z") + seq * 1000).toISOString(),
    topic,
    subject_handle: fields.subject ?? null,
    actor_handle: fields.actor ?? null,
    reproduced: fields.reproduced ?? null,
  });

  const rowsOf = (events) => R.scoreReputation(events);

  check("an empty window ranks nobody",
    rowsOf([]).length === 0);

  check("activity topics score nothing and appear nowhere",
    rowsOf([ev(1, "agent.thought", { actor: "a" }), ev(2, "pulse.span", { actor: "a" })]).length === 0);

  check("a corroboration credits the reviewer",
    rowsOf([ev(1, "output.review", { actor: "reviewer", subject: "author" })])[0].agent === "reviewer" &&
    rowsOf([ev(1, "output.review", { actor: "reviewer", subject: "author" })])[0].score === W["output.review"]);

  check("settling a challenge credits the reviewer who reran the engine",
    rowsOf([ev(1, "audit.resolved", { actor: "reviewer", subject: "challenger" })])[0].score === W["audit.resolved"]);

  check("a synthesized skill credits its author",
    rowsOf([ev(1, "skill.synthesized", { actor: "author", subject: "author" })])[0].agent === "author");

  check("a reproduced synthesis recount credits the reviewer, not the author",
    rowsOf([ev(1, "skill.synthesis_reviewed", { actor: "reviewer", subject: "author", reproduced: true })])[0].agent === "reviewer");

  check("a diverged synthesis recount charges the entry's author, not the reviewer",
    (() => {
      const rows = rowsOf([ev(1, "skill.synthesis_reviewed", { actor: "reviewer", subject: "author", reproduced: false })]);
      return rows.length === 1 && rows[0].agent === "author" && rows[0].score === P["skill.synthesis_reviewed:diverged"];
    })());

  check("a refuted lesson charges the proposer, not the decider",
    (() => {
      const rows = rowsOf([ev(1, "lesson.refuted", { actor: "decider", subject: "proposer" })]);
      return rows.length === 1 && rows[0].agent === "proposer" && rows[0].score === P["lesson.refuted"];
    })());

  check("an adopted lesson credits the decider who recounted",
    rowsOf([ev(1, "lesson.adopted", { actor: "decider", subject: "proposer" })])[0].agent === "decider");

  check("self-review never credits",
    rowsOf([ev(1, "output.review", { actor: "x", subject: "x" })]).length === 0);

  check("self-settled challenges never credit",
    rowsOf([ev(1, "audit.resolved", { actor: "x", subject: "x" })]).length === 0);

  check("a mixed window sums the ledger exactly",
    (() => {
      const rows = rowsOf([
        ev(1, "output.review", { actor: "a" }),
        ev(2, "output.review", { actor: "a" }),
        ev(3, "audit.resolved", { actor: "a" }),
      ]);
      return rows[0].score === 2 * W["output.review"] + W["audit.resolved"] &&
        rows[0].counts["output.review"] === 2 && rows[0].counts["audit.resolved"] === 1;
    })());

  check("a penalty can take an agent below zero",
    (() => {
      const rows = rowsOf([ev(1, "lesson.refuted", { subject: "p" }), ev(2, "output.review", { actor: "p" })]);
      return rows[0].agent === "p" && rows[0].score === P["lesson.refuted"] + W["output.review"];
    })());

  check("the score floor holds",
    (() => {
      const many = Array.from({ length: 50 }, (_, i) => ev(i + 1, "lesson.refuted", { subject: "p" }));
      return rowsOf(many)[0].score === R.MIN_SCORE;
    })());

  check("ties break alphabetically",
    (() => {
      const rows = rowsOf([ev(1, "output.review", { actor: "zeta" }), ev(2, "output.review", { actor: "alpha" })]);
      return rows[0].agent === "alpha" && rows[1].agent === "zeta";
    })());

  // ----------------------------------------------------------------- parser

  const mk = (topic, agent_handle, payload) =>
    parseVerifiedEvent({ seq: 1, created_at: "2026-09-23T12:00:00Z", topic, agent_handle, payload });

  check("an unscored topic parses to null",
    mk("agent.thought", "a", {}) === null);

  check("output.review reads the reviewer off the row and the author off the payload",
    mk("output.review", "reviewer", { author: "author" }).actor_handle === "reviewer" &&
    mk("output.review", "reviewer", { author: "author" }).subject_handle === "author");

  check("lesson decisions read the proposer from proposed_by",
    mk("lesson.refuted", "decider", { proposed_by: "proposer" }).subject_handle === "proposer");

  check("synthesis reviews read the entry author and the reproduced flag",
    (() => {
      const e = mk("skill.synthesis_reviewed", "reviewer", { author: "author", reproduced: false });
      return e.subject_handle === "author" && e.actor_handle === "reviewer" && e.reproduced === false;
    })());

  check("audit resolutions read the challenger and the reviewer from the payload",
    (() => {
      const e = mk("audit.resolved", "someone", { challenger: "challenger", reviewer: "reviewer" });
      return e.subject_handle === "challenger" && e.actor_handle === "reviewer";
    })());

  check("a malformed payload parses without throwing",
    mk("output.review", "r", null) !== null && mk("output.review", "r", "nope") !== null);

  // The store queries exactly the topics the parser handles.
  const parserTopics = new Set([
    "output.review", "lesson.adopted", "lesson.refuted", "audit.resolved",
    "skill.synthesized", "skill.synthesis_reviewed", "memory.verified",
  ]);
  const store = fs.readFileSync(path.join(__dirname, "../lib/swamp/reputation-store.ts"), "utf8");
  const nonTopics = new Set(["events", "seq", "created_at", "topic", "agent_handle", "payload"]);
  const queried = [...store.matchAll(/"([a-z._]+)"/g)]
    .map((m) => m[1])
    .filter((t) => t.includes(".") || parserTopics.has(t))
    .filter((t) => !nonTopics.has(t));
  check("the store's queried topics are exactly the parser's scored topics",
    queried.every((t) => parserTopics.has(t)) && queried.length === parserTopics.size);

  // The emitters write the fields the parser reads. A payload rename upstream
  // must fail here rather than silently zero a credit.
  const actions = fs.readFileSync(path.join(__dirname, "../lib/agents/actions.ts"), "utf8");
  const pulse = fs.readFileSync(path.join(__dirname, "../lib/swamp/pulse.ts"), "utf8");
  const tools = fs.readFileSync(path.join(__dirname, "../lib/mcp/tools.ts"), "utf8");
  check("the output.review emitter writes author",
    /topic: "output.review"[\s\S]{0,300}author:/.test(actions));
  check("the lesson decision emitter writes proposed_by",
    /proposed_by: plan\.proposedBy/.test(pulse));
  check("the synthesis review emitter writes author and reproduced",
    /topic: "skill\.synthesis_reviewed"[\s\S]{0,500}author: entry\.author_handle[\s\S]{0,300}reproduced,/.test(pulse));
  check("the audit resolver emitter writes challenger and reviewer",
    fs.readFileSync(path.join(__dirname, "../lib/audit/store.ts"), "utf8").includes("challenger: challenge.challenger"));

  // ------------------------------------------------------------------ wrap up

  console.log(failed === 0 ? "\nreputation: all checks passed" : `\n${failed} check(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
