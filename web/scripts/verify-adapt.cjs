#!/usr/bin/env node
/**
 * The one place an adopted lesson moves anything, and every way it could move too much.
 *
 * WHY THIS FILE EXISTS. This is the only code on the platform that lets something the
 * swarm concluded change how a resident runs, so every quiet failure here is a safety
 * failure rather than a cosmetic one. A rule pushed below the floor stops firing and the
 * deployment silently loses a capability. A lesson about a rule that is not in the list
 * must change nothing rather than throw. And the adjustment MUST reverse itself when a
 * lesson is refuted, or the swarm accumulates drift that nobody decided and nobody can
 * unwind, which is the exact opposite of a bounded self-tuning loop.
 *
 * WHAT IT PINS:
 *
 *   1. Nothing adopted means the rules come back identical, in the same order.
 *   2. A barren-rule lesson lowers exactly that rule, and the ordering that results is
 *      the one the engine will actually use.
 *   3. The kinds that are not the rule's fault are ignored: a silent rule, a degraded
 *      brain, and a lesson naming a rule that is not in the list.
 *   4. Bounds: one move per rule however many lessons name it, the floor is a low
 *      priority and never an off switch, the per-beat cap holds, and the input array is
 *      not mutated.
 *   5. Reversal: remove the lesson and the weights are back to what the agent wrote.
 *   6. The wiring: the brain applies it on both reflex paths and the span carries which
 *      rules moved.
 *
 * PURE, except for reading two files off disk to check the wiring.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-adapt.cjs
 */
const fs = require("fs");
const path = require("path");

