#!/usr/bin/env node
/**
 * Self-policy: the swarm amending its own reflex rulebook, by carried vote.
 *
 * WHAT IT PINS:
 *
 *   1. The op grammar. Exactly four ops; every op names a rule; an add names an
 *      intent in the CLOSED set; weights are bounded like an agent's own rules.
 *   2. The structural floor. announce (r11) and the homeostat (r34) cannot be
 *      disabled — the swarm does not vote to stop being able to speak honestly
 *      or to stop feeling its own hunger.
 *   3. The bundle bounds. At most MAX_OPS ops, at most MAX_ADDED_RULES adds, one
 *      op per rule, and a bundle that composes to nothing is a no-op.
 *   4. The composer. Disable removes, reweight keeps wording, reorder keeps the
 *      rule, add never duplicates an id, and the result is weight-ordered like
 *      the engine sorts. An unknown rule id refuses rather than silently ignoring
 *      the op.
 *   5. The wiring. The executor branch sits beside practice's; the three topics
 *      are in the type union AND the migration's union call; the store's adoption
 *      re-validates; observations compose the amended list and publish a digest
 *      over what actually runs.
 *
 * PURE. No database, no network, no clock.
 */
const fs = require("fs");

(async () => {
  const S = await import("../lib/swamp/self-policy.ts");
  const P = await import("../lib/swamp/policy.ts");

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`ok   ${name}`);
    else {
      failed += 1;
      console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    }
  };

  // ---- 1. The op grammar ----------------------------------------------------
  check("disable is valid on an ordinary rule", S.checkPolicyOp({ op: "disable", ruleId: "r29" }).ok === true);
  check("reweight bounds match an agent's own rules", S.checkPolicyOp({ op: "reweight", ruleId: "r29", weight: 1001 }).ok === false && S.checkPolicyOp({ op: "reweight", ruleId: "r29", weight: -1 }).ok === false);
  check("an add must name an existing intent", /not an action here/.test(S.checkPolicyOp({ op: "add", ruleId: "r50", when: "something I noticed", intent: "make_tea", weight: 10 }).reason));
  check("an add may name an existing intent", S.checkPolicyOp({ op: "add", ruleId: "r50", when: "a machine sits silent past three intervals", intent: "supervise_machine", weight: 60 }).ok === true);
  check("no fifth op exists", S.checkPolicyOp({ op: "teleport", ruleId: "r29" }).ok === false);
  check(
    "a reorder op is refused with the reason the design holds",
    /orders by weight/.test(S.checkPolicyOp({ op: "reorder", ruleId: "r29", position: 1 }).reason),
  );
  check("every op names a rule", S.checkPolicyOp({ op: "disable" }).ok === false);

  // ---- 2. The structural floor ----------------------------------------------
  for (const id of S.STRUCTURAL_RULE_IDS) {
    check(`${id} cannot be disabled`, /structural/.test(S.checkPolicyOp({ op: "disable", ruleId: id }).reason));
  }
  check("announce really is r11 in the shipped list", P.REFLEX_RULES.some((r) => r.id === "r11" && r.intent === "announce"));

  // ---- 3. The bundle bounds --------------------------------------------------
  check("an empty bundle is refused", S.checkOpsBundle([]).ok === false);
  check("a bundle above MAX_OPS is refused", S.checkOpsBundle(Array.from({ length: S.MAX_OPS + 1 }, (_, i) => ({ op: "reweight", ruleId: `r${i + 1}`, weight: 5 }))).ok === false);
  check("one op per rule per bundle", /appears twice/.test(S.checkOpsBundle([{ op: "reweight", ruleId: "r29", weight: 5 }, { op: "reweight", ruleId: "r29", weight: 9 }]).reason));
  const tooManyAdds = S.checkOpsBundle(Array.from({ length: S.MAX_ADDED_RULES + 1 }, (_, i) => ({ op: "add", ruleId: `rx${i}`, when: "a fact I can point at", intent: "post_to_board", weight: 10 })));
  check("adds are capped per amendment", tooManyAdds.ok === false);

  // ---- 4. The composer --------------------------------------------------------
  const base = [
    { id: "r11", when: "I have never announced myself", intent: "announce", weight: 98 },
    { id: "r29", when: "a clean skill maps onto a capability", intent: "cite_registry_skill", weight: 30 },
    { id: "r2", when: "a review is urgent", intent: "review_due", weight: 95 },
  ];
  const disabled = S.composeAmendedPolicy(base, [{ op: "disable", ruleId: "r29" }]);
  check("disable removes the rule", disabled.length === 2 && !disabled.some((r) => r.id === "r29"));
  const reweighted = S.composeAmendedPolicy(base, [{ op: "reweight", ruleId: "r29", weight: 99 }]);
  check("reweight keeps the wording and moves the order", reweighted[0].id === "r29" && reweighted[0].when === base[1].when);
  const reordered = S.composeAmendedPolicy(base, [{ op: "reweight", ruleId: "r2", weight: 1 }]);
  check("reweight to the bottom reorders the composed list", reordered[reordered.length - 1].id === "r2");
  const added = S.composeAmendedPolicy(base, [{ op: "add", ruleId: "r50", when: "a machine sits silent", intent: "supervise_machine", weight: 60 }]);
  check("add appends a new rule", added.length === 4 && added.some((r) => r.id === "r50"));
  check("add refuses a duplicate id", S.composeAmendedPolicy(base, [{ op: "add", ruleId: "r29", when: "duplicate id", intent: "post_to_board", weight: 10 }]) === null);
  check("an unknown rule id refuses rather than being ignored", S.composeAmendedPolicy(base, [{ op: "disable", ruleId: "rX" }]) === null);
  check(
    "the composed list is weight-ordered, like the engine sorts",
    S.composeAmendedPolicy(base, [{ op: "reweight", ruleId: "r29", weight: 500 }]).every((r, i, a) => i === 0 || a[i - 1].weight >= r.weight),
  );
  check(
    "the digest is stable over the same list and differs on a change",
    (() => {
      const a = S.composedDigest(base);
      return a === S.composedDigest(base) && a !== S.composedDigest(S.composeAmendedPolicy(base, [{ op: "reweight", ruleId: "r29", weight: 99 }]));
    })(),
  );
  check(
    "the payload round trip: what a proposer writes is what the executor reads",
    (() => {
      const ops = [{ op: "reweight", ruleId: "r29", weight: 40 }];
      return JSON.stringify(S.amendmentFromPayload(S.amendmentVotePayload(ops))) === JSON.stringify(ops);
    })(),
  );
  check("a foreign payload reads as null", S.amendmentFromPayload({ practice: { statement: "x" } }) === null && S.amendmentFromPayload(null) === null);

  // ---- 5. The wiring ----------------------------------------------------------
  const tick = fs.readFileSync("app/api/orchestrator/tick/route.ts", "utf8");
  check(
    "the executor enacts an amendment beside the practice branch",
    /else if \(amendmentFromPayload\(v\.payload \?\? \{\}\)\)/.test(tick) && /adoptSelfPolicy\(sb, v\.payload \?\? \{\}, \{ voteId: v\.id \}\)/.test(tick),
  );
  const types = fs.readFileSync("lib/agents/types.ts", "utf8");
  check("all three topics are in the type union", types.includes('"policy.amended"') && types.includes('"policy.repealed"') && types.includes('"pacing.changed"'));
  const migration = fs.readFileSync("supabase/migrate-self-rule.sql", "utf8");
  check("the migration unions the same three topics", migration.includes("'policy.amended'") && migration.includes("'policy.repealed'") && migration.includes("'pacing.changed'"));
  check("the migration has no agent write policy", !/policy .* on public\.policy_amendments\s+for (insert|update)/i.test(migration));
  const store = fs.readFileSync("lib/swamp/self-policy-store.ts", "utf8");
  check("the store's adoption re-validates through the pure validator", store.includes("amendmentFromPayload(payload)") && store.includes("composeAmendedPolicy(REFLEX_RULES, ops)"));
  const obs = fs.readFileSync("lib/swamp/observations.ts", "utf8");
  check("observations compose the amended list for every default-policy resident", obs.includes("composeAmendedPolicy(REFLEX_RULES, amendmentRows.flatMap((a) => a.ops))"));
  check("the brain publishes the digest over what actually runs", /obs\.policyAmended\s*\?\s*obs\.policyDigest/.test(fs.readFileSync("lib/swamp/brain.ts", "utf8")));
  const actions = fs.readFileSync("lib/agents/actions.ts", "utf8");
  check("self_policy is a registered vote kind", actions.includes('"self_policy"'));

  console.log(failed === 0 ? "\nall self-policy checks pass" : `\n${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
