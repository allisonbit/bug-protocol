#!/usr/bin/env node
/**
 * Metabolism: the swarm's own energy budget, set by carried vote.
 *
 * WHAT IT PINS:
 *
 *   1. The bounds. pulse_max_agents accepts 0 (everyone) or 1–100;
 *      pulse_actions_per_agent accepts 1–8, where 8 is rhythm's MAX_BUDGET and
 *      not a second constant that can drift. Every out-of-bounds value has a
 *      sentence, and every refusal mentions the bounds.
 *   2. The payload round trip. What a proposer writes is what the executor
 *      reads; a foreign payload (no flag, an unknown flag, a string value that
 *      is not a number) reads as null in the executor's shape, so it resolves
 *      as `passed`, never as `executed`.
 *   3. The proposal-time gate. agentProposeVote refuses an invalid metabolism
 *      payload BEFORE a ballot exists, and only when the payload names one of
 *      our two flags — other payloads pass untouched.
 *   4. The wiring. The executor consults metabolismFromPayload before its
 *      numeric set; the two kinds are registered in agentProposeVote; the
 *      applied note travels onto the bus event.
 *   5. The homeostat (r34). Thin windows propose nothing; starvation grows the
 *      resident cap first and only then the per-wake budget; slack rests one
 *      step and never below the floor; the payload it writes is the shape the
 *      executor reads. Structural rule r34 cannot be disabled by an amendment.
 *
 * PURE. No database, no network, no clock.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-metabolism.cjs
 */
const fs = require("fs");

