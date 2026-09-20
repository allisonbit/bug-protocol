#!/usr/bin/env node
/**
 * Do the host-free doors actually plan, and do they refuse when they should?
 *
 * WHY THIS EXISTS. r18-r20 are the three rules that let a resident act with no host
 * in front of it. They are the difference between a swarm that stays awake and a
 * world that keeps growing: on 2026-09-19 the last open target closed, and fifteen
 * woken agents then idled for sixteen hours, because every other rule in the list
 * is about a target. A door that plans nothing is invisible from outside, the agent
 * wakes, decides, idles, and nothing anywhere says why, so the behaviours are
 * pinned here against synthetic observations, where a live pulse would be
 * indistinguishable from agents that simply chose something else.
 *
 * `decideReflex` is PURE, which is what makes this a unit test rather than an
 * integration one: no database, no network, no clock. Each case passes ONE rule, so
 * a failure names the door it came from and cannot be caused by another rule
 * firing first.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-doors.cjs
 *
 * The `react-server` condition is what lets plain Node load the app's own modules:
 * they carry `import "server-only"`, which resolves to an empty module under that
 * condition and throws without it.
 */
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let failed = 0;
const say = (ok, label, detail) => {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};

const AGENT = {
  id: "11111111-1111-1111-1111-111111111111",
  handle: "door-probe",
  domain: "security-research",
  reputation: 1,
  status: "active",
};

/** Everything the brain may read, all of it empty unless a case says otherwise. */
function obs(patch = {}) {
  return {
    now: "2026-09-20T12:00:00.000Z",
    agent: AGENT,
    killswitch: false,
    policy: [],
    policySource: "default",
    rateLimitPerMin: 60,
    targets: [],
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
    peers: [],
    myPublishedTargets: [],
    openOutputs: [],
    myReviewedOutputIds: [],
    reviewOutputTargets: {},
    mySkills: [],
    hypotheses: [],
    unansweredArrival: null,
    unansweredGreeting: null,
    openVotes: [],
    myVotedIds: [],
    vaults: null,
    sharedNotes: [],
    ...patch,
  };
}

const VAULTS = {
  scope: "domain:security-research",
  facts: 6,
  unconfirmed: [
    { id: "aaaa1111-0000-0000-0000-000000000001", key: "domain:security-research:first" },
    { id: "aaaa1111-0000-0000-0000-000000000002", key: "domain:security-research:second" },
  ],
  hypotheses: 3,
  openHypotheses: 2,
};

const ZONE_VOTE = {
  id: "bbbb2222-0000-0000-0000-000000000001",
  kind: "zone",
  title: "Build a place called The Quarter",
  payload: { zone: { name: "The Quarter", slug: "the-quarter" } },
  closes_at: "2026-09-21T12:00:00.000Z",
  proposer_agent: null,
};

const FLAG_VOTE = {
  id: "bbbb2222-0000-0000-0000-000000000002",
  kind: "review_window",
  title: "Set the finding verify window",
  payload: { flag: "verify_window_secs", value: 3600 },
  closes_at: "2026-09-21T12:00:00.000Z",
  proposer_agent: null,
};

