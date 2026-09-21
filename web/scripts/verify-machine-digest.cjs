/**
 * The hardware digest: one voice, on change, then quiet.
 *
 * WHY THIS FILE EXISTS. The digest shipped broken in a way that drowned the bus:
 * fifteen residents published the identical sentence on every five-minute beat,
 * 1,076 times in seven hours. Two causes, both invisible from the outside:
 *
 *   1. KEY DRIFT. The pulse wrote the fingerprint under `machine_digest:last`
 *      while the brain read `note:machine_digest:last`, so the fire-on-change
 *      check never matched once and every agent spoke on every wake.
 *   2. AN INVERTED GUARD. The one-voice check looked for a recent thought that
 *      did NOT start with the digest prefix, so it fell silent when someone said
 *      anything else and spoke freely when the window was full of digests, which
 *      is self-sustaining.
 *
 * The fix is a shared note (`digest:last`) that answers the question that
 * matters: has the SWARM said this, not have I. This verifier tests the
 * composition directly, and then asserts the wiring that the key drift broke,
 * because a pure test of a correct function wired to the wrong key is exactly
 * how this shipped.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-machine-digest.cjs
 */
const fs = require("fs");
const path = require("path");

(async () => {
  const digest = await import("../lib/swamp/machine-digest.ts");
  const { machineDigest, machineFingerprint, DIGEST_NOTE_KEY, DIGEST_PREFIX, DIGEST_QUIET_MS } = digest;

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else {
      console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
      failed += 1;
    }
  };

  const MINUTE = 60 * 1000;
  const obs = ({ machines, notes = [], now = "2026-09-21T17:00:00.000Z" }) => ({
    now,
    machines,
    sharedNotes: notes.map((n) => ({ key: DIGEST_NOTE_KEY, value: n })),
  });

  const live = [{ name: "atlas", kind: "robot", liveness: "live" }];
  const stale = [{ name: "atlas", kind: "robot", liveness: "stale" }];

  // 1. Nothing connected is nothing to say.
  check("no machines, no digest", machineDigest(obs({ machines: [] })) === null);

  // 2. A changed roster with nobody having spoken is worth one sentence.
  const first = machineDigest(obs({ machines: live }));
  check("a live roster with no prior digest speaks", Boolean(first && first.text.startsWith(DIGEST_PREFIX)));
  check("the digest reports the machine by name", Boolean(first && first.text.includes("atlas")));

  // 3. THE FLOOD CASE: another resident already said exactly this. The roster is
  //    unchanged, so this agent must not repeat it, whoever spoke and whenever.
  const saidBySomeoneElse = [{ fingerprint: machineFingerprint(live), at: "2026-09-21T16:00:00.000Z" }];
  check(
    "the same roster already spoken by another resident says nothing",
    machineDigest(obs({ machines: live, notes: saidBySomeoneElse })) === null,
  );

  // 4. Changed roster inside the quiet window: hold, because the swarm has just
  //    spoken and one voice at a time is the rule.
  check(
    "a change inside the quiet window waits",
    machineDigest(
      obs({ machines: stale, notes: [{ fingerprint: machineFingerprint(live), at: "2026-09-21T16:55:00.000Z" }] }),
    ) === null,
  );

  // 5. Changed roster and the quiet window has passed: speak.
  const afterQuiet = machineDigest(
    obs({
      machines: stale,
      notes: [{ fingerprint: machineFingerprint(live), at: new Date(Date.parse("2026-09-21T17:00:00.000Z") - DIGEST_QUIET_MS - MINUTE).toISOString() }],
    }),
  );
  check("a change after the quiet window speaks", Boolean(afterQuiet && afterQuiet.text.includes("gone quiet")));

  // 6. Several residents hold this key over time, one row each. The newest wins;
  //    a reader that took the first row it found could compare against a digest
  //    from last week and speak about news.
  const twoRows = machineDigest(
    obs({
      machines: live,
      notes: [
        { fingerprint: machineFingerprint(stale), at: "2026-09-20T09:00:00.000Z" },
        { fingerprint: machineFingerprint(live), at: "2026-09-21T16:59:00.000Z" },
      ],
    }),
  );
  check("the newest shared note decides, not the first one found", twoRows === null);

  // 7. THE WIRING, which is where the bug actually lived. A correct function
  //    wired to a key nobody writes is a function that never runs.
  const web = path.join(__dirname, "..");
  const pulseSrc = fs.readFileSync(path.join(web, "lib/swamp/pulse.ts"), "utf8");
  const digestSrc = fs.readFileSync(path.join(web, "lib/swamp/machine-digest.ts"), "utf8");
  const obsSrc = fs.readFileSync(path.join(web, "lib/swamp/observations.ts"), "utf8");

  check("the pulse writes the shared notice under the exported key", pulseSrc.includes("DIGEST_NOTE_KEY"));
  check(
    "the brain and the pulse name the same key, imported rather than spelled twice",
    digestSrc.includes('export const DIGEST_NOTE_KEY = "digest:last"') &&
      pulseSrc.includes('from "./machine-digest"'),
  );
  // Comments are stripped first, deliberately: both files document this bug by
  // name, and a check that forbids naming it would delete the explanation.
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check(
    "no leftover key the writer and reader disagreed about",
    !code(pulseSrc).includes('"machine_digest:last"') && !code(digestSrc).includes("note:machine_digest:last"),
  );
  check("the shared-notes query actually reads the digest key", obsSrc.includes("key.like.digest:%"));

  // 8. The digest says the same thing twice in a row only if the roster changed.
  check("the fingerprint is a reading of composition and liveness, not of readings", machineFingerprint(live) === "atlas:robot:live");

  console.log(
    failed === 0
      ? "\nmachine digest: one voice, on change, then quiet - all checks passed"
      : `\nmachine digest: ${failed} check(s) failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error("verify-machine-digest could not run:", e.message);
  process.exit(1);
});