(async () => {
  const M = await import("../lib/swamp/metabolism.ts");
  const R = await import("../lib/swamp/rhythm.ts");

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`ok   ${name}`);
    else {
      failed += 1;
      console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    }
  };

  // ---- 1. The bounds -------------------------------------------------------
  check(
    "the per-wake ceiling is rhythm's MAX_BUDGET, not a second number",
    M.MAX_PULSE_ACTIONS === R.MAX_BUDGET,
    `${M.MAX_PULSE_ACTIONS} vs ${R.MAX_BUDGET}`,
  );
  check("the per-wake floor is 1", M.MIN_PULSE_ACTIONS === 1);
  check("0 (everyone) is a valid max_agents value", M.metabolismFromPayload({ flag: "pulse_max_agents", value: 0 })?.value === 0);
  check("a max_agents beyond 100 is refused", M.metabolismFromPayload({ flag: "pulse_max_agents", value: 101 }) === null);
  check("a negative max_agents is refused", M.metabolismFromPayload({ flag: "pulse_max_agents", value: -1 }) === null);
  check("a per-agent value of 0 is refused (a resident cannot wake to do nothing)", M.metabolismFromPayload({ flag: "pulse_actions_per_agent", value: 0 }) === null);
  check("a per-agent value above the ceiling is refused", M.metabolismFromPayload({ flag: "pulse_actions_per_agent", value: R.MAX_BUDGET + 1 }) === null);
  check("a per-agent value at the ceiling is accepted", M.metabolismFromPayload({ flag: "pulse_actions_per_agent", value: R.MAX_BUDGET })?.value === R.MAX_BUDGET);
  check("fractional values are floored, not rejected", M.metabolismFromPayload({ flag: "pulse_actions_per_agent", value: 2.9 })?.value === 2);
  for (const bad of [undefined, null, true, "many"]) {
    const refusal = M.metabolismRefusal({ flag: "pulse_max_agents", value: bad });
    check(`a ${String(bad)} value earns a sentence naming the bounds`, typeof refusal === "string" && refusal.includes("pulse_max_agents"));
  }
  check("an unknown flag is not ours and reads as null", M.metabolismFromPayload({ flag: "vote_pass_pct", value: 50 }) === null);
  check("a missing flag reads as null", M.metabolismFromPayload({ value: 5 }) === null);
  check("pulse_enabled is NOT ours: a vote cannot switch the swarm off", !M.isMetabolismFlag("pulse_enabled"));

  // ---- 2. The wiring -------------------------------------------------------
  const tick = fs.readFileSync("app/api/orchestrator/tick/route.ts", "utf8");
  check(
    "the executor asks metabolism before its numeric set",
    /const metabolism = metabolismFromPayload\(payload\);/.test(tick) && tick.indexOf("metabolismFromPayload(payload)") < tick.indexOf("NUMERIC_FLAGS.has(flag)"),
  );
  const actions = fs.readFileSync("lib/agents/actions.ts", "utf8");
  check("metabolism is a registered vote kind", actions.includes('"metabolism"') && actions.includes("isMetabolismFlag(payloadRecord.flag)"));
  check("an invalid metabolism payload is refused at proposal time", /metabolismRefusal\(payloadRecord\)/.test(actions));
  check("the applied change carries its note onto the bus", /note: metabolism\.note/.test(tick));

  // ---- 3. The homeostat (r34) ----------------------------------------------
  const starving = { beats: 12, planned: 40, ran: 24, maxAgents: 8, actionsPerAgent: 3 };
  const growPeople = M.metabolismProposal(starving);
  check("starvation grows the resident cap first", growPeople?.flag === "pulse_max_agents" && growPeople.value === 0);
  const growBudget = M.metabolismProposal({ ...starving, maxAgents: 0 });
  check("with everyone awake, starvation grows the per-wake budget", growBudget?.flag === "pulse_actions_per_agent" && growBudget.value === 4);
  const atCeiling = M.metabolismProposal({ ...starving, maxAgents: 0, actionsPerAgent: R.MAX_BUDGET });
  check("at the platform ceiling the honest answer is no proposal", atCeiling === null);
  const slack = M.metabolismProposal({ beats: 20, planned: 60, ran: 60, maxAgents: 0, actionsPerAgent: 3 });
  check("sustained slack rests one step", slack?.flag === "pulse_actions_per_agent" && slack.value === 2);
  const atFloor = M.metabolismProposal({ beats: 20, planned: 60, ran: 60, maxAgents: 0, actionsPerAgent: 1 });
  check("the floor is never voted below", atFloor === null);
  const thin = M.metabolismProposal({ beats: 3, planned: 40, ran: 10, maxAgents: 8, actionsPerAgent: 3 });
  check("a window too thin to read proposes nothing", thin === null);
  const noisy = M.metabolismProposal({ beats: 12, planned: 40, ran: 34, maxAgents: 8, actionsPerAgent: 3 });
  check("a drop under the starvation share is noise, not starvation", noisy === null);
  check(
    "the homeostat's payload is the shape the executor reads",
    (() => {
      const p = M.metabolismProposal(starving);
      const payload = p && M.metabolismVotePayload(p);
      return payload && M.metabolismFromPayload(payload)?.key === p.flag;
    })(),
  );

  const policy = fs.readFileSync("lib/swamp/policy.ts", "utf8");
  check("r34 exists and proposes the metabolism vote", /id: "r34"[\s\S]{0,400}intent: "propose_metabolism"/.test(policy));
  check("r34 is in the closed intent set", policy.includes('"propose_metabolism",'));

  const selfPolicy = fs.readFileSync("lib/swamp/self-policy.ts", "utf8");
  check("r34 is structural: the swarm cannot vote away its own hunger", selfPolicy.includes('"r34"'));
  const brain = fs.readFileSync("lib/swamp/brain.ts", "utf8");
  check(
    "r34 is paced by the shared note, refuses duplicate open ballots, then derives the proposal",
    /case "propose_metabolism": \{[\s\S]{0,400}METABOLISM_NOTE_KEY[\s\S]{0,600}kind === "metabolism"[\s\S]{0,200}metabolismProposal\(obs\.vitals\)/.test(brain),
  );
  check(
    "r18 votes yes on a metabolism ballot only when it matches its own derivation",
    /case "cast_vote": \{[\s\S]{0,700}kind === "metabolism"[\s\S]{0,600}agrees \? "yes" : "abstain"/.test(brain),
  );
  const obs = fs.readFileSync("lib/swamp/observations.ts", "utf8");
  check("the metabolism note key is in the shared-notes query", obs.includes("key.like.metabolism:%"));
  check("observations carry the vitals r34 reads", obs.includes("vitals,"));

  console.log(failed === 0 ? "\nall metabolism checks pass" : `\n${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
