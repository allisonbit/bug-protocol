#!/usr/bin/env node
/**
 * Does a built room hold anything, and does a fixture stand where its author put it?
 *
 * WHY THIS EXISTS. The swarm raised `security-research` and `literature` by vote,
 * and both stood empty: the town routed every building through a fixed map, so a
 * fact went to the Vaults whether or not a district had been founded for the work
 * behind it, and nothing in the schema could stand a thing in a room an agent chose.
 * Building ground therefore bought a name on a map. This pins the two halves that
 * fixed that, and it is the check that would have failed for the entire history of
 * the feature before this change.
 *
 * `buildCity` is PURE, which is what makes this a unit test rather than an
 * integration one: a handful of rows in, a town out, no database and no clock. Each
 * case passes rows of ONE kind, so a failure names the routing rule it came from.
 *
 * This file is a TEST, not a fence. It runs on an operator's machine and no agent
 * ever touches it: nothing here gates a door, and nothing an agent may do changes
 * because these assertions exist. What it protects is the opposite direction: a
 * room that stands empty while the work it was founded for sits in the Vaults, and
 * a fixture that quietly vanishes because its room was withdrawn.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-rooms.cjs
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

/** The nine starting places, cut down to the two a case needs plus a plan to stand on. */
function startingZones() {
  return [
    { id: "vaults", name: "The Vaults", source: "memory_facts", kind: "memory", position: { x: 0, y: 0, z: 0 }, radius: 3.4 },
    { id: "docks", name: "The Docks", source: "agents", kind: "arrival", position: { x: 0, y: 0, z: -13 }, radius: 3.4 },
    { id: "archive", name: "The Archive", source: "outputs", kind: "work", position: { x: 13, y: 0, z: 0 }, radius: 3.4 },
  ];
}

const ROOM = {
  id: "literature",
  name: "Literature",
  source: "world_zones (built by vote v1)",
  kind: "built",
  position: { x: -19, y: 0, z: 4 },
  radius: 3.2,
  built: true,
  scope: "literature",
  purpose: "Work in literature, with no place standing for it.",
};

/** The same room before a scope was declared: ground that claims nothing. */
const UNSCOPED_ROOM = { ...ROOM, id: "commons", name: "The Commons", scope: null };

/** A room somebody asked for that the vote has not built; the loader never emits one. */
const UNBUILT_ROOM = { ...ROOM, id: "proposed-place", built: undefined, status: "proposed" };

const FACT = (domain) => ({ source_agent: null, key: `literature:${domain ?? "none"}`, domain });
const HYPOTHESIS = (domain) => ({ id: `h-${domain ?? "none"}`, claim: "A question", proposed_by: null, resolved_by: null, status: "open", domain });

const FIXTURE = (id, zone, url = null) => ({
  id,
  zone,
  handle: "builder",
  name: `Thing ${id}`,
  what: "What it actually is.",
  url,
  created_at: "2026-09-20T09:00:00.000Z",
});

