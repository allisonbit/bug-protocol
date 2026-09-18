#!/usr/bin/env node
/**
 * The doctrine test for the world.
 *
 * The claim this feature makes is narrow and checkable: every body, every pad,
 * every artifact and every bubble corresponds to a row, and the same rows always
 * produce the same world. A drawing is exactly the kind of thing that quietly
 * stops being true, so the claim is asserted here rather than believed.
 *
 * WHAT EACH CHECK IS FOR
 *
 *   totality      a body's form, a zone's id and an event's kind all come from
 *                 closed sets. The TypeScript side enforces this at compile time
 *                 for the mapping (`Record<EventTopic, ...>` is exhaustive), and
 *                 this re-checks it on what the running server actually returns,
 *                 because a row written by a newer writer can still arrive as a
 *                 string nobody anticipated.
 *   citation      every earned trait names the row that granted it. A trait with
 *                 an empty `earnedBy` would be a costume, which is the one thing
 *                 the body ladder promises never to be.
 *   provenance    a zone with no source table cannot exist, and a sealed zone must
 *                 carry the register's own sentence rather than a poetic stand in.
 *   the city      every building cites the row that raised it, stands in a zone
 *                 that exists, and the summary the frame prints agrees with the
 *                 buildings themselves. The city is the part of this feature most
 *                 likely to decay into scenery, because nobody would notice: a
 *                 skyline looks convincing whether or not it means anything, so
 *                 the citation check is the one that matters most here.
 *   the plan      the town stands on a plan of plots in rings, and both readings
 *                 the frame prints - how far it has been built out, and how many
 *                 plots are still open - have to agree with the buildings. A
 *                 district with no plan has nowhere to build; a building outside
 *                 its district's plan is off the map it claims to stand on.
 *   growth        the town only ever grows with the log. A projection at an early
 *                 sequence holds no more buildings, storeys or rings than the
 *                 present one, which is what "the swarm builds" has to mean if it
 *                 means anything: nothing appears in the past that was not there.
 *   determinism   two reads of the same past sequence number agree. This is the
 *                 check that makes replay worth anything: if the projector were
 *                 not pure, a shared link to a moment would render differently for
 *                 every visitor.
 *
 * Usage:
 *   node scripts/verify-world.cjs                 # against http://localhost:3000
 *   node scripts/verify-world.cjs https://www.swampai.world
 */

const FORMS = ["seed", "shard", "drone", "walker", "crane", "oracle"];
const KINDS = ["arrive", "wake", "sleep", "speak", "think", "move", "artifact", "verdict", "disclose", "beam", "meet", "vote", "tip", "milestone", "group", "check", "learn"];
const ZONE_KINDS = ["arrival", "work", "commons", "memory", "governance", "sealed", "built"];
const STRUCTURE_KINDS = ["house", "vault", "lab", "archive", "source", "monument", "hall", "guild", "post"];

const base = process.argv[2] || "http://localhost:3000";
let failures = 0;
let checks = 0;

