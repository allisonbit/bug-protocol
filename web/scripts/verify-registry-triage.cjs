#!/usr/bin/env node
/**
 * Which published skills this deployment reads the bytes of, in what order, and why.
 *
 * WHY THIS FILE EXISTS. Reading somebody else's document costs two requests to a server this
 * deployment does not own, and tens of thousands of candidates are waiting, so the ORDER is
 * the editorial decision of the whole wave. Three ways it can be wrong, and all three are
 * invisible from outside: a candidate already judged gets read again, which spends somebody
 * else's bandwidth re-deriving a verdict that is already on the record; the tie-break drifts,
 * so which skills get judged depends on how a database happened to answer and the coverage
 * number becomes a report about a race rather than about a corpus; and the registry's own
 * flagged skills sit at the back of the queue, which would mean looking away from the only
 * rows where a second opinion changes anybody's decision.
 *
 * WHAT IT PINS.
 *
 *   1. The tiers, in order: flagged by the registry, then uncovered topic, then by installs.
 *   2. The exclusions: already audited, blocked, and a ref that cannot be addressed.
 *   3. The tie-break, which is the ref ascending, so two passes agree.
 *   4. The bound: a caller cannot talk the door into fifty thousand fetches.
 *   5. The subject an audit is recorded under, and the round trip back out of it.
 *
 * PURE. Fixtures in, answers out: no network and no database.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-registry-triage.cjs
 */
(async () => {
  const { TRIAGE_MAX, TRIAGE_PER_PASS, auditSubjectOf, installsOf, isCandidate, pickForTriage, refFromSubject } = await import(
    "../lib/registry/triage.ts"
  );

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`ok   ${name}`);
    else {
      failed += 1;
      console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`);
    }
  };

  const row = (ref, extra = {}) => ({
    ref,
    topics: [],
    stats: {},
    clawhub_verdict: null,
    swamp_verdict: null,
    blocked: false,
    cited_at: null,
    ...extra,
  });

  // ---- the exclusions -----------------------------------------------------------------
  console.log("\n== what is never a candidate ==");
  check("an unaudited row with an address is a candidate", isCandidate(row("a/b")) === true);
  check("a row this deployment already judged is somebody's finished work", isCandidate(row("a/b", { swamp_verdict: "clean" })) === false);
  check("a row the registry blocked is never read here", isCandidate(row("a/b", { blocked: true })) === false);
  check("a ref that is not owner qualified cannot be addressed, so it is not a candidate", isCandidate(row("nope")) === false);
  check("installs are read from the registry's own stats", installsOf(row("a/b", { stats: { installs: 12 } })) === 12);
  check("an absent install count is zero rather than a crash", installsOf(row("a/b")) === 0);
  check("a string install count is still not invented", installsOf(row("a/b", { stats: { installs: "x" } })) === 0);

  // ---- the tiers ----------------------------------------------------------------------
  console.log("\n== the order, which is the whole decision ==");
  const rows = [
    row("zeta/popular", { stats: { installs: 900 } }),
    row("alpha/uncovered", { topics: ["Web Search"], stats: { installs: 2 } }),
    row("beta/flagged", { clawhub_verdict: "suspicious", stats: { installs: 1 } }),
    row("gamma/clean", { stats: { installs: 900 } }),
  ];
  const uncovered = new Set(["web search"]);
  const picked = pickForTriage(rows, { uncovered, limit: 4 });
  check("the registry's own flagged skill is read first", picked[0]?.ref === "beta/flagged", picked.map((p) => p.ref).join(", "));
  check("then a topic no capability here covers", picked[1]?.ref === "alpha/uncovered", picked.map((p) => p.ref).join(", "));
  check("and the rest by installs", picked[2]?.ref === "gamma/clean" && picked[3]?.ref === "zeta/popular");
  check("the tier is named on every pick", picked.map((p) => p.tier).join(",") === "registry-flagged,uncovered-topic,popular,popular", picked.map((p) => p.tier).join(","));
  check("and the reason says why, in the words that go on the record", /flags it as suspicious/.test(picked[0].why), picked[0].why);
  check("including the topic name when there is one", /"Web Search"/.test(picked[1].why), picked[1].why);

  const flaggedAndUncovered = pickForTriage([row("a/b", { clawhub_verdict: "suspicious", topics: ["Web Search"] })], { uncovered, limit: 1 })[0];
  check("a flagged skill in an uncovered topic says both, and still leads", flaggedAndUncovered.tier === "registry-flagged" && /Web Search/.test(flaggedAndUncovered.why));

  const caseInsensitive = pickForTriage([row("a/b", { topics: ["web SEARCH"] })], { uncovered, limit: 1 })[0];
  check("a topic is compared case insensitively, because the registry's own vocabulary is not consistent", caseInsensitive.tier === "uncovered-topic");

  // ---- the tie break ------------------------------------------------------------------
  console.log("\n== two passes choose the same documents ==");
  const ties = [row("c/one", { stats: { installs: 5 } }), row("a/two", { stats: { installs: 5 } }), row("b/three", { stats: { installs: 5 } })];
  const first = pickForTriage(ties, { uncovered: new Set(), limit: 3 }).map((p) => p.ref);
  const second = pickForTriage([...ties].reverse(), { uncovered: new Set(), limit: 3 }).map((p) => p.ref);
  check("equal installs break on the ref, ascending", first.join(",") === "a/two,b/three,c/one", first.join(","));
  check("and the order does not depend on how the rows arrived", first.join(",") === second.join(","));
  check("within a tier, more installs wins even when its ref sorts later", pickForTriage([row("a/low", { stats: { installs: 1 } }), row("z/high", { stats: { installs: 9 } })], { uncovered: new Set(), limit: 1 })[0].ref === "z/high");

  // ---- the bounds ---------------------------------------------------------------------
  console.log("\n== the bound is the caller's ceiling, not their request ==");
  check("the default is a polite few", pickForTriage(Array.from({ length: 40 }, (_, i) => row(`a/s${i}`)), { uncovered: new Set() }).length === TRIAGE_PER_PASS);
  check("a caller asking for more than the ceiling gets the ceiling", pickForTriage(Array.from({ length: 90 }, (_, i) => row(`a/s${i}`)), { uncovered: new Set(), limit: 5000 }).length === TRIAGE_MAX);
  check("a nonsense limit falls back to the default", pickForTriage(Array.from({ length: 9 }, (_, i) => row(`a/s${i}`)), { uncovered: new Set(), limit: 0 }).length === 1);
  check("and an empty candidate list is an empty pass rather than a crash", pickForTriage([], { uncovered: new Set() }).length === 0);

  // ---- the record's key ---------------------------------------------------------------
  console.log("\n== what the audit is recorded under ==");
  check("a registry audit is keyed by the skill's identity, not by the api path that served it", auditSubjectOf("steipete/gifgrep") === "registry:steipete/gifgrep");
  check("and the ref comes back out of the subject", refFromSubject(auditSubjectOf("steipete/gifgrep")) === "steipete/gifgrep");
  check("a subject for anything else is not a registry ref", refFromSubject("https://example.com/x/SKILL.md") === null);
  check("a null subject is handled", refFromSubject(null) === null);
  check("a malformed registry subject is refused rather than half read", refFromSubject("registry:not-a-ref") === null);

  console.log(`\nregistry triage: ${failed === 0 ? "all checks passed" : `${failed} check(s) FAILED`}`);
  if (failed > 0) process.exit(1);
})();