async function main() {
  const city = await import(pathToFileURL(path.join(process.cwd(), "lib", "world", "city.ts")).href);

  const full = {
    zones: [...startingZones(), ROOM],
    agents: [],
    targets: [],
    claims: [],
    cabals: [],
    members: [],
    findings: [],
    outputs: [],
    sources: [],
    facts: [],
    hypotheses: [],
    fixtures: [],
    rooms: [],
    bodies: [],
    machines: [],
    alerts: [],
    now: Date.now(),
    totals: { facts: 0, hypotheses: 0, skills: 0 },
  };
  const build = (patch) => city.buildCity({ ...full, ...patch });
  const of = (result, kind) => result.structures.filter((s) => s.kind === kind);

  // ── the scope is what fills a room ────────────────────────────────────────
  console.log("== a room holds the work its scope claims ==");
  const housedFacts = of(build({ facts: [FACT("literature")] }), "vault");
  say(
    housedFacts.length === 1 && housedFacts[0].zone === ROOM.id,
    "a fact filed under a room's scope stands in that room",
    housedFacts[0] ? `${housedFacts[0].zone} (founded for ${ROOM.scope})` : "nothing built",
  );
  const strayFact = of(build({ facts: [FACT("law")] }), "vault");
  say(
    strayFact.length === 1 && strayFact[0].zone === "vaults",
    "a fact in a scope no room claims stands where its kind goes",
    strayFact[0]?.zone,
  );
  const housedQuestion = of(build({ hypotheses: [HYPOTHESIS("literature")] }), "lab");
  say(
    housedQuestion.length === 1 && housedQuestion[0].zone === ROOM.id,
    "a question in that scope stands there too",
    housedQuestion[0]?.zone,
  );
  const caseless = of(build({ facts: [FACT("Literature")] }), "vault");
  say(
    caseless.length === 1 && caseless[0].zone === ROOM.id,
    "the match is on the scope rather than on how somebody spelled it",
    caseless[0]?.zone,
  );

  // ── ground that claims nothing takes nothing ──────────────────────────────
  console.log("\n== ground that claims nothing stays open ==");
  const unscoped = of(build({ zones: [...startingZones(), UNSCOPED_ROOM], facts: [FACT("literature")] }), "vault");
  say(
    unscoped.length === 1 && unscoped[0].zone === "vaults",
    "a room with no scope does not quietly absorb the work of a scope nobody declared",
    unscoped[0]?.zone,
  );
  const unbuilt = of(build({ zones: [...startingZones(), ROOM, UNBUILT_ROOM], facts: [FACT("proposed-place")] }), "vault");
  say(
    unbuilt.length === 1 && unbuilt[0].zone === "vaults",
    "a room that is proposed rather than built claims nothing",
    unbuilt[0]?.zone,
  );

  // ── a fixture stands where its author put it ──────────────────────────────
  console.log("\n== a fixture stands in the room it names ==");
  const built = of(build({ fixtures: [FIXTURE("f1", ROOM.id, "https://example.org/x")] }), "fixture");
  say(built.length === 1, "a thing an agent built is drawn", built.length ? built[0].cites : "nothing drawn");
  say(
    built.length === 1 && built[0].zone === ROOM.id,
    "it stands in the room its author chose, not the district for its kind",
    built[0]?.zone,
  );
  say(
    built.length === 1 && built[0].cites === "room_fixtures:f1",
    "it cites its own row, which is what makes it clickable",
    built[0]?.cites,
  );
  say(
    built.length === 1 && built[0].href === "https://example.org/x",
    "it opens what its author said it was",
    built[0]?.href,
  );
  say(
    built.length === 1 && built[0].floors === 2 && built[0].lit === true,
    "a thing that names an address stands two storeys and lit",
    built[0] ? `${built[0].floors} storeys, lit=${built[0].lit}` : "nothing drawn",
  );
  const described = of(build({ fixtures: [FIXTURE("f2", ROOM.id)] }), "fixture");
  say(
    described.length === 1 && described[0].floors === 1 && described[0].lit === false,
    "a description is drawn one storey and dark, because there is nowhere to go and look",
    described[0] ? `${described[0].floors} storeys, lit=${described[0].lit}` : "nothing drawn",
  );
  say(
    described.length === 1 && described[0].label === "Thing f2",
    "the world prints the name its author gave it",
    described[0]?.label,
  );

  // ── a fixture whose ground is gone does not vanish ────────────────────────
  console.log("\n== a withdrawn room does not take its fixtures with it ==");
  const orphan = of(build({ fixtures: [FIXTURE("f3", "somewhere-gone")] }), "fixture");
  say(
    orphan.length === 1 && orphan[0].zone === "docks",
    "a fixture whose room is not in the drawing stands somewhere rather than nowhere",
    orphan[0]?.zone,
  );
  say(
    orphan.length === 1 && orphan[0].cites === "room_fixtures:f3",
    "and still cites the row that raised it",
    orphan[0]?.cites,
  );

  // ── two rooms, and the work decides which one ──────────────────────────────
  console.log("\n== two rooms, two scopes ==");
  const law = { ...ROOM, id: "law", name: "Law", position: { x: -19, y: 0, z: -9 }, scope: "law" };
  const both = build({
    zones: [...startingZones(), ROOM, law],
    facts: [FACT("literature"), FACT("law")],
    fixtures: [FIXTURE("f1", "law")],
  });
  const vaults = of(both, "vault");
  say(
    vaults.length === 2 && vaults.map((s) => s.zone).sort().join(",") === "law,literature",
    "each fact stands in its own district",
    vaults.map((s) => `${s.cites}->${s.zone}`).join(", "),
  );
  say(
    of(both, "fixture")[0]?.zone === "law",
    "and a fixture goes where its author said, whatever the scope says",
    of(both, "fixture")[0]?.zone,
  );

  // ── the town is still a pure function of its rows ─────────────────────────
  console.log("\n== the drawing is still deterministic ==");
  const twice = [build({ facts: [FACT("literature")], fixtures: [FIXTURE("f1", ROOM.id)] }), build({ facts: [FACT("literature")], fixtures: [FIXTURE("f1", ROOM.id)] })];
  say(
    JSON.stringify(twice[0].structures) === JSON.stringify(twice[1].structures),
    "the same rows raise the same buildings twice",
  );
  const kinds = new Set(both.structures.map((s) => s.kind));
  say(
    [...kinds].every((k) => city.STRUCTURE_SOURCES.some((s) => s.kind === k)),
    "every kind drawn is a kind the town can explain",
    [...kinds].join(", "),
  );
  say(
    city.STRUCTURE_SOURCES.some((s) => s.kind === "fixture"),
    "and /world has words for a fixture rather than an unexplained building",
  );

  console.log(failed === 0 ? "\nrooms: all checks passed" : `\nrooms: ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
