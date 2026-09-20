#!/usr/bin/env node
/**
 * Does every scheduled job use the verb its route actually acts on?
 *
 * WHY THIS EXISTS SEPARATELY FROM THE GUARD ITSELF. `schedule-beat.cjs` already
 * refuses to install a mismatched job, and that is the check that matters
 * operationally. But a guard and the thing it guards can be wrong together: if
 * somebody later "fixes" `actingMethod` to compare against the export list again,
 * the installer would happily accept the wrong table, and the only symptom would be
 * a beat that answers 200 and does nothing — the failure this whole mechanism was
 * built to stop. So the interesting cases are pinned here, including the one that
 * defeated the first version of the guard.
 *
 * No database, no network, no scheduling: `schedule-beat.cjs` is imported for its
 * functions only, because its main body runs behind `require.main === module`.
 *
 *   node scripts/verify-beat-verbs.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const { JOBS, verifyJobMethods, actingMethod, exportedMethods } = require("./schedule-beat.cjs");

let failed = 0;
const say = (ok, label, detail) => {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};
const throws = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e.message;
  }
};

// 1) The real table must pass, and each route must act on the verb its job uses.
console.log("== the table as it stands ==");
const tableError = throws(() => verifyJobMethods());
say(!tableError, `every job matches its route's acting verb`, tableError ?? `(${JOBS.length} jobs)`);
for (const job of JOBS) {
  const acts = actingMethod(job.path);
  say(acts === (job.method || "GET"), `${job.name} acts on ${acts}`, job.path);
}

// 2) The bug that shipped: a POST-acting route whose job says GET. A POST-acting
//    route still exports GET, so this must not be decided by the export list.
console.log("== a POST-acting route scheduled as GET ==");
for (const name of ["swamp-beat-skills", "swamp-beat-listings"]) {
  const broken = JOBS.map((j) => (j.name === name ? { ...j, method: undefined } : j));
  const err = throws(() => verifyJobMethods(broken));
  say(Boolean(err), `${name} with no method is refused`, err ?? "NOT REFUSED");
}

// 3) The export list is genuinely ambiguous, so the check cannot be that.
const route = path.join(__dirname, "..", "app", "api", "skills", "publish", "route.ts");
const exported = exportedMethods(fs.readFileSync(route, "utf8"));
say(
  exported.includes("GET") && exported.includes("POST"),
  "skills/publish exports both GET and POST, yet acts only on POST",
  `exports ${exported.join("/")}, acts on ${actingMethod("/api/skills/publish")}`,
);

// 4) The opposite direction.
const asPost = JOBS.map((j) => (j.name === "swamp-beat-pulse" ? { ...j, method: "POST" } : j));
say(Boolean(throws(() => verifyJobMethods(asPost))), "a GET-acting route scheduled as POST is refused");

// 5) A job pointing at a route that is not there.
say(
  Boolean(throws(() => verifyJobMethods([{ name: "ghost", path: "/api/nope", method: "GET" }]))),
  "a job for a route file that does not exist is refused",
);

console.log(failed === 0 ? "\nbeat verbs: all checks passed" : `\nbeat verbs: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