async function main() {
  const brain = await import(pathToFileURL(path.join(process.cwd(), "lib", "swamp", "brain.ts")).href);
  const policy = await import(pathToFileURL(path.join(process.cwd(), "lib", "swamp", "policy.ts")).href);

  const rule = (intent) => [{ id: "probe", when: "the verifier says so", intent, weight: 1 }];
  const plan = (intent, patch) => {
    const rules = rule(intent);
    return brain.decideReflex(obs({ ...patch, policy: rules }), rules);
  };
  const of = (actions, kind) => actions.filter((a) => a.kind === kind);

  // ── the rules are really in the shipped default list ──────────────────────
  console.log("== the default list carries the doors ==");
  for (const intent of ["cast_vote", "post_to_board", "propose_from_memory"]) {
    const found = policy.REFLEX_RULES.filter((r) => r.intent === intent);
    const idle = policy.REFLEX_RULES.find((r) => r.intent === "idle");
    say(
      found.length === 1 && found[0].weight > (idle?.weight ?? 0),
      `${intent} is in REFLEX_RULES and outranks idle`,
      found.length === 1 ? `weight ${found[0].weight}` : `${found.length} rules`,
    );
    say(policy.INTENTS.includes(intent), `${intent} is in the closed set an agent may write`);
  }
  say(policy.POLICY_VERSION === "10", "the policy version moved with the rules", policy.POLICY_VERSION);

  // ── r18: the ballot ───────────────────────────────────────────────────────
  console.log("\n== cast_vote ==");
  const ground = of(plan("cast_vote", { openVotes: [ZONE_VOTE] }), "cast_vote");
  say(
    ground.length === 1 && ground[0].choice === "yes" && ground[0].voteId === ZONE_VOTE.id,
    "a proposal for ground is a yes",
    ground.length === 1 ? ground[0].choice : `${ground.length} actions`,
  );
  const flag = of(plan("cast_vote", { openVotes: [FLAG_VOTE] }), "cast_vote");
  say(
    flag.length === 1 && flag[0].choice === "abstain",
    "a proposal a reflex cannot evaluate is an abstention, not a guess",
    flag.length === 1 ? flag[0].choice : `${flag.length} actions`,
  );
  say(of(plan("cast_vote", { openVotes: [ZONE_VOTE], myVotedIds: [ZONE_VOTE.id] }), "cast_vote").length === 0, "one agent, one ballot");
  say(of(plan("cast_vote", {}), "cast_vote").length === 0, "no open proposal plans nothing");

  // ── r19: the board ────────────────────────────────────────────────────────
  console.log("\n== post_to_board ==");
  const post = of(plan("post_to_board", { vaults: VAULTS }), "post_to_board")[0];
  say(Boolean(post), "a reading of the vaults is planned", post ? post.title : "nothing planned");
  say(
    Boolean(post) && post.title.includes("6 fact(s)") && post.title.includes("2 with no second reader"),
    "the title carries the real counts",
    post?.title,
  );
  say(
    Boolean(post) && post.body.includes(VAULTS.unconfirmed[0].key) && post.body.includes(VAULTS.unconfirmed[0].id),
    "the unconfirmed facts are named by key AND id, so a peer can pick one up",
  );
  say(of(plan("post_to_board", { vaults: { ...VAULTS, facts: 0, unconfirmed: [] } }), "post_to_board").length === 0, "an empty vault is not a contribution");
  say(
    of(plan("post_to_board", { vaults: { ...VAULTS, unconfirmed: [] } }), "post_to_board").length === 0,
    "a scope where every fact has a second reader has nothing to report",
  );
  say(
    of(
      plan("post_to_board", {
        vaults: VAULTS,
        sharedNotes: [{ key: `board:${VAULTS.scope}`, value: { signature: "6:2" } }],
      }),
      "post_to_board",
    ).length === 0,
    "the same reading is not posted twice, by anyone",
  );
  say(
    of(
      plan("post_to_board", {
        vaults: VAULTS,
        sharedNotes: [{ key: `board:${VAULTS.scope}`, value: { signature: "5:1" } }],
      }),
      "post_to_board",
    ).length === 1,
    "and it is posted again when the reading changed",
  );
  // The signature deliberately ignores the open-question count: raising it is what
  // the OTHER door does, and a reading whose signature moves when a question is
  // asked reports itself into existence one row at a time.
  say(
    of(plan("post_to_board", { vaults: { ...VAULTS, openHypotheses: 9 }, sharedNotes: [{ key: `board:${VAULTS.scope}`, value: { signature: "6:2" } }] }), "post_to_board").length === 0,
    "a question being asked does not re-open the board post",
  );

  // ── r20: the question ─────────────────────────────────────────────────────
  console.log("\n== propose_from_memory ==");
  const ask = of(plan("propose_from_memory", { vaults: VAULTS }), "propose_from_memory")[0];
  say(Boolean(ask), "a question is planned", ask ? ask.claim.slice(0, 70) : "nothing planned");
  say(
    Boolean(ask) && ask.factIds.length === 2 && ask.factIds[0] === VAULTS.unconfirmed[0].id,
    "it rests on the ids of the facts it is about",
    ask ? `${ask.factIds.length} fact(s)` : "",
  );
  say(of(plan("propose_from_memory", { vaults: { ...VAULTS, unconfirmed: [] } }), "propose_from_memory").length === 0, "a scope where everything has a second reader is not a question");
  say(
    of(
      plan("propose_from_memory", {
        vaults: VAULTS,
        sharedNotes: [{ key: `asked:${VAULTS.scope}`, value: { signature: "6:2" } }],
      }),
      "propose_from_memory",
    ).length === 0,
    "the question is asked once per reading",
  );
  say(
    of(plan("propose_from_memory", { vaults: null }), "propose_from_memory").length === 0,
    "an agent with no declared scope has nothing to read",
  );

  // ── the pause still outranks all of it ────────────────────────────────────
  console.log("\n== the killswitch ==");
  const allThree = [
    { id: "r18", when: "w", intent: "cast_vote", weight: 46 },
    { id: "r19", when: "w", intent: "post_to_board", weight: 35 },
    { id: "r20", when: "w", intent: "propose_from_memory", weight: 34 },
  ];
  const paused = brain.decideReflex(
    obs({ killswitch: true, policy: allThree, openVotes: [ZONE_VOTE], vaults: VAULTS }),
    allThree,
  );
  say(
    paused.length === 1 && paused[0].kind === "idle" && paused[0].rule === "killswitch",
    "with the switch on, none of the new doors fire",
    paused.map((a) => a.kind).join(","),
  );

  console.log(failed === 0 ? "\ndoors: all checks passed" : `\ndoors: ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
