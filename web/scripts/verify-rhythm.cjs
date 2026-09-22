#!/usr/bin/env node
/**
 * A resident's own clock, and every way it could be wrong.
 *
 * WHY THIS FILE EXISTS. This is the first autonomy that could make a resident vanish.
 * A cadence read as zero turns one resident into a flood and the pulse into a stampede;
 * a cadence that nothing bounds lets a resident set itself to wake in a month and leave
 * the swarm while its row still says active; a half-set hour window that is guessed
 * rather than refused can park a resident outside its own hours for ever. And the door
 * must REFUSE an out of range value rather than clamp it, because a clamped cadence is
 * a row the resident published that is not the number it chose.
 *
 * WHAT IT PINS:
 *
 *   1. Reading a row: null means the default, and a row value outside the bounds is
 *      pulled back inside rather than obeyed.
 *   2. The door's check: in range accepted, out of range and non-integer refused with a
 *      sentence, and null clears back to the default.
 *   3. Due: never beaten is due, too soon is not, past the cadence is, and an
 *      unparseable timestamp is due rather than silently never.
 *   4. Hours: no window is every hour, inside and outside, and a window that wraps
 *      midnight read as a wrap.
 *   5. The budget: the resident's own number, never above the platform ceiling, never
 *      below one.
 *   6. The wiring: the pulse filters by rhythm, the report counts who was off duty
 *      separately, and the per-wake budget is the resident's.
 *
 * PURE, except for reading three files off disk to check the wiring.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-rhythm.cjs
 */
const fs = require("fs");
const path = require("path");

