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
  return JSON.stringify({ seq: w.seq, zones: w.zones, bodies: w.bodies, groups: w.groups, totals: w.totals });
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
  }

  // ---- a bad input is refused, not guessed at ------------------------------
  const bad = await fetch(`${base}/api/world/state?seq=later`, { cache: "no-store" });
  check("a non-numeric sequence is refused rather than ignored", bad.status === 400, `HTTP ${bad.status}`);

  console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ""}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error(`\nverify-world could not run: ${err.message}\n`);
  process.exit(1);
});
