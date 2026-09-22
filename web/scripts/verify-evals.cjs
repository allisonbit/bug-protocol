#!/usr/bin/env node
/**
 * The deployment scored against its own beats, and every way the arithmetic can lie.
 *
 * WHY THIS FILE EXISTS. Every branch here is quiet when it is wrong, and three of them
 * report good news about a broken deployment. A window with nothing attempted that
 * reports a perfect landed rate is a dashboard that shows calm during an outage. A
 * failed action counted as landed reports work that did not happen. And a regression
 * rule with no baseline that fires anyway marks the first run of a healthy deployment
 * as a collapse, which is the direction that gets a real signal ignored.
 *
 * WHAT IT PINS, in the order the layer runs:
 *
 *   1. Parsing. A row that is not a beat is skipped rather than counted as an empty one,
 *      because counting it would inflate the beat count and deflate every rate over it.
 *   2. Rates. Never divided by zero, and a null is a null rather than a zero.
 *   3. The scoreboard. landed is ran minus failed and never negative; a beat counts as
 *      acted only when it planned AND ran; latency averages only over spans that had it.
 *   4. The composite, and the fact that a null reads as zero rather than as perfect.
 *   5. Regressions. No baseline means nothing is marked, and only a move past the
 *      threshold counts.
 *   6. The surfaces: the doors, the page, the tool and the migration exist and are
 *      registered rather than claimed.
 *
 * PURE, except for reading four files off disk to check the registration. No database,
 * no network, no clock: every fixture carries its own timestamps.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-evals.cjs
 */
const fs = require("fs");
const path = require("path");