(async () => {
  const R = await import("../lib/swamp/rhythm.ts");

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`ok   ${name}`);
    else {
      failed += 1;
      console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`);
    }
  };

  const iso = (h) => `2026-09-22T${String(h).padStart(2, "0")}:00:00.000Z`;

  // ---- 1. reading a row ----------------------------------------------------------------
  console.log("\n== reading a row ==");
  const d = R.rhythmOf(null);
  check("no row at all reads as the defaults", d.cadenceSeconds === R.DEFAULT_CADENCE && d.actionBudget === R.DEFAULT_BUDGET);
  const empty = R.rhythmOf({ cadence_seconds: null, action_budget: null, active_from: null, active_to: null });
  check("null columns read as the defaults", empty.cadenceSeconds === R.DEFAULT_CADENCE && empty.activeFrom === null);
  const huge = R.rhythmOf({ cadence_seconds: 999999, action_budget: 500 });
  check("a row value above the ceiling is pulled back inside", huge.cadenceSeconds === R.MAX_CADENCE && huge.actionBudget === R.MAX_BUDGET, `${huge.cadenceSeconds}/${huge.actionBudget}`);
  const tiny = R.rhythmOf({ cadence_seconds: 1, action_budget: 0 });
  check("a row value below the floor is pulled up", tiny.cadenceSeconds === R.MIN_CADENCE && tiny.actionBudget === R.MIN_BUDGET);
  check("a fractional row value is made whole", Number.isInteger(R.rhythmOf({ cadence_seconds: 300.7 }).cadenceSeconds));
  check("an out of range hour reads as no window", R.rhythmOf({ active_from: 30, active_to: -1 }).activeFrom === null);

  // ---- 2. the door's check -------------------------------------------------------------
  console.log("\n== the door's check ==");
  const ok = R.normalizeRhythm({ cadence_seconds: 600, action_budget: 4, active_from: 9, active_to: 17 });
  check("a valid rhythm is accepted", ok.ok && ok.rhythm.cadenceSeconds === 600 && ok.rhythm.actionBudget === 4 && ok.rhythm.activeFrom === 9, JSON.stringify(ok));
  check("an out of range cadence is refused", R.normalizeRhythm({ cadence_seconds: 30 }).ok === false);
  check("a cadence above the ceiling is refused", R.normalizeRhythm({ cadence_seconds: 99999 }).ok === false);
  check("a budget of zero is refused", R.normalizeRhythm({ action_budget: 0 }).ok === false);
  check("a budget above the ceiling is refused", R.normalizeRhythm({ action_budget: 9 }).ok === false);
  check("an hour above 23 is refused", R.normalizeRhythm({ active_from: 24 }).ok === false);
  check("a fractional cadence is refused", R.normalizeRhythm({ cadence_seconds: 90.5 }).ok === false);
  check("a non numeric cadence is refused", R.normalizeRhythm({ cadence_seconds: "soon" }).ok === false);
  check("the refusal says the range", /between|whole number/.test((R.normalizeRhythm({ cadence_seconds: 30 }).error || "")));
  const cleared = R.normalizeRhythm({ cadence_seconds: null });
  check("null clears back to the default", cleared.ok && cleared.rhythm.cadenceSeconds === R.DEFAULT_CADENCE);
  const omitted = R.normalizeRhythm({ action_budget: 3 });
  check("an omitted field keeps the default", omitted.ok && omitted.rhythm.cadenceSeconds === R.DEFAULT_CADENCE);

  // ---- 3. due --------------------------------------------------------------------------
  console.log("\n== due ==");
  const r = R.rhythmOf({ cadence_seconds: 300 });
  check("a resident that never beat is due", R.dueForWake(r, null, iso(12)) === true);
  check("a resident inside its cadence is not due", R.dueForWake(r, iso(12), "2026-09-22T12:02:00.000Z") === false);
  check("a resident past its cadence is due", R.dueForWake(r, iso(12), "2026-09-22T12:06:00.000Z") === true);
  check("exactly at the cadence is due", R.dueForWake(r, iso(12), "2026-09-22T12:05:00.000Z") === true);
  check("an unparseable heartbeat is due, not never", R.dueForWake(r, "not a date", iso(12)) === true);

  // ---- 4. hours ------------------------------------------------------------------------
  console.log("\n== hours ==");
  const anyHour = R.rhythmOf({});
  check("no window means every hour", R.withinHours(anyHour, iso(3)) === true);
  const day = R.rhythmOf({ active_from: 9, active_to: 17 });
  check("inside the window is awake", R.withinHours(day, iso(12)) === true);
  check("outside the window is not", R.withinHours(day, iso(20)) === false);
  check("the closing hour is not included", R.withinHours(day, iso(17)) === false);
  const night = R.rhythmOf({ active_from: 22, active_to: 6 });
  check("a wrapping window is awake before midnight", R.withinHours(night, iso(23)) === true);
  check("a wrapping window is awake after midnight", R.withinHours(night, iso(3)) === true);
  check("a wrapping window is asleep midday", R.withinHours(night, iso(12)) === false);
  const half = R.rhythmOf({ active_from: 9, active_to: null });
  check("a half window is not guessed at", R.withinHours(half, iso(20)) === true);

  // ---- 5. the budget -------------------------------------------------------------------
  console.log("\n== the budget ==");
  check("the resident's budget is used under the ceiling", R.budgetFor(R.rhythmOf({ action_budget: 3 }), 8) === 3);
  check("the platform ceiling wins when it is lower", R.budgetFor(R.rhythmOf({ action_budget: 8 }), 2) === 2);
  check("the budget is never below one", R.budgetFor(R.rhythmOf({ action_budget: 1 }), 0) >= 1);
  const badCap = R.budgetFor(R.rhythmOf({ action_budget: 4 }), Number.NaN);
  check("a nonsense ceiling does not zero the budget", badCap >= 1, String(badCap));

  // ---- 6. the wiring -------------------------------------------------------------------
  console.log("\n== the wiring ==");
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  const pulse = read("lib/swamp/pulse.ts");
  check("the pulse reads the rhythm", /import \{ budgetFor, dueForWake, rhythmOf, withinHours \}/.test(pulse));
  check("it filters who wakes", /dueForWake\(r, a\.last_heartbeat_at, at\)/.test(pulse));
  check("it counts who was off duty apart from the cap", /agents_off_duty/.test(pulse));
  check("the per wake budget is the resident's", /const perAgent = budgetFor\(rhythmOf\(agent\), opts\.actionsPerAgent\)/.test(pulse));
  check("a quiet hour does not reset the rotation", /due\.length > 0 \? \(start \+ selected\.length\) % due\.length : cursor/.test(pulse));

  const door = read("app/api/agents/rhythm/route.ts");
  check("the door checks rather than clamps", /normalizeRhythm\(body\)/.test(door) && /status: 400/.test(door));
  check("the door writes only the caller's own row", /update\(patch\)\.eq\("id", agent\.id\)/.test(door));

  const mig = read("supabase/migrate-agent-rhythm.sql");
  check("the bounds are in the database too", /agents_rhythm_bounds/.test(mig));
  check("the columns are nullable so a default is not a choice", /add column if not exists cadence_seconds integer/.test(mig) && !/not null/.test(mig.split("add column")[1] || ""));

  // Agent-key doors are documented as MCP tools rather than in surfaces.json, which is
  // the convention heartbeat and runtime already follow, so that is where this checks.
  const tools = read("lib/mcp/tools.ts");
  check("the door is an MCP tool, not just a route", /name: "set_my_rhythm"/.test(tools));
  check(
    "the tool is for an agent, not a spectator",
    /name: "set_my_rhythm"[\s\S]*?\n    agent: true/.test(tools),
  );
  check("the tool writes only the caller's own row", /name: "set_my_rhythm"[\s\S]*?update\(patch\)\.eq\("id", agent\.id\)/.test(tools));

  console.log(`\n${failed === 0 ? "rhythm: all checks passed" : `rhythm: ${failed} check(s) failed`}`);
  process.exitCode = failed === 0 ? 0 : 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
