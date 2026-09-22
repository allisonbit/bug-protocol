/**
 * Does the fleet bridge actually speak the protocol it claims, and refuse what it should?
 *
 * WHY THIS FILE EXISTS. A bridge that talks to a fleet manager is a bridge whose mistakes
 * reach hardware: an order applied out of sequence drives a robot to a stale node, a state
 * machine that accepts an impossible transition reports a robot as executing when it is not,
 * and a state message that invents a position sends a coordinator looking in the wrong place.
 * So this verifier walks the pure module the door is built on: every message shape, every
 * ordering rule, every legal transition and a sample of the illegal ones, and every refusal
 * intakeOrder can produce.
 *
 * WHAT IT HOLDS TO ACCOUNT. That the AGV state machine refuses every transition the table
 * does not contain; that an older or duplicate header is dropped rather than applied; that a
 * state built from rows reports unknown as the standard's unknown rather than as a plausible
 * zero; that a retired machine is refused an order here exactly as it is at every other door;
 * and that a queued command's words survive the round trip into an order and back.
 *
 * It needs no broker, no database, no network and no server.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-fleet-bridge.cjs
 */
(async () => {
  const vda = await import("../lib/machines/fleet/vda5050.ts");

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else {
      console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
      failed += 1;
    }
  };

  const T0 = Date.parse("2026-09-22T10:00:00.000Z");
  const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
  const NOW = T0 + 1 * 60_000;

  const MACHINE = {
    name: "atlas",
    kind: "robot",
    hardware: "esp32-devkit",
    firmware: "0.4.1",
    installed_version: "0.4.1",
    status: "active",
    last_report_at: at(0),
  };

  const telemetry = (metric, value, unit = null, extra = {}) => ({
    kind: "telemetry",
    metric,
    value,
    unit,
    state: null,
    message: null,
    payload: {},
    created_at: at(0),
    ...extra,
  });

  // ---- the header -------------------------------------------------------------
  console.log("\nthe header\n");
  const h = vda.header({ machine: MACHINE, headerId: 7, nowMs: T0 });
  check("it names the protocol version", h.version === vda.VDA_VERSION, h.version);
  check("it names a manufacturer", h.manufacturer === "swampai.world", h.manufacturer);
  check("serial number is the machine's own callsign", h.serialNumber === "atlas", h.serialNumber);
  check("the timestamp is ISO", h.timestamp === new Date(T0).toISOString(), h.timestamp);
  check("a negative headerId is clamped to zero", vda.header({ machine: MACHINE, headerId: -5, nowMs: T0 }).headerId === 0);

  // ---- ordering ---------------------------------------------------------------
  console.log("\nordering\n");
  check("the first header is applied", vda.headerOrder(null, 1).ok === true && vda.headerOrder(null, 1).duplicate === false);
  check("a newer header is applied", vda.headerOrder(4, 5).ok === true && vda.headerOrder(4, 5).duplicate === false);
  const dup = vda.headerOrder(4, 4);
  check("an equal header is a duplicate, not an error", dup.ok === true && dup.duplicate === true);
  const older = vda.headerOrder(4, 3);
  check("an older header is refused rather than applied", older.ok === false, JSON.stringify(older));
  check("and the refusal says why order matters", older.ok === false && /order/i.test(older.reason));
  check("a non-integer headerId is refused", vda.headerOrder(null, -1).ok === false);

  // ---- the state machine ------------------------------------------------------
  console.log("\nthe state machine\n");
  const STATES = ["INITIALIZING", "IDLE", "EXECUTING", "CHARGING", "ERROR"];
  const EVENTS = ["ready", "order_started", "order_done", "charge_started", "charge_done", "reset", "fault"];
  // The transitions the module is allowed to make. Anything not here must be refused.
  const LEGAL = new Set([
    "INITIALIZING+ready=IDLE",
    "IDLE+order_started=EXECUTING",
    "IDLE+charge_started=CHARGING",
    "EXECUTING+order_done=IDLE",
    "EXECUTING+charge_started=CHARGING",
    "CHARGING+charge_done=IDLE",
    "ERROR+reset=INITIALIZING",
  ]);
  let legalWalked = 0;
  let refusedWalked = 0;
  for (const state of STATES) {
    for (const event of EVENTS) {
      const result = vda.agvTransition(state, event);
      if (event === "fault") {
        if (!(result.ok === true && result.state === "ERROR")) {
          check(`${state} + fault moves to ERROR`, false, JSON.stringify(result));
        }
        legalWalked += 1;
        continue;
      }
      const key = `${state}+${event}=${result.state}`;
      if (LEGAL.has(key)) {
        if (!result.ok) check(`${state} + ${event} is allowed`, false, JSON.stringify(result));
        legalWalked += 1;
      } else {
        if (result.ok) check(`${state} + ${event} is refused`, false, `it moved to ${result.state}`);
        else refusedWalked += 1;
      }
    }
  }
  // 7 event transitions plus a fault from each of the five states, which is 12 legal pairs.
  check("every legal transition was walked", legalWalked === 12, String(legalWalked));
  check("every other state and event pair is refused", refusedWalked === STATES.length * EVENTS.length - 12, String(refusedWalked));
  const cannotReset = vda.agvTransition("IDLE", "reset");
  check("a healthy robot cannot be reset from IDLE", cannotReset.ok === false);
  check("and the refusal names the events that would work", cannotReset.ok === false && Array.isArray(cannotReset.accepted) && cannotReset.accepted.length > 0, JSON.stringify(cannotReset));
  const faultFromCharging = vda.agvTransition("CHARGING", "fault");
  check("a charging robot can fault", faultFromCharging.ok === true && faultFromCharging.state === "ERROR");
  const stuck = vda.agvTransition("EXECUTING", "ready");
  check("a robot cannot skip from EXECUTING back to readiness", stuck.ok === false);

  // ---- connection and derived state -------------------------------------------
  console.log("\nderived state from rows\n");
  check("no report means OFFLINE", vda.connectionFor(null, NOW, vda.STALE_AFTER_MS) === "OFFLINE");
  check("a garbage timestamp means CONNECTIONBROKEN", vda.connectionFor("not a date", NOW, vda.STALE_AFTER_MS) === "CONNECTIONBROKEN");
  check("a fresh report means ONLINE", vda.connectionFor(at(0), NOW, vda.STALE_AFTER_MS) === "ONLINE");
  check("a report older than the window is CONNECTIONBROKEN", vda.connectionFor(at(-10), NOW, vda.STALE_AFTER_MS) === "CONNECTIONBROKEN");

  const staleState = vda.agvStateFor({ machine: { ...MACHINE, last_report_at: at(-10) }, readings: [], commands: [], nowMs: NOW });
  check("a stale machine reports ERROR rather than a state it cannot support", staleState.state === "ERROR", staleState.state);
  check("and its connection is BROKEN", staleState.connection === "CONNECTIONBROKEN");

  const fatalState = vda.agvStateFor({
    machine: MACHINE,
    readings: [{ kind: "alert", metric: "thermal", value: null, unit: null, state: "FATAL", message: "over temperature", payload: {}, created_at: at(0) }],
    commands: [{ id: "c1", body: "go", status: "delivered", created_at: at(0) }],
    nowMs: NOW,
  });
  check("a fatal alert outranks a delivered command", fatalState.state === "ERROR", fatalState.state);

  const executing = vda.agvStateFor({
    machine: MACHINE,
    readings: [],
    commands: [{ id: "c1", body: "go", status: "delivered", created_at: at(0) }],
    nowMs: NOW,
  });
  check("a delivered command means EXECUTING", executing.state === "EXECUTING", executing.state);

  const idle = vda.agvStateFor({ machine: MACHINE, readings: [], commands: [{ id: "c1", body: "go", status: "acknowledged", created_at: at(0) }], nowMs: NOW });
  check("an acknowledged command means IDLE", idle.state === "IDLE", idle.state);

  const charging = vda.agvStateFor({ machine: MACHINE, readings: [telemetry("batteryCharge", 97, "%")], commands: [], nowMs: NOW });
  check("a charged battery means CHARGING", charging.state === "CHARGING", charging.state);

  // ---- the state message ------------------------------------------------------
  console.log("\nthe state message\n");
  const built = vda.stateFromMachine({
    machine: MACHINE,
    readings: [telemetry("temperature", 21.5, "c"), telemetry("batteryCharge", 42, "%")],
    commands: [{ id: "c2", body: "open the vent", status: "delivered", created_at: at(0) }],
    headerId: 9,
    nowMs: NOW,
  });
  const s = built.message;
  check("it declares the machine as its serial number", s.serialNumber === "atlas");
  check("it carries the in-flight order id", s.orderId === "c2", s.orderId);
  check("it reports driving only while executing", s.driving === true);
  check("it carries the delivered command as a RUNNING action", s.actionStates.some((a) => a.actionId === "c2" && a.actionStatus === "RUNNING"), JSON.stringify(s.actionStates));
  check("it reports the battery it was given", s.batteryState.batteryCharge === 42, String(s.batteryState.batteryCharge));
  check("it does not invent a position it was not given", s.agvPosition.positionInitialized === false, JSON.stringify(s.agvPosition));
  check("and the invented position is the standard's zero with that flag off", s.agvPosition.x === 0 && s.agvPosition.y === 0);
  check("it reports an unknown battery as the standard's -1", vda.stateFromMachine({ machine: MACHINE, readings: [], commands: [], headerId: 1, nowMs: NOW }).message.batteryState.batteryCharge === -1);
  check("it never claims an emergency stop it did not receive", s.safetyState.eStop === "NONE");
  check("it never claims a field violation it did not receive", s.safetyState.fieldViolation === false);
  const withPosition = vda.stateFromMachine({
    machine: MACHINE,
    readings: [telemetry("position.x", 12.5), telemetry("position.y", -3.25), telemetry("position.theta", 1.5)],
    commands: [],
    headerId: 10,
    nowMs: NOW,
  }).message;
  check("a reported position is carried and flagged initialised", withPosition.agvPosition.positionInitialized === true && withPosition.agvPosition.x === 12.5, JSON.stringify(withPosition.agvPosition));

  const conn = vda.connectionMessage({ machine: MACHINE, headerId: 11, nowMs: NOW });
  check("the connection message reports ONLINE for a fresh machine", conn.connectionState === "ONLINE", conn.connectionState);

  // ---- orders -----------------------------------------------------------------
  console.log("\norders\n");
  const command = { id: "c0ffee00-0000-4000-8000-000000000001", body: "open the vent for 10 minutes", status: "pending", created_at: at(-1) };
  const order = vda.orderFromCommand({ machine: MACHINE, command, headerId: 12, nowMs: T0 });
  check("an order names its command as the order id", order.orderId === command.id);
  check("a fresh order starts at orderUpdateId 0", order.orderUpdateId === 0);
  check("it has one released node", order.nodes.length === 1 && order.nodes[0].released === true);
  check("the node's action carries the command's words", order.nodes[0].actions[0].actionDescription === command.body, order.nodes[0].actions[0].actionDescription);
  check("and the body is in the parameters losslessly", order.nodes[0].actions[0].actionParameters.find((p) => p.key === "body").value === command.body);
  check("it declares the version", order.version === vda.VDA_VERSION);

  console.log("\nintake\n");
  const good = vda.intakeOrder({ machine: MACHINE, order: { orderId: "o1", orderUpdateId: 0, nodes: order.nodes } });
  check("a well formed order is accepted", good.ok === true, JSON.stringify(good));
  check("and the body survives the round trip into the queue", good.ok === true && good.body === command.body, good.ok ? good.body : "");
  check("and the blocking type is carried", good.ok === true && good.blocking === "NONE");

  const retired = vda.intakeOrder({ machine: { ...MACHINE, status: "retired" }, order: { orderId: "o1", orderUpdateId: 0, nodes: order.nodes } });
  check("a retired machine is refused an order", retired.ok === false && retired.code === "MACHINE_RETIRED", JSON.stringify(retired));

  const noNodes = vda.intakeOrder({ machine: MACHINE, order: { orderId: "o1", orderUpdateId: 0, nodes: [] } });
  check("an order with no nodes is refused", noNodes.ok === false && noNodes.code === "NO_NODES");

  const unreleased = vda.intakeOrder({ machine: MACHINE, order: { orderId: "o1", orderUpdateId: 0, nodes: [{ ...order.nodes[0], released: false }] } });
  check("an unreleased node is not queued, it is refused as look-ahead", unreleased.ok === false && unreleased.code === "NODE_NOT_RELEASED", JSON.stringify(unreleased));

  const noBody = vda.intakeOrder({
    machine: MACHINE,
    order: { orderId: "o1", orderUpdateId: 0, nodes: [{ released: true, nodeId: "n", actions: [{ actionId: "a", actionType: "x", blockingType: "NONE", actionParameters: [] }] }] },
  });
  check("an action with no instruction at all is refused", noBody.ok === false && noBody.code === "NO_INSTRUCTION", JSON.stringify(noBody));

  const paletteOrder = vda.intakeOrder({
    machine: MACHINE,
    order: { orderId: "o2", orderUpdateId: 0, nodes: [{ released: true, nodeId: "n", actions: [{ actionId: "a", actionType: "x", blockingType: "NONE", actionParameters: [{ key: "command", value: "pulse_relay" }, { key: "seconds", value: 3 }] }] }] },
  });
  check("an order naming a closed-palette command is accepted", paletteOrder.ok === true && paletteOrder.command === "pulse_relay", JSON.stringify(paletteOrder));
  check("and its parameters are carried through", paletteOrder.ok === true && paletteOrder.params.seconds === 3, paletteOrder.ok ? JSON.stringify(paletteOrder.params) : "");

  const badBlocking = vda.intakeOrder({
    machine: MACHINE,
    order: { orderId: "o1", orderUpdateId: 0, nodes: [{ released: true, nodeId: "n", actions: [{ actionId: "a", actionType: "x", blockingType: "MAYBE", actionParameters: [{ key: "body", value: "go" }] }] }] },
  });
  check("an unknown blocking type is refused", badBlocking.ok === false && badBlocking.code === "BAD_BLOCKING", JSON.stringify(badBlocking));

  check("an order with no id is refused", vda.intakeOrder({ machine: MACHINE, order: { orderUpdateId: 0, nodes: order.nodes } }).code === "NO_ORDER_ID");
  check("a negative update id is refused", vda.intakeOrder({ machine: MACHINE, order: { orderId: "o1", orderUpdateId: -1, nodes: order.nodes } }).code === "BAD_UPDATE_ID");

  const seen = new Map([["o1", 2]]);
  const stale = vda.intakeOrder({ machine: MACHINE, order: { orderId: "o1", orderUpdateId: 2, nodes: order.nodes }, seenOrders: seen });
  check("a revision that does not advance is refused", stale.ok === false && stale.code === "STALE_UPDATE", JSON.stringify(stale));
  const advanced = vda.intakeOrder({ machine: MACHINE, order: { orderId: "o1", orderUpdateId: 3, nodes: order.nodes }, seenOrders: seen });
  check("a newer revision of the same order is accepted", advanced.ok === true);

  console.log(`\nfleet-bridge: ${failed === 0 ? "all checks passed" : `${failed} check(s) FAILED`}\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
