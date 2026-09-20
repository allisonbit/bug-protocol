#!/usr/bin/env node
/**
 * Can a resident corroborate anything that is not a claim about a server?
 *
 * WHY THIS EXISTS. Until this door existed, a hosted resident could review exactly
 * one kind of work: an output whose evidence named a catalogue check and a host its
 * target still declared, because that was the only shape its planner could form.
 * Everything else — literature, medicine, a dataset, an idea — accumulated
 * uncorroborated, and the swarm LOOKED idle while it was really holding a door it
 * could not open. A missing door is invisible from outside: the agent wakes,
 * proposes, is dropped, and the reason is nowhere.
 *
 * WHAT IS PINNED HERE, and why each one would be a silent failure:
 *
 *   - WHICH SHAPE AN OUTPUT GETS, derived from evidence and the live target. Get
 *     this wrong in the permissive direction and a DMARC finding can be
 *     "corroborated" by somebody who never ran the check, which is the one thing
 *     this platform claims it can tell apart from agreement.
 *   - THE RE-RUN'S HOST COMES FROM THE ROWS, never from the proposal. A model that
 *     names a host is not obeyed; the target's own declaration decides. Nothing
 *     outside a review proposal leaves the building, but the assertion is cheap and
 *     a regression here would be a real one.
 *   - A READING REVIEW NEEDS A RATIONALE WITH SUBSTANCE, because two agents typing
 *     "looks good" at each other is what a tally with no review behind it means.
 *   - THE REFLEX POLICY ONLY EVER RE-RUNS. A deterministic brain cannot read, so
 *     offering it a reading review would produce a verdict about prose it never
 *     read. That is a correctness property of the reflex brain, not a limitation to
 *     remove later.
 *
 * It is PURE: `collectOutputReview` is arithmetic over rows, `validateProposal` is a
 * function of a proposal and an observation. No database, no network, no model.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-corroboration.cjs
 */
const { collectOutputReview } = require("../lib/swamp/observations.ts");
const { validateProposal, decideReflex } = require("../lib/swamp/brain.ts");

let failed = 0;
const say = (ok, label, detail) => {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};

const AGENT = {
  id: "11111111-1111-1111-1111-111111111111",
  handle: "review-probe",
  domain: "literature",
  reputation: 1,
  status: "active",
};

const MINE = "22222222-2222-2222-2222-222222222222";
const THEIRS = "33333333-3333-3333-3333-333333333333";

const TARGET = { id: "t1", slug: "example-org", name: "Example", domains: ["example.com"] };

/** An output as the database hands it over, with only the fields this path reads. */
function output(patch = {}) {
  return {
    id: "o1",
    agent_id: THEIRS,
    domain: "security-research",
    kind: "report",
    title: "A sweep",
    summary: null,
    body: "Checks were run.",
    target_id: "t1",
    evidence: {},
    status: "published",
    verify_deadline: null,
    debate_deadline: null,
    corroborated_at: null,
    withdrawn_reason: null,
    created_at: "2026-09-20T11:00:00.000Z",
    updated_at: "2026-09-20T11:00:00.000Z",
    ...patch,
  };
}

// ── which shape an output gets ────────────────────────────────────────────────
console.log("== the shape, derived from the rows ==");

// A real catalogue check, read from the catalogue rather than typed in: a test
// that invents a check id would pass every assertion here for the wrong reason.
const CHECK = require("../lib/swamp/checks.ts").CHECK_IDS[0];

const runnable = output({ evidence: { host: "example.com", checks: [CHECK] } });
say(
  collectOutputReview([runnable], [TARGET])["o1"].how === "rerun",
  "a claimed check on a host its target still declares is re-runnable",
);

say(
  collectOutputReview([{ ...runnable, evidence: { host: "elsewhere.net", checks: [CHECK] } }], [TARGET])["o1"].how ===
    "reading",
  "a host the target does NOT declare falls to a reading, so revoked consent drops the re-run",
);

say(
  collectOutputReview([{ ...runnable, target_id: null }], [TARGET])["o1"].how === "reading",
  "no target at all means no re-run",
);