(async () => {
  const A = await import("../lib/swamp/adapt.ts");

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`ok   ${name}`);
    else {
      failed += 1;
      console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`);
    }
  };

  const rule = (id, weight, intent = "post_to_board") => ({ id, when: "always", intent, weight });
  const lesson = (id, kind, subject) => ({
    id,
    kind,
    subject,
    statement: "a sentence",
    confidence: 80,
    status: "adopted",
    evidence: {},
    evidence_hash: "h",
  });

  // Weights spaced the way the published policy actually spaces them, two apart in the
  // middle band, so the ordering checks below exercise the real decision rather than a
  // fixture with a gap wider than the step.
  const base = [rule("r1", 50), rule("r2", 48), rule("r3", 46), rule("r4", 44)];

  // ---- 1. nothing adopted --------------------------------------------------------------
  console.log("\n== nothing adopted ==");
  const none = A.adaptRules(base, []);
  check("no lessons means no adjustments", none.adjustments.length === 0, JSON.stringify(none.adjustments));
  check("and the rules come back equal in value", JSON.stringify(none.rules) === JSON.stringify(base));

  const notAdopted = A.adaptRules(base, [lesson("l1", "rule_barren", "r2")]);
  check("a lesson that is simply passed in is applied (the caller filters to adopted)", notAdopted.adjustments.length === 1);

  // ---- 2. a barren rule moves down -----------------------------------------------------
  console.log("\n== a barren rule moves down ==");
  const one = A.adaptRules(base, [lesson("l1", "rule_barren", "r1")]);
  check("exactly one rule is adjusted", one.adjustments.length === 1, JSON.stringify(one.adjustments));
  const r1 = one.rules.find((r) => r.id === "r1");
  check("the named rule is lowered by the step", r1.weight === 50 - A.ADAPT_STEP, String(r1.weight));
  check("the adjustment records before and after", one.adjustments[0].before === 50 && one.adjustments[0].after === 50 - A.ADAPT_STEP, JSON.stringify(one.adjustments[0]));
  check("the adjustment names the lesson that moved it", one.adjustments[0].lessonId === "l1");

  const others = one.rules.filter((r) => r.id !== "r1");
  check("no other rule is touched", others.every((r) => base.find((b) => b.id === r.id).weight === r.weight));
  check("the array order is unchanged", one.rules.map((r) => r.id).join(",") === "r1,r2,r3,r4");

  // the actual effect: the engine sorts by weight descending, so r1 now runs AFTER r2
  const orderOf = (rules) => [...rules].map((r, i) => [r, i]).sort((a, b) => b[0].weight - a[0].weight || a[1] - b[1]).map(([r]) => r.id);
  check("before: r1 outranks r2", orderOf(base).indexOf("r1") < orderOf(base).indexOf("r2"));
  check("after: r2 runs before r1", orderOf(one.rules).indexOf("r2") < orderOf(one.rules).indexOf("r1"), orderOf(one.rules).join(","));

  // ---- 3. the kinds that are not the rule's fault --------------------------------------
  console.log("\n== kinds and subjects that must change nothing ==");
  check("a silent rule is not punished", A.adaptRules(base, [lesson("l1", "rule_silent", "r1")]).adjustments.length === 0);
  check("a degraded brain is not a rule", A.adaptRules(base, [lesson("l1", "brain_degraded", "resident-a")]).adjustments.length === 0);
  check("a lesson about a rule not in the list changes nothing", A.adaptRules(base, [lesson("l1", "rule_barren", "r99")]).adjustments.length === 0);
  check("a malformed subject changes nothing", A.adaptRules(base, [lesson("l1", "rule_barren", "")]).adjustments.length === 0);
  check("an empty rule list is handled", A.adaptRules([], [lesson("l1", "rule_barren", "r1")]).adjustments.length === 0);

  // ---- 4. bounds -----------------------------------------------------------------------
  console.log("\n== bounds ==");
  const many = A.adaptRules(base, [
    lesson("l1", "rule_barren", "r1"),
    lesson("l2", "rule_barren", "r1"),
    lesson("l3", "rule_barren", "r1"),
  ]);
  check(
    "five lessons about one rule move it once, not five times",
    many.rules.find((r) => r.id === "r1").weight === 50 - A.ADAPT_STEP,
    JSON.stringify(many.rules),
  );

  const atFloor = [rule("r1", A.ADAPT_FLOOR)];
  const floored = A.adaptRules(atFloor, [lesson("l1", "rule_barren", "r1")]);
  check("a rule already at the floor is not moved below it", floored.rules[0].weight === A.ADAPT_FLOOR, String(floored.rules[0].weight));
  check("and produces no adjustment row", floored.adjustments.length === 0, JSON.stringify(floored.adjustments));

  const nearFloor = A.adaptRules([rule("r1", A.ADAPT_FLOOR + 5)], [lesson("l1", "rule_barren", "r1")]);
  check("a rule near the floor clamps to the floor, never below", nearFloor.rules[0].weight === A.ADAPT_FLOOR, String(nearFloor.rules[0].weight));

  const wide = [rule("a", 100), rule("b", 100), rule("c", 100)];
  const capped = A.adaptRules(wide, [lesson("l1", "rule_barren", "a"), lesson("l2", "rule_barren", "b"), lesson("l3", "rule_barren", "c")], { max: 2 });
  check("the per-beat cap holds", capped.adjustments.length === 2, String(capped.adjustments.length));

  const before = JSON.stringify(base);
  A.adaptRules(base, [lesson("l1", "rule_barren", "r1")]);
  check("the input array is not mutated", JSON.stringify(base) === before);

  // ---- 5. reversal ---------------------------------------------------------------------
  console.log("\n== it reverses itself ==");
  const adopted = [lesson("l1", "rule_barren", "r2")];
  const applied = A.adaptRules(base, adopted);
  check("while adopted, r2 is lowered", applied.rules.find((r) => r.id === "r2").weight === 48 - A.ADAPT_STEP);
  const refuted = A.adaptRules(base, []);
  check("once it is not adopted, the weight is the agent's own again", JSON.stringify(refuted.rules) === JSON.stringify(base));

  // ---- 6. the wiring -------------------------------------------------------------------
  console.log("\n== the wiring ==");
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  const brain = read("lib/swamp/brain.ts");
  check("the brain imports the tuning", /import \{ adaptRules/.test(brain));
  check("the reflex path applies it", /adaptRules\(rules, obs\.lessons\.adopted\)/.test(brain));
  check("the plan can carry what moved", /adapted\?: RuleAdjustment\[\]/.test(brain));
  const pulse = read("lib/swamp/pulse.ts");
  check("the span records which rules moved", /swamp\.rules\.adapted/.test(pulse));
  check("and only when something moved", /decision\.adapted && decision\.adapted\.length > 0/.test(pulse));

  console.log(`\n${failed === 0 ? "adapt: all checks passed" : `adapt: ${failed} check(s) failed`}`);
  process.exitCode = failed === 0 ? 0 : 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