(async () => {
  const E = await import("../lib/swamp/evals.ts");

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`ok   ${name}`);
    else {
      failed += 1;
      console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`);
    }
  };

  const at = (i) => new Date(Date.parse("2026-09-22T12:00:00.000Z") + i * 60_000).toISOString();
  const span = (o = {}) => ({
    seq: o.seq ?? 1,
    at: o.at ?? at(o.seq ?? 1),
    agent: o.agent ?? "resident-a",
    planned: o.planned ?? 1,
    ran: o.ran ?? 1,
    failed: o.failed ?? 0,
    dropped: o.dropped ?? 0,
    degraded: o.degraded ?? null,
    model: o.model ?? null,
    tokensIn: o.tokensIn ?? 0,
    tokensOut: o.tokensOut ?? 0,
    latencyMs: o.latencyMs ?? null,
    durationMs: o.durationMs ?? null,
    errorType: o.errorType ?? null,
  });

  // ---- 1. parsing ----------------------------------------------------------------------
  console.log("\n== parsing ==");
  const beats = (s) => ({ seq: 1, created_at: at(1), topic: "pulse.span", payload: { span: s } });

  check("a row with no span is not a beat", E.parseEvalSpan({ seq: 1, created_at: at(1), topic: "pulse.span", payload: null }) === null);
  check("a span with no agent is not a beat", E.parseEvalSpan(beats({ "swamp.actions.planned": 2 })) === null);
  check("a non-span topic is not a beat", E.parseEvalSpan({ seq: 1, created_at: at(1), topic: "machine.reading", payload: { span: { agent_handle: "a" } } }) === null);

  const parsed = E.parseEvalSpan(
    beats({
      agent_handle: "atlas",
      "swamp.actions.planned": 3,
      "swamp.actions.ran": 2,
      "swamp.actions.failed": 1,
      "swamp.dropped": 1,
      "swamp.degraded": "the model call failed, so this agent ran its published reflex policy instead",
      "gen_ai.request.model": "some/model",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20,
      "gen_ai.request.latency_ms": 42,
      duration_ms: 900,
      "error.type": "GatewayInternalServerError",
    }),
  );
  check("a full span keeps its counts", parsed && parsed.planned === 3 && parsed.ran === 2 && parsed.failed === 1 && parsed.dropped === 1, JSON.stringify(parsed));
  check("a full span keeps its model and tokens", parsed && parsed.model === "some/model" && parsed.tokensIn === 100 && parsed.tokensOut === 20, JSON.stringify(parsed));
  check("a full span keeps the degradation sentence", parsed && typeof parsed.degraded === "string" && parsed.degraded.includes("reflex policy"), String(parsed && parsed.degraded));

  const missing = E.parseEvalSpan(beats({ agent_handle: "atlas" }));
  check("missing counts read as zero, not NaN", missing && missing.planned === 0 && missing.ran === 0 && Number.isFinite(missing.dropped), JSON.stringify(missing));
  check("missing numbers are not negative", missing && missing.planned >= 0 && missing.ran >= 0 && missing.failed >= 0, JSON.stringify(missing));

  // ---- 2. rates ------------------------------------------------------------------------
  console.log("\n== rates ==");
  check("a rate over zero is null, not zero", E.rate(0, 0) === null);
  check("a rate over zero is null even with work on top", E.rate(3, 0) === null);
  check("a rate rounds to an integer percent", E.rate(1, 3) === 33);
  check("a perfect rate is 100", E.rate(4, 4) === 100);

  // ---- 3. the scoreboard ---------------------------------------------------------------
  console.log("\n== the scoreboard ==");
  const empty = E.scoreWindow([], at(0), at(10));
  check("an empty window has no landed rate", empty.landedRate === null, String(empty.landedRate));
  check("an empty window has no degradation rate", empty.degradationRate === null, String(empty.degradationRate));
  check("an empty window scores zero rather than perfect", empty.score === 0, String(empty.score));

  const nothingRan = E.scoreWindow([span({ planned: 2, ran: 0 })], at(0), at(10));
  check("planning with nothing run is a zero landed rate, not a null", nothingRan.landedRate === 0, String(nothingRan.landedRate));
  check("planning with nothing run lands nothing", nothingRan.landed === 0, String(nothingRan.landed));
  check("a beat that planned but ran nothing is not an acted beat", nothingRan.actedBeats === 0, String(nothingRan.actedBeats));

  const mixed = E.scoreWindow(
    [
      span({ planned: 2, ran: 2, failed: 1, agent: "a" }),
      span({ planned: 1, ran: 1, failed: 0, agent: "a", model: "m", latencyMs: 100 }),
      span({ planned: 0, ran: 0, agent: "b" }),
    ],
    at(0),
    at(10),
  );
  check("landed is ran minus failed", mixed.landed === 2, JSON.stringify({ ran: mixed.ran, failed: mixed.failed, landed: mixed.landed }));
  check("landed rate is over planned", mixed.landedRate === 67, String(mixed.landedRate));
  check("acted beats count only planned-and-ran", mixed.actedBeats === 2, String(mixed.actedBeats));
  check("a beat that ran more than it planned does not produce negative landed", E.scoreWindow([span({ planned: 0, ran: 1, failed: 2 })], at(0), at(10)).landed === 0);
  check("model calls count only spans with a model", mixed.modelCalls === 1, String(mixed.modelCalls));
  check("latency averages only over spans that carried it", mixed.avgLatencyMs === 100, String(mixed.avgLatencyMs));
  check("per agent aggregates and sorts by beats", mixed.perAgent[0].agent === "a" && mixed.perAgent[0].beats === 2, JSON.stringify(mixed.perAgent));
  check("per agent landed rate is computed", mixed.perAgent[0].landedRate === 67, JSON.stringify(mixed.perAgent[0]));

  const degraded = E.scoreWindow([span({ degraded: "why" }), span({}), span({})], at(0), at(10));
  check("degradation is counted per beat", degraded.degradedBeats === 1 && degraded.degradationRate === 33, JSON.stringify({ d: degraded.degradedBeats, r: degraded.degradationRate }));

  // ---- 4. the composite ----------------------------------------------------------------
  console.log("\n== the composite ==");
  check("the composite is half and half", E.composite(100, 100) === 100);
  check("the composite of a zero and a hundred is fifty", E.composite(0, 100) === 50);
  check("a null reads as zero in the composite", E.composite(null, null) === 0);
  check("a null landed with a real acted share is half the acted share", E.composite(null, 80) === 40);

  // ---- 5. regressions ------------------------------------------------------------------
  console.log("\n== regressions ==");
  const base = E.scoreWindow([span({ planned: 4, ran: 4 }), span({ planned: 4, ran: 4 })], at(0), at(10));
  check("no baseline means no regression is reported", E.regressions(base, null).length === 0);

  const worse = E.scoreWindow([span({ planned: 4, ran: 0 }), span({ planned: 4, ran: 0 })], at(0), at(10));
  const landedRow = E.regressions(worse, base).find((r) => r.metric === "landed_rate");
  check("a landed rate collapse is a regression", landedRow && landedRow.regressed === true, JSON.stringify(landedRow));

  const better = E.scoreWindow([span({ planned: 1, ran: 1 })], at(0), at(10));
  const noLanded = E.regressions(better, base).find((r) => r.metric === "landed_rate");
  check("a landed rate that held is not a regression", noLanded && noLanded.regressed === false, JSON.stringify(noLanded));

  const moreDegraded = E.scoreWindow([span({ degraded: "x" }), span({ degraded: "x" }), span({ degraded: "x" })], at(0), at(10));
  const degRow = E.regressions(moreDegraded, base).find((r) => r.metric === "degradation_rate");
  check("a degradation rise past the threshold is a regression", degRow && degRow.regressed === true, JSON.stringify(degRow));

  const noBaseline = E.regressions(E.scoreWindow([span({})], at(0), at(10)), E.scoreWindow([], at(0), at(10)));
  check("a null on either side is not a regression", noBaseline.every((r) => r.regressed === false), JSON.stringify(noBaseline));

  // ---- 6. the surfaces -----------------------------------------------------------------
  console.log("\n== the surfaces ==");
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  const surfaces = JSON.parse(read("lib/surfaces.json"));
  const page = (p) => surfaces.pages.some((e) => e.path === p);
  const endpoint = (p) => surfaces.endpoints.some((e) => e.path === p);

  check("the page is registered", page("/evals"));
  check("the read door is registered", endpoint("/api/evals"));
  check("the well-known document is registered", endpoint("/.well-known/evals.json"));
  check("the door is a GET and a POST", (surfaces.endpoints.find((e) => e.path === "/api/evals") || {}).method === "GET, POST");
  check("the menu links the page", /path: "\/evals"/.test(read("lib/nav.ts")));
  check("the tool is registered, not just written", /\.\.\.EVAL_TOOLS/.test(read("lib/mcp/tools.ts")));
  check("the action manifest names the capability", /score-this-deployment-against-its-own-beats/.test(read("lib/actions/manifest.ts")));
  check("the migration defines the run table", /create table if not exists public\.eval_runs/.test(read("supabase/migrate-evals.sql")));
  check("the migration widens the topic union rather than listing it", /add_event_topics/.test(read("supabase/migrate-evals.sql")));
  check("the topic union carries the two new names", /"eval\.scored"/.test(read("lib/agents/types.ts")) && /"eval\.regressed"/.test(read("lib/agents/types.ts")));

  console.log(`\n${failed === 0 ? "evals: all checks passed" : `evals: ${failed} check(s) failed`}`);
  process.exitCode = failed === 0 ? 0 : 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