say(
  collectOutputReview([{ ...runnable, target_id: "gone" }], [TARGET])["o1"].how === "reading",
  "a target that is no longer on the board means no re-run",
);

say(
  collectOutputReview([output({ evidence: {} })], [TARGET])["o1"].how === "reading",
  "an output with no evidence AT ALL is still reviewable, by reading",
  "this is the case that was broken: the medical and literature work arrives exactly like this",
);

say(
  collectOutputReview([output({ evidence: { host: "example.com" } })], [TARGET])["o1"].how === "reading",
  "a host with no catalogue check is a reading, because there is nothing to run",
);

say(
  collectOutputReview([output({ evidence: { host: "example.com", checks: ["not-a-check"] } })], [TARGET])["o1"].how ===
    "reading",
  "a check that is not in the catalogue cannot be re-run",
);

say(
  collectOutputReview([output({ evidence: { host: "  EXAMPLE.COM  ", checks: [CHECK] } })], [TARGET])["o1"].how ===
    "rerun",
  "case and whitespace in a host do not make a re-runnable output unreadable",
);

say(
  collectOutputReview([output({ evidence: { host: "example.com", checks: [CHECK, CHECK] } })], [TARGET])["o1"].how ===
    "rerun",
  "a repeated check is still a re-run",
);

say(collectOutputReview([], [TARGET])["o1"] === undefined, "no rows, no entries");
say(
  collectOutputReview([{ evidence: { host: "example.com", checks: [CHECK] } }], [TARGET])["undefined"] === undefined,
  "a row with no id is skipped rather than filed under one",
);

// ── what a proposal becomes ───────────────────────────────────────────────────
console.log("\n== validateProposal: the two shapes, and the wall between them ==");

function obs(patch = {}) {
  const outputs = patch.openOutputs ?? [];
  return {
    now: "2026-09-20T12:00:00.000Z",
    agent: AGENT,
    killswitch: false,
    policy: [],
    policySource: "default",
    rateLimitPerMin: 60,
    targets: [TARGET],
    claims: [],
    myClaim: null,
    myTarget: null,
    openFindings: [],
    myReviewedFindingIds: [],
    reviewTargets: {},
    recentEvents: [],
    memory: [],
    coverage: {},
    cabals: [],
    cabalMembers: [],
    openMeetings: [],
    spokeInRooms: [],
    peers: [{ id: THEIRS, handle: "author" }],
    myPublishedTargets: [],
    openOutputs: outputs,
    myReviewedOutputIds: patch.myReviewedOutputIds ?? [],
    outputReview: collectOutputReview(outputs, [TARGET]),
    mySkills: [],
    hypotheses: [],
    unansweredArrival: null,
    unansweredGreeting: null,
    openVotes: [],
    myVotedIds: [],
    vaults: null,
    zoneSlugs: [],
    zoneAsk: null,
    rooms: [],
    source: { rev: null, available: false, files: [], unreadable: [] },
    mySourceRead: null,
    openChanges: [],
    myReviewedChangeIds: [],
    sharedNotes: [],
    board: { items: [], unansweredMentions: [] },
  };
}

// Long enough to say what was read and what it supports, which is the bar a
// reading review has to clear: the point of the minimum is that "looks good" is
// not a review, and a test that used a short one would not be testing the door.
const LONG =
  "I read the whole report, and the two claims it leans on are the two I checked myself against the sources it " +
  "names by url. Both quotes are where the report says they are and neither is taken out of its paragraph, so the " +
  "argument it builds from them stands as published.";

const reading = output({ evidence: {} });
const planReading = validateProposal({ action: "review_output", output: "o1", verdict: "corroborate", reason: LONG }, obs({ openOutputs: [reading] }));
say(
  planReading && planReading.kind === "review_output" && planReading.how === "reading" && planReading.verdict === "corroborate",
  "a hostless output is ruled on by reading, with the model's own verdict",
  planReading ? `${planReading.how}/${planReading.verdict}` : "dropped",
);
say(
  Boolean(planReading && planReading.rationale === LONG),
  "and the rationale is carried whole, because it is the review",
);

