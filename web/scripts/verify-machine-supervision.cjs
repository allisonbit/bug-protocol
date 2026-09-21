/**
 * The first rule that moves something in the world.
 *
 * WHY THIS CHECK IS NOT OPTIONAL. Every other rule in the swarm writes a row or
 * a sentence, and a mistake is embarrassing. This one sends a command to
 * hardware, and a mistake is a machine doing something nobody asked for. So the
 * decision is a pure function and this file exercises every branch of it: the
 * band breach, the silence, the outstanding question, both cooldowns, the closed
 * palette, and the machine kinds each command may reach.
 *
 * It also asserts the wiring, because the digest flood taught the whole
 * codebase what a correct function wired to a key nobody writes produces: a rule
 * that never fires, or worse, one that fires for everybody. The note key, the
 * rule's presence in the published policy, and the action's presence in the
 * executor's list are all checked here rather than assumed.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-machine-supervision.cjs
 */
const fs = require("fs");
const path = require("path");

(async () => {
  const sup = await import("../lib/swamp/machine-supervision.ts");
  const {
    supervisionDecision,
    parseThresholds,
    commandAllowed,
    COMMAND_PALETTE,
    SUPERVISION_NOTE_KEY,
    COMMAND_COOLDOWN_MS,
    ACTUATION_COOLDOWN_MS,
    MAX_RELAY_SECONDS,
  } = sup;

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else {
      console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
      failed += 1;
    }
  };

  const NOW = "2026-09-21T18:00:00.000Z";
  const minutesAgo = (n) => new Date(Date.parse(NOW) - n * 60 * 1000).toISOString();
  const machine = (over = {}) => ({
    id: "m1",
    name: "atlas",
    kind: "robot",
    liveness: "live",
    last_report_at: minutesAgo(1),
    thresholds: { metric: "temperature", min: 5, max: 30, expected_interval_secs: 120 },
    latest: { kind: "telemetry", metric: "temperature", value: 22.6, unit: "c", created_at: minutesAgo(1) },
    ...over,
  });
  const decide = (over = {}, last = null, pending = 0) =>
    supervisionDecision({ machine: machine(over), nowIso: NOW, last, pending });

  // 1. In band, reporting on time, nothing outstanding: stand still. A rule that
  //    commands hardware without a condition is the failure this file exists for.
  check("an in-band machine is left alone", decide() === null);

  // 2. A declared band that the newest reading breaches, on a machine that can
  //    actuate, becomes an actuation with the band cited.
  const hot = decide({
    latest: { kind: "telemetry", metric: "temperature", value: 41, unit: "c", created_at: minutesAgo(1) },
  });
  check("a breach on an actuation-capable machine actuates", hot !== null && hot.actuation === true);
  check("the breach cites the band and the value", Boolean(hot && hot.cited.value === 41 && Array.isArray(hot.cited.band)));
  check("the reason names the machine and the numbers", Boolean(hot && hot.reason.includes("atlas") && hot.reason.includes("41")));
  check("the actuation body is bounded", Boolean(hot && hot.body.seconds <= MAX_RELAY_SECONDS));

  // 3. A breach on a machine that cannot actuate asks for a reading instead of
  //    reaching for a relay it does not have.
  const sensorHot = decide({
    kind: "sensor",
    latest: { kind: "telemetry", metric: "temperature", value: 41, unit: "c", created_at: minutesAgo(1) },
  });
  check("a breach on a reporting-only machine asks for a reading", Boolean(sensorHot && sensorHot.name === "report_now" && sensorHot.actuation === false));

  // 4. The cooldowns. A command inside the reporting window silences everything;
  //    inside the actuation window but past the reporting window, the response
  //    steps down from actuation to asking.
  const justCommanded = decide(
    { latest: { kind: "telemetry", metric: "temperature", value: 41, unit: "c", created_at: minutesAgo(1) } },
    { machine: "atlas", name: "report_now", at: minutesAgo(5) },
  );
  check("a command inside the cooldown stops a second one", justCommanded === null);

  const stepped = decide(
    { latest: { kind: "telemetry", metric: "temperature", value: 41, unit: "c", created_at: minutesAgo(1) } },
    { machine: "atlas", name: "report_now", at: minutesAgo(ACTUATION_COOLDOWN_MS / 60000 + 1) },
  );
  check("past the actuation cooldown the response may actuate again", stepped !== null && stepped.actuation === true);

  check("the reporting cooldown is shorter than the actuation cooldown", COMMAND_COOLDOWN_MS < ACTUATION_COOLDOWN_MS);

  // 5. Silence past three expected intervals asks the machine directly, and never
  //    actuates: an absence is not evidence of a fault.
  const quiet = decide({ last_report_at: minutesAgo(45), liveness: "stale" });
  check("silence past the interval asks for a reading", Boolean(quiet && quiet.name === "report_now"));
  check("silence never actuates", Boolean(quiet && quiet.actuation === false));
  check("the silence reason cites the interval", Boolean(quiet && quiet.cited.quiet_secs >= 2700));

  // 6. Silence inside the expected interval is not a condition.
  check("a machine reporting on time is not asked", decide({ last_report_at: minutesAgo(3) }) === null);

  // 7. An outstanding question outranks everything: nothing new is sent while a
  //    machine has not answered.
  const outstanding = decide(
    { latest: { kind: "telemetry", metric: "temperature", value: 41, unit: "c", created_at: minutesAgo(1) } },
    null,
    1,
  );
  check("an unanswered command stops a second command", outstanding === null);

  // 8. No declared band means no breach can be claimed, so only silence may act.
  check("no band, in range: nothing", decide({ thresholds: null }) === null);
  check(
    "no band, silent: asks for a reading",
    decide({ thresholds: { expected_interval_secs: 120 }, last_report_at: minutesAgo(30) }) !== null,
  );

  // 9. The palette is closed and typed.
  const names = COMMAND_PALETTE.map((c) => c.name);
  check("the palette holds exactly three commands", names.length === 3 && names.includes("report_now") && names.includes("set_interval") && names.includes("pulse_relay"));
  check("a relay cannot reach a sensor", commandAllowed("pulse_relay", "sensor") === false);
  check("a relay cannot reach a gateway", commandAllowed("pulse_relay", "gateway") === false);
  check("a report can reach every kind", ["sensor", "actuator", "robot", "gateway", "controller"].every((k) => commandAllowed("report_now", k)));
  check("only one command in the palette actuates", COMMAND_PALETTE.filter((c) => c.actuation).length === 1);
  check("thresholds parse and refuse nonsense", parseThresholds({ min: "hot" }) === null && parseThresholds({ min: 1, max: 2 }) !== null);

  // 10. The wiring, which is where the digest bug actually lived.
  const web = path.join(__dirname, "..");
  const read = (p) => fs.readFileSync(path.join(web, p), "utf8");
  const policySrc = read("lib/swamp/policy.ts");
  const brainSrc = read("lib/swamp/brain.ts");
  const pulseSrc = read("lib/swamp/pulse.ts");
  const obsSrc = read("lib/swamp/observations.ts");

  check("the rule is in the published policy", policySrc.includes('intent: "supervise_machine"'));
  check("the action is in the executor's list", policySrc.includes('"supervise_machine",'));
  check("the brain composes it", brainSrc.includes("supervisionDecision(") && brainSrc.includes('kind: "supervise_machine"'));
  check("the executor queues it and writes the event", pulseSrc.includes('from("machine_commands").insert') && pulseSrc.includes('topic: "machine.command"'));
  check("the executor attributes the command to the resident", pulseSrc.includes("issued_by_agent: agent.id"));
  check("one shared note holds the fleet to one commander", pulseSrc.includes("SUPERVISION_NOTE_KEY") && brainSrc.includes("SUPERVISION_NOTE_KEY"));
  check("the observation carries the reading and the band", obsSrc.includes("machineWatch") && obsSrc.includes("parseThresholds("));
  check(
    "the note key is spelled once, in the module",
    brainSrc.includes('from "./machine-supervision"') && pulseSrc.includes('from "./machine-supervision"'),
  );
  // THE BUG THIS FILE ALMOST SHIPPED WITH. The cooldown reads a shared note, and
  // the shared-notes query is a hand-written list of key prefixes in
  // observations.ts. The rule was written, the note was written, and the query did
  // not read the key, so the cooldown measured nothing and two residents each sent
  // atlas a relay command inside one beat. The digest shipped with the same defect
  // and published 1,076 copies of one sentence. So: every shared key a rule reads
  // is asserted against that list, here and in verify-machine-digest.cjs.
  check(
    "the shared-notes query actually reads the supervision key",
    obsSrc.includes(`key.like.${SUPERVISION_NOTE_KEY.split(":")[0]}:%`),
  );

  console.log(
    failed === 0
      ? "\nmachine supervision: conditions cited, palette closed, one voice - all checks passed"
      : `\nmachine supervision: ${failed} check(s) failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error("verify-machine-supervision could not run:", e.message);
  process.exit(1);
});