function check(label, ok, detail) {
  checks++;
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`);
  }
}

async function world(query = "") {
  const res = await fetch(`${base}/api/world/state${query}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} from /api/world/state${query}`);
  return res.json();
}

/** Stable part of a projection: everything except the wall clock. */
function stable(w) {
  return JSON.stringify({ seq: w.seq, zones: w.zones, bodies: w.bodies, groups: w.groups, totals: w.totals, structures: w.structures, city: w.city });
}

(async () => {
  const w = await world();
  console.log(`\nThe world at ${base}\n  seq ${w.seq}, ${w.bodies.length} bodies, ${w.zones.length} zones, ${w.events.length} events\n`);

  // ---- closed sets ---------------------------------------------------------
  const zoneIds = new Set(w.zones.map((z) => z.id));
  const badForm = w.bodies.filter((b) => !FORMS.includes(b.form));
  check("every body's form is one of the six", badForm.length === 0, badForm.map((b) => b.form).join(", "));

  const badZone = w.bodies.filter((b) => !zoneIds.has(b.zone));
  check("every body stands in a zone that exists", badZone.length === 0, badZone.map((b) => `${b.handle}->${b.zone}`).join(", "));

  const badZoneKind = w.zones.filter((z) => !ZONE_KINDS.includes(z.kind));
  check("every zone's kind is from the closed set", badZoneKind.length === 0, badZoneKind.map((z) => z.kind).join(", "));

  const badKind = w.events.filter((e) => !KINDS.includes(e.kind));
  check("every event's visual kind is from the closed set", badKind.length === 0, badKind.map((e) => `${e.topic}:${e.kind}`).join(", "));

  const strayEvent = w.events.filter((e) => !zoneIds.has(e.zone));
  check("every event lands in a zone that exists", strayEvent.length === 0, strayEvent.map((e) => `${e.topic}->${e.zone}`).join(", "));

  const untitled = w.events.filter((e) => !e.label || !e.text);
  check("every event carries a label and a sentence", untitled.length === 0, untitled.map((e) => e.topic).join(", "));

  // ---- citations -----------------------------------------------------------
  const flat = w.bodies.flatMap((b) => b.earned.traits.map((t) => ({ handle: b.handle, ...t })));
  const uncited = flat.filter((t) => !t.earnedBy || String(t.earnedBy).trim().length === 0);
  check(`every earned trait cites its row (${flat.length} traits held)`, uncited.length === 0, uncited.map((t) => `${t.handle}:${t.id}`).join(", "));

  const badTier = w.bodies.filter((b) => b.earned.tier < 0 || b.earned.tier > 5);
  check("every tier is within the ladder", badTier.length === 0, badTier.map((b) => `${b.handle}:${b.earned.tier}`).join(", "));

  const badAura = w.bodies.filter((b) => !(b.aura >= 0 && b.aura <= 1));
  check("aura is a measurement between 0 and 1", badAura.length === 0, badAura.map((b) => `${b.handle}:${b.aura}`).join(", "));

  const badScale = w.bodies.filter((b) => !(b.scale > 0.5 && b.scale < 1.5));
  check("stature stays within a legible range", badScale.length === 0, badScale.map((b) => `${b.handle}:${b.scale}`).join(", "));

  // ---- provenance ----------------------------------------------------------
  const unsourced = w.zones.filter((z) => !z.source || !String(z.source).trim());
  check("every zone names the table it is drawn from", unsourced.length === 0, unsourced.map((z) => z.id).join(", "));

  const sealed = w.zones.filter((z) => z.kind === "sealed");
  check("the boundary is drawn, and is drawn with the register's words", sealed.length === 5 && sealed.every((z) => (z.sealed || "").length > 30), `${sealed.length} sealed zones`);
  check("no body stands inside the sealed boundary", w.bodies.every((b) => !b.zone.startsWith("sealed-")));

  // The one relationship that must hold between the drawing and the counts.
  const drawnRatio = w.totals.agents > 0 ? w.bodies.length / Math.min(w.totals.agents, 400) : 1;
  check("the bodies drawn are the agents that exist", Math.abs(drawnRatio - 1) < 0.001, `${w.bodies.length} drawn of ${w.totals.agents}`);

  // ---- the city ------------------------------------------------------------
  const structures = w.structures || [];
  check(`the city exists and is drawn (${structures.length} buildings)`, Array.isArray(w.structures) && w.structures.length > 0);

  const badKindB = structures.filter((s) => !STRUCTURE_KINDS.includes(s.kind));
  check("every building's kind is from the closed set", badKindB.length === 0, badKindB.map((s) => s.kind).join(", "));

  // The load bearing one. A building with no citation is decoration, and a
  // skyline of decoration is the most persuasive kind of lie a drawing can tell.
  const uncitedB = structures.filter((s) => !s.cites || String(s.cites).trim().length === 0);
  check(`every building cites the row that raised it (${structures.length} buildings)`, uncitedB.length === 0, uncitedB.map((s) => s.id).join(", "));

  const strayBuilding = structures.filter((s) => !zoneIds.has(s.zone));
  check("every building stands in a zone that exists", strayBuilding.length === 0, strayBuilding.map((s) => `${s.id}->${s.zone}`).join(", "));

  const badShape = structures.filter((s) => !(s.floors >= 1 && s.floors <= 12) || !(s.height > 0) || !(s.footprint > 0));
  check("every building has a real shape", badShape.length === 0, badShape.map((s) => `${s.id}:${s.floors}/${s.height}`).join(", "));

  const unlabelled = structures.filter((s) => !s.label || !String(s.label).trim().length);
  check("every building says what it is", unlabelled.length === 0, unlabelled.map((s) => s.id).join(", "));

  // The summary the frame prints has to agree with the buildings themselves, or
  // the number on screen is a claim about the city rather than a reading of it.
  const city = w.city || {};
  const storeys = structures.reduce((n, s) => n + s.floors, 0);
  check("the city's building count is the buildings", city.buildings === structures.length, `${city.buildings} vs ${structures.length}`);
  check("the city's storey count is the storeys", city.storeys === storeys, `${city.storeys} vs ${storeys}`);
  const byKind = {};
  for (const s of structures) byKind[s.kind] = (byKind[s.kind] || 0) + 1;
  const kindMismatch = STRUCTURE_KINDS.filter((k) => (city.byKind?.[k] || 0) !== (byKind[k] || 0));
  check("the city's per kind counts are the per kind counts", kindMismatch.length === 0, kindMismatch.join(", "));

  // ---- the plan ------------------------------------------------------------
  const zoneById = new Map(w.zones.map((z) => [z.id, z]));
  const planned = w.zones.filter((z) => z.kind !== "sealed");
  check(`the plan makes room to build (${city.plots} plots across ${planned.length} districts)`, city.plots > 0, String(city.plots));
  check(
    "the open plots are the plots not yet built on",
    city.frontier === Math.max(0, city.plots - structures.length) || w.capped.structures != null,
    `${city.frontier} open, ${city.plots} planned, ${structures.length} built`,
  );
  check("no building stands outside its district's plan", structures.every((s) => {
    const zone = zoneById.get(s.zone);
    if (!zone) return false;
    // The plan reaches its district's radius plus the neighbourhood allowed around it.
    return Math.hypot(s.position.x - zone.position.x, s.position.z - zone.position.z) <= zone.radius + 3.1;
  }));
  const deepestRing = structures.reduce((m, s) => Math.max(m, s.ring ?? 0), 0);
  check(
    `the town is built out to the ring it is drawn to (ring ${city.phase + 1} of the plan)`,
    city.phase === deepestRing,
    `phase=${city.phase} deepest=${deepestRing}`,
  );

  // The cap must be stated exactly when it bites, never one and not the other.
  check(
    "the building cap is stated when and only when it bites",
    (w.capped.structures == null) === (city.hidden === 0),
    `capped=${w.capped.structures} hidden=${city.hidden}`,
  );

  // Every agent lives somewhere. This is the invariant that makes "new and old
  // agents keep building" true rather than a slogan: a house appears on arrival
  // and grows with the tier, so the count is the roster.
  if (w.capped.structures == null) {
    const houses = structures.filter((s) => s.kind === "house");
    check(`every registered agent has a house (${houses.length} houses, ${w.totals.agents} agents)`, houses.length === w.totals.agents, `${houses.length} vs ${w.totals.agents}`);
    const houseCites = new Set(houses.map((s) => s.cites));
    check("every house cites its agent", houseCites.size === houses.length, "two houses share one citation");
  }

  // ---- determinism: the reason replay works ---------------------------------
  //
  // Read the same past sequence twice. An hour of daylight between the sequence
  // and now is deliberate: speech and meeting windows are measured against the
  // clock, so testing at the very edge of one would be testing the window rather
  // than the projector.
  const past = await world("?seq=1");
  const twice = [await world("?seq=1"), await world("?seq=1")];
  const same = stable(twice[0]) === stable(twice[1]);
  check("the same sequence projects the same world twice", same, same ? "" : "projections differ");
  check("a rewind stops at the sequence it was asked for", twice[0].seq <= 1, `got seq ${twice[0].seq}`);
  check("a rewind folds no event newer than the sequence", twice[0].events.every((e) => e.seq <= 1), "an event newer than the bound was folded");

  // ---- replay is monotone in the log ---------------------------------------
  const mid = w.events.length > 4 ? w.events[Math.floor(w.events.length / 2)].seq : null;
  if (mid != null) {
    const atMid = await world(`?seq=${mid}`);
    check(`a projection at seq ${mid} folds nothing after it`, atMid.events.every((e) => e.seq <= mid) && atMid.seq === mid, `seq ${atMid.seq}`);
    check(`a projection at seq ${mid} holds no more bodies than now`, atMid.bodies.length <= w.bodies.length + 0, `${atMid.bodies.length} vs ${w.bodies.length}`);

    // Growth. The city at an earlier moment cannot be larger than the city now:
    // a building that was not yet raised is not in the past, and a storey that had
    // not been earned is not in the past either. This is the check that keeps the
    // city from being a skyline generated to look busy.
    check(
      `the town at seq ${mid} is no larger and no further out than it is now`,
      (atMid.city?.buildings ?? 0) <= (city.buildings ?? 0) &&
        (atMid.city?.storeys ?? 0) <= (city.storeys ?? 0) &&
        (atMid.city?.phase ?? 0) <= (city.phase ?? 0),
      `${atMid.city?.buildings}/${atMid.city?.storeys}/ring${atMid.city?.phase} at ${mid} vs ${city.buildings}/${city.storeys}/ring${city.phase} now`,
    );
  }

  // The earliest moment there is nothing to have built yet. Whatever else is
  // drawn, it must not be a city that predates its own rows.
  const dawn = await world("?seq=1");
  check("at the first row the city is no larger than it is now", (dawn.city?.buildings ?? 0) <= (city.buildings ?? 0), `${dawn.city?.buildings} vs ${city.buildings}`);
  const dawnUncited = (dawn.structures || []).filter((s) => !s.cites || !String(s.cites).trim());
  check("even at the first row every building cites its row", dawnUncited.length === 0, dawnUncited.map((s) => s.id).join(", "));

  // ---- a bad input is refused, not guessed at ------------------------------
  const bad = await fetch(`${base}/api/world/state?seq=later`, { cache: "no-store" });
  check("a non-numeric sequence is refused rather than ignored", bad.status === 400, `HTTP ${bad.status}`);

  console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ""}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error(`\nverify-world could not run: ${err.message}\n`);
  process.exit(1);
});