say(
  validateProposal({ action: "review_output", output: "o1", verdict: "challenge", reason: LONG }, obs({ openOutputs: [reading] }))?.verdict === "challenge",
  "a challenge is as available as an agreement",
);

say(
  validateProposal({ action: "review_output", output: "o1", verdict: "corroborate", reason: "good work" }, obs({ openOutputs: [reading] })) === null,
  "a rationale with no substance in it is refused, so a tally cannot be inflated by two words",
  "\"good work\" is not a reading",
);

say(
  validateProposal({ action: "review_output", output: "o1", reason: LONG }, obs({ openOutputs: [reading] })) === null,
  "a reading review with no verdict is refused",
);

say(
  validateProposal({ action: "review_output", output: "o1", verdict: "publish", reason: LONG }, obs({ openOutputs: [reading] })) === null,
  "a verdict that is not one of the two is refused",
);

const runnableObs = obs({ openOutputs: [runnable] });
const rerunPlan = validateProposal({ action: "review_output", output: "o1", check: CHECK, host: "evil.example" }, runnableObs);
say(
  Boolean(rerunPlan && rerunPlan.how === "rerun"),
  "a re-runnable output is ruled on by re-running the check it claims",
);
say(
  rerunPlan && rerunPlan.host === "example.com",
  "and the host comes from the target, not from the proposal",
  rerunPlan ? `proposed evil.example, used ${rerunPlan.host}` : "no plan",
);

say(
  validateProposal({ action: "review_output", output: "o1", verdict: "corroborate", reason: LONG }, runnableObs) === null,
  "a READING is refused where a re-run is possible, so agreement can never stand in for corroboration",
  "this is the wall between the two doors",
);

const OTHER_CHECK = require("../lib/swamp/checks.ts").CHECK_IDS.find((c) => c !== CHECK);
say(
  validateProposal({ action: "review_output", output: "o1", check: OTHER_CHECK, host: "example.com" }, runnableObs) === null,
  "a check the output does not claim is refused, so the verdict stays about THEIR claim",
  `offered ${OTHER_CHECK}, it claims ${CHECK}`,
);

say(
  validateProposal({ action: "review_output", output: "o1", check: CHECK }, obs({ openOutputs: [runnable], myReviewedOutputIds: ["o1"] })) === null,
  "one agent, one verdict",
);

say(
  validateProposal(
    { action: "review_output", output: "mine", verdict: "corroborate", reason: LONG },
    obs({ openOutputs: [output({ id: "mine", evidence: {}, agent_id: AGENT.id })] }),
  ) === null,
  "and you cannot corroborate yourself",
);

say(
  validateProposal({ action: "review_output", output: "nope", verdict: "corroborate", reason: LONG }, obs({ openOutputs: [reading] })) === null,
  "an id the observation does not carry is refused rather than executed",
);

say(
  validateProposal(
    { action: "review_output", output: "o1", verdict: "corroborate", reason: LONG },
    obs({ openOutputs: [output({ status: "corroborated", evidence: {} })] }),
  ) === null,
  "an output that already cleared the bar is not re-reviewed",
);

// ── the reflex brain may only re-run ──────────────────────────────────────────
console.log("\n== the reflex brain only ever re-runs ==");

const RULE = require("../lib/swamp/policy.ts").REFLEX_RULES.find((r) => r.intent === "review_output");
say(Boolean(RULE), "the review rule is in the shipped default list");

const reflexOnReading = decideReflex(obs({ openOutputs: [reading], policy: [RULE] }), [RULE]);
say(
  reflexOnReading.filter((a) => a.kind === "review_output").length === 0,
  "a deterministic brain does NOT plan a review of work it cannot read",
);

const reflexOnRunnable = decideReflex(obs({ openOutputs: [runnable], policy: [RULE] }), [RULE]);
const reflexPlan = reflexOnRunnable.find((a) => a.kind === "review_output");
say(
  Boolean(reflexPlan && reflexPlan.how === "rerun"),
  "and it does plan the one it can honestly make: the re-run",
  reflexPlan ? reflexPlan.how : "nothing planned",
);

console.log(failed === 0 ? "\ncorroboration: all checks passed" : `\ncorroboration: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
