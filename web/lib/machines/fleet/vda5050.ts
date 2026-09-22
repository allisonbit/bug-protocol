/**
 * VDA 5050, AS A PURE PROJECTION OF ROWS THIS PLATFORM ALREADY KEEPS.
 *
 * WHY THIS EXISTS. VDA 5050 over MQTT is the language the warehouse robot world
 * actually speaks in 2026: an AGV publishes `state`, a master control sends it
 * `order`, and a fleet manager above that coordinates a mixed fleet. A machine
 * registered here already has a row, a command queue and a reading history. This
 * module turns those rows into the messages a VDA 5050 client expects, so this
 * platform is something a fleet can dispatch to rather than a dashboard standing
 * next to one.
 *
 * WHY IT IS PURE. Every branch below is a decision: is this order legal against
 * the AGV's current state, which way does the state machine move, is this header
 * newer than the last one. Keeping them pure means `scripts/verify-fleet-bridge.cjs`
 * can walk all of them without an MQTT broker, a database or hardware, and the
 * door that serves them is a thin translation.
 *
 * WHAT IT IS NOT. This is not a certified VDA 5050 implementation and it does not
 * claim conformance. It publishes the subset a fleet coordinator reads and accepts
 * the subset it needs to be dispatched to, with the state machine and the ordering
 * rules spelled out so a refusal is a refusal rather than silence. Nothing here
 * asserts a safety function: `safetyState` is carried from the device or reported as
 * unknown, never invented.
 *
 * THE COMMAND QUEUE STAYS THE SOURCE OF TRUTH. An order arriving over this bridge
 * becomes a `machine_commands` row, exactly like an order a person queues, and the
 * device collects it on its own poll. The platform still never reaches out to
 * hardware, which is the property every other machine surface here depends on.
 */

/** The protocol revision these messages declare. */
export const VDA_VERSION = "2.0.0";

/** A connection state, as the standard names them. */
export type ConnectionState = "ONLINE" | "OFFLINE" | "CONNECTIONBROKEN";

/**
 * The AGV state machine. ERROR is reachable from anywhere and only leaves on an
 * explicit reset, because a robot that silently returned to IDLE from a fault
 * would be reporting health it does not have.
 */
export type AgvState = "INITIALIZING" | "IDLE" | "EXECUTING" | "CHARGING" | "ERROR";

/** Every message this bridge can emit or accept. */
export type VdaMessageType = "connection" | "state" | "order" | "instantAction" | "visualization";

/** The block every VDA 5050 message opens with. */
export type VdaHeader = {
  headerId: number;
  timestamp: string;
  version: string;
  manufacturer: string;
  serialNumber: string;
};

export type VdaAction = {
  actionId: string;
  actionType: string;
  blockingType: "NONE" | "SOFT" | "HARD";
  actionDescription?: string;
  actionParameters?: { key: string; value: unknown }[];
};

export type VdaNode = {
  nodeId: string;
  sequenceId: number;
  released: boolean;
  nodeDescription?: string;
  actions: VdaAction[];
};

export type VdaOrder = VdaHeader & {
  orderId: string;
  orderUpdateId: number;
  zoneSetId?: string;
  nodes: VdaNode[];
  edges: unknown[];
};

export type VdaError = {
  errorType: string;
  errorLevel: "WARNING" | "FATAL";
  errorDescription?: string;
  errorReferences?: { referenceKey: string; referenceValue: string }[];
};

export type VdaState = VdaHeader & {
  orderId: string;
  orderUpdateId: number;
  lastNodeId: string;
  lastNodeSequenceId: number;
  nodeStates: unknown[];
  edgeStates: unknown[];
  actionStates: { actionId: string; actionStatus: string; actionDescription?: string }[];
  driving: boolean;
  agvPosition: {
    x: number;
    y: number;
    theta: number;
    mapId: string;
    positionInitialized: boolean;
    localizationScore?: number;
  };
  velocity: { vx: number; vy: number; omega: number };
  batteryState: { batteryCharge: number; charging: boolean; reach?: number; batteryHealth?: number };
  errors: VdaError[];
  safetyState: { eStop: "AUTOACK" | "MANUAL" | "NONE" | "REMOTE"; fieldViolation: boolean };
  information?: { infoType: string; infoLevel: string; infoDescription?: string }[];
};

/**
 * How a device's own reading history maps onto the AGV's state.
 *
 * WHY A MAPPING RATHER THAN A SECOND STORE. A robot that reports `batteryCharge` as
 * a reading and as a VDA `batteryState` field must have one answer, not two rows
 * that can drift. So `stateFromMachine` reads the platform's own `MachineReading`
 * shape and derives the VDA fields from it, and anything it cannot derive is either
 * carried verbatim or reported as unknown.
 */
export type MachineLike = {
  name: string;
  hardware?: string | null;
  firmware?: string | null;
  installed_version?: string | null;
  status?: string | null;
  last_report_at?: string | null;
};

export type ReadingLike = {
  kind: string;
  metric: string | null;
  value: number | null;
  unit: string | null;
  state: string | null;
  message: string | null;
  created_at: string;
};

/** A command as the queue keeps it, which is what an order projects from. */
export type CommandLike = {
  id: string;
  body: string;
  status: string;
  created_at: string;
  acked_at?: string | null;
  note?: string | null;
};

/**
 * The manufacturer and serial number a VDA client keys a robot by.
 *
 * The standard wants a manufacturer and a serial number. This platform has a
 * callsign, a board and its own uuid. Reporting the platform as manufacturer and
 * the machine's own name as serial keeps the pair stable and traceable to a row,
 * and says plainly who is speaking for the robot.
 */
export function identityOf(machine: MachineLike): { manufacturer: string; serialNumber: string } {
  return { manufacturer: "swampai.world", serialNumber: machine.name };
}

/** A fresh header. `headerId` must move forward; see `headerOrder`. */
export function header(input: {
  machine: MachineLike;
  headerId: number;
  nowMs: number;
}): VdaHeader {
  return {
    headerId: Math.max(0, Math.floor(input.headerId)),
    timestamp: new Date(input.nowMs).toISOString(),
    version: VDA_VERSION,
    ...identityOf(input.machine),
  };
}

/**
 * Whether a received header is newer than the one last seen, which is the whole
 * ordering guarantee VDA 5050 gives.
 *
 * WHY AN OLDER HEADER IS DROPPED RATHER THAN APPLIED. MQTT does not promise order,
 * so a state message and an older one can arrive reversed. Applying the older one
 * would walk a robot's reported position backwards, which is worse than ignoring
 * it. Equal is treated as a duplicate and dropped too, because the same header
 * twice is the same message twice.
 */
export function headerOrder(lastSeen: number | null, incoming: number): { ok: true; duplicate: false } | { ok: true; duplicate: true } | { ok: false; reason: string } {
  if (!Number.isFinite(incoming) || incoming < 0) {
    return { ok: false, reason: `headerId must be a non-negative integer; got ${String(incoming)}.` };
  }
  if (lastSeen === null) return { ok: true, duplicate: false };
  if (incoming === lastSeen) return { ok: true, duplicate: true };
  if (incoming < lastSeen) {
    return { ok: false, reason: `headerId ${incoming} is older than ${lastSeen}, which this bridge already applied. MQTT does not guarantee order, so an out of order message is dropped rather than rewinding the record.` };
  }
  return { ok: true, duplicate: false };
}

// ---------------------------------------------------------------- the state machine

/**
 * Which event each state accepts, and where it lands.
 *
 * KEYED ON THE STATE THE EVENT IS VALID IN, NOT ON THE STATE IT ENDS IN. That
 * distinction was a real bug caught by the verifier: `order_done`, `charge_done`
 * and `ready` all end in IDLE, so a table keyed on the destination let a robot in
 * INITIALIZING accept `order_done` and a robot in EXECUTING accept `ready`, because
 * the destination looked legal. An event has to be meaningful where it is applied.
 */
const ACCEPTS: Record<AgvEvent, { in: AgvState[]; to: AgvState }> = {
  bootstrap: { in: [], to: "IDLE" },
  ready: { in: ["INITIALIZING"], to: "IDLE" },
  order_started: { in: ["IDLE"], to: "EXECUTING" },
  order_done: { in: ["EXECUTING"], to: "IDLE" },
  // The one event allowed from two states: a robot can begin charging from idle or
  // from mid-order, which is exactly what a battery threshold does in the field.
  charge_started: { in: ["IDLE", "EXECUTING"], to: "CHARGING" },
  charge_done: { in: ["CHARGING"], to: "IDLE" },
  fault: { in: ["INITIALIZING", "IDLE", "EXECUTING", "CHARGING", "ERROR"], to: "ERROR" },
  reset: { in: ["ERROR"], to: "INITIALIZING" },
};

export type AgvEvent = "bootstrap" | "ready" | "order_started" | "order_done" | "charge_started" | "charge_done" | "fault" | "reset";

/** Which events move a machine out of the state it is in, in a fixed order. */
export function eventsFrom(state: AgvState): AgvEvent[] {
  return (Object.keys(ACCEPTS) as AgvEvent[]).filter((e) => ACCEPTS[e].in.includes(state));
}

/**
 * Walk the state machine one step, or refuse.
 *
 * The refusal carries the current state and the events that WOULD be accepted,
 * because a fleet coordinator told only "no" retries; one told what the robot is
 * waiting for can act.
 */
export function agvTransition(current: AgvState, event: AgvEvent): { ok: true; state: AgvState; reason: string } | { ok: false; state: AgvState; accepted: AgvEvent[]; reason: string } {
  const rule = ACCEPTS[event];
  if (!rule || !rule.in.includes(current)) {
    const accepted = eventsFrom(current);
    return {
      ok: false,
      state: current,
      accepted,
      reason: `A machine in ${current} cannot accept ${event}. It accepts ${accepted.length > 0 ? accepted.join(", ") : "nothing on its own"}.`,
    };
  }
  return {
    ok: true,
    state: rule.to,
    reason:
      event === "fault"
        ? "A fault moves any state to ERROR, which is the only transition out of every state."
        : `Accepted ${event} in ${current}, moving to ${rule.to}.`,
  };
}

/**
 * The state a machine's rows say it is in, rather than the state it claims.
 *
 * A heartbeat is the honest input. A machine that has not reported inside the
 * staleness window is not IDLE and is not EXECUTING: its connection is BROKEN and
 * its position is not initialised, because the last position we hold is from a
 * report we can no longer attribute to right now. An open FATAL alert puts it in
 * ERROR whatever else is true, because a device reporting a fatal fault and also
 * reporting IDLE has one answer worth believing.
 */
export function connectionFor(lastReportAt: string | null, nowMs: number, staleAfterMs: number): ConnectionState {
  if (!lastReportAt) return "OFFLINE";
  const at = Date.parse(lastReportAt);
  if (!Number.isFinite(at)) return "CONNECTIONBROKEN";
  return nowMs - at <= staleAfterMs ? "ONLINE" : "CONNECTIONBROKEN";
}

/** The staleness window, in the standard's spirit: three missed minute reports. */
export const STALE_AFTER_MS = 3 * 60 * 1000;

export function agvStateFor(input: {
  machine: MachineLike;
  readings: ReadingLike[];
  commands: CommandLike[];
  nowMs: number;
  staleAfterMs?: number;
}): { state: AgvState; connection: ConnectionState; reason: string } {
  const stale = input.staleAfterMs ?? STALE_AFTER_MS;
  const connection = connectionFor(input.machine.last_report_at ?? null, input.nowMs, stale);
  if (connection !== "ONLINE") {
    return {
      state: "ERROR",
      connection,
      reason: `The machine last reported at ${input.machine.last_report_at ?? "never"}, which is outside the ${Math.round(stale / 1000)} second staleness window, so this bridge reports CONNECTIONBROKEN rather than a state it cannot support.`,
    };
  }
  const fatal = input.readings.find((r) => r.kind === "alert" && String(r.state ?? "").toUpperCase() === "FATAL");
  if (fatal) {
    return {
      state: "ERROR",
      connection,
      reason: `A fatal alert is open${fatal.message ? `: ${fatal.message}` : ""}, which outranks whatever else the device reports.`,
    };
  }
  const charge = input.readings.find((r) => r.metric === "batteryCharge" || r.metric === "charging");
  if (charge && (charge.metric === "charging" ? charge.value === 1 : (charge.value ?? 0) >= 95)) {
    return { state: "CHARGING", connection, reason: "A charging reading is the newest evidence about this machine, so it is reported as CHARGING." };
  }
  const inFlight = input.commands.find((c) => c.status === "delivered");
  if (inFlight) {
    return { state: "EXECUTING", connection, reason: `Command ${inFlight.id} has been delivered and not yet acknowledged, so the machine is reported as EXECUTING.` };
  }
  return { state: "IDLE", connection, reason: "The machine is reporting inside the staleness window with no fatal alert and nothing delivered in flight." };
}

// ---------------------------------------------------------------- orders

/**
 * Turn a queued command into a VDA 5050 order.
 *
 * This platform's command has a body in words and no graph. A VDA order needs an
 * order id, an update id, and a node with an action. So a command becomes a
 * single node whose one action carries the command's words as
 * `actionParameters`, and whose `actionId` is the command's own uuid. The
 * projection is lossless in the direction that matters: the words the operator
 * wrote are in the message, and the id that comes back in `state.actionStates`
 * resolves to the row the platform is holding.
 *
 * `orderUpdateId` must increase for each revision of the same order. The queue
 * gives each command a fresh id, so each is its own order and starts at 0, which
 * is what a receiver expects for an order it has not seen.
 */
export function orderFromCommand(input: {
  machine: MachineLike;
  command: CommandLike;
  headerId: number;
  nowMs: number;
  updateId?: number;
  blocking?: "NONE" | "SOFT" | "HARD";
  actionType?: string;
  nodeId?: string;
}): VdaOrder {
  const command = input.command;
  return {
    ...header({ machine: input.machine, headerId: input.headerId, nowMs: input.nowMs }),
    orderId: command.id,
    orderUpdateId: input.updateId ?? 0,
    nodes: [
      {
        nodeId: input.nodeId ?? "command",
        sequenceId: 0,
        released: true,
        nodeDescription: `the queued command for ${input.machine.name}`,
        actions: [
          {
            actionId: command.id,
            actionType: input.actionType ?? "swampCommand",
            blockingType: input.blocking ?? "NONE",
            actionDescription: command.body.slice(0, 200),
            actionParameters: [
              { key: "body", value: command.body },
              { key: "issued_at", value: command.created_at },
            ],
          },
        ],
      },
    ],
    edges: [],
  };
}

/**
 * The inverse: what an incoming order asks this platform to do, as a refusal or a body.
 *
 * The rules are the standard's plus two of this platform's. A released node with a
 * non-blocking action is what gets queued. An unreleased node is a look-ahead the
 * coordinator will release later, so it is not queued yet. And an order for a
 * retired machine is refused, because this platform refuses commands to retired
 * machines at every other door and a bridge that quietly bypassed that would be
 * the hole in the rule.
 */
export type OrderIntake =
  | {
      ok: true;
      /** The instruction, from the `body` parameter when one was given. */
      body: string;
      /** The closed-palette command name, when the action named one instead of a body. */
      command: string;
      actionId: string;
      blocking: "NONE" | "SOFT" | "HARD";
      nodeId: string;
      /** Every action parameter, so the door can read `seconds` and `interval_secs`. */
      params: Record<string, unknown>;
    }
  | { ok: false; code: string; reason: string };

export function intakeOrder(input: {
  machine: MachineLike;
  order: { orderId?: unknown; orderUpdateId?: unknown; nodes?: unknown };
  seenOrders?: Map<string, number>;
}): OrderIntake {
  const machine = input.machine;
  if (String(machine.status ?? "active") === "retired") {
    return { ok: false, code: "MACHINE_RETIRED", reason: `${machine.name} is retired. Every other door refuses commands to a retired machine, and this bridge does not make an exception.` };
  }
  const orderId = typeof input.order.orderId === "string" ? input.order.orderId.trim() : "";
  if (!orderId) return { ok: false, code: "NO_ORDER_ID", reason: "An order must carry `orderId`, so the state message can name the order it is executing." };
  const updateId = Number(input.order.orderUpdateId);
  if (!Number.isInteger(updateId) || updateId < 0) {
    return { ok: false, code: "BAD_UPDATE_ID", reason: "`orderUpdateId` must be a non-negative integer. It is how a receiver tells a revision from a duplicate." };
  }
  const seen = input.seenOrders?.get(orderId);
  if (typeof seen === "number" && updateId <= seen) {
    return { ok: false, code: "STALE_UPDATE", reason: `orderUpdateId ${updateId} for ${orderId} is not newer than ${seen}, which was already applied. A revision that does not advance is a duplicate.` };
  }
  const nodes = Array.isArray(input.order.nodes) ? (input.order.nodes as Record<string, unknown>[]) : [];
  if (nodes.length === 0) return { ok: false, code: "NO_NODES", reason: "An order with no nodes asks for nothing. Send at least one released node with an action." };
  const first = nodes[0];
  const released = first.released === true;
  if (!released) {
    return { ok: false, code: "NODE_NOT_RELEASED", reason: "The first node is not released. An unreleased node is look-ahead the coordinator will release later, so nothing is queued for it now." };
  }
  const actions = Array.isArray(first.actions) ? (first.actions as Record<string, unknown>[]) : [];
  const action = actions[0];
  if (!action) return { ok: false, code: "NO_ACTIONS", reason: "The released node carries no actions, so there is nothing to ask the machine to do." };
  const blocking = String(action.blockingType ?? "NONE").toUpperCase();
  if (!["NONE", "SOFT", "HARD"].includes(blocking)) {
    return { ok: false, code: "BAD_BLOCKING", reason: "`blockingType` must be NONE, SOFT or HARD." };
  }
  const paramList = Array.isArray(action.actionParameters) ? (action.actionParameters as Record<string, unknown>[]) : [];
  const params: Record<string, unknown> = {};
  for (const p of paramList) {
    const key = String(p.key ?? "").trim();
    if (key) params[key] = p.value;
  }
  const body = typeof params.body === "string" ? params.body.trim() : "";
  const command = typeof params.command === "string" ? params.command.trim() : "";
  // An instruction is either free words (what the owner door takes) or one of the
  // platform's closed palette names (what an agent may send). Neither means nothing
  // to queue, and this bridge does not choose for the caller.
  if (!body && !command) {
    return {
      ok: false,
      code: "NO_INSTRUCTION",
      reason: "The action carries neither a `body` parameter with the instruction in words nor a `command` parameter naming one of the platform's closed palette commands, so there is nothing to queue.",
    };
  }
  return {
    ok: true,
    body: body.slice(0, 500),
    command,
    actionId: typeof action.actionId === "string" && action.actionId.trim() ? action.actionId.trim() : orderId,
    blocking: blocking as "NONE" | "SOFT" | "HARD",
    nodeId: typeof first.nodeId === "string" && first.nodeId.trim() ? first.nodeId.trim() : "command",
    params,
  };
}

// ---------------------------------------------------------------- state messages

/**
 * A reading, carried into the VDA fields it names, without inventing the ones it does not.
 *
 * Every field below is either present in the readings or reported as the standard's
 * "unknown": a position of 0,0 with `positionInitialized: false` says "no fix" rather
 * than "at the origin", and a batteryCharge of -1 is the number the standard reserves
 * for unknown. A fleet coordinator can tell the difference, and a bridge that filled
 * these with plausible zeros would be the reason it could not.
 */
function numberReading(readings: ReadingLike[], metric: string): number | null {
  const r = readings.find((x) => x.metric === metric && typeof x.value === "number");
  return r && typeof r.value === "number" ? r.value : null;
}

export function stateFromMachine(input: {
  machine: MachineLike;
  readings: ReadingLike[];
  commands: CommandLike[];
  headerId: number;
  nowMs: number;
  staleAfterMs?: number;
  mapId?: string;
}): { message: VdaState; derived: { state: AgvState; connection: ConnectionState } } {
  const { machine, readings, commands, nowMs } = input;
  const derived = agvStateFor({ machine, readings, commands, nowMs, staleAfterMs: input.staleAfterMs });
  const x = numberReading(readings, "position.x");
  const y = numberReading(readings, "position.y");
  const theta = numberReading(readings, "position.theta");
  const charge = numberReading(readings, "batteryCharge");
  const chargingReading = numberReading(readings, "charging");
  const inFlight = commands.find((c) => c.status === "delivered");

  const errors: VdaError[] = readings
    .filter((r) => r.kind === "alert")
    .slice(0, 20)
    .map((r) => ({
      errorType: String(r.metric ?? "alert").toUpperCase(),
      errorLevel: String(r.state ?? "").toUpperCase() === "FATAL" ? "FATAL" : "WARNING",
      errorDescription: r.message ?? undefined,
      errorReferences: [{ referenceKey: "machineReading", referenceValue: r.created_at }],
    }));

  return {
    derived: { state: derived.state, connection: derived.connection },
    message: {
      ...header({ machine, headerId: input.headerId, nowMs }),
      orderId: inFlight?.id ?? "",
      orderUpdateId: 0,
      lastNodeId: "command",
      lastNodeSequenceId: 0,
      nodeStates: [],
      edgeStates: [],
      actionStates: commands
        .filter((c) => c.status === "delivered" || c.status === "acknowledged" || c.status === "failed")
        .slice(0, 20)
        .map((c) => ({
          actionId: c.id,
          actionStatus: c.status === "delivered" ? "RUNNING" : c.status === "acknowledged" ? "FINISHED" : "FAILED",
          actionDescription: c.note ?? undefined,
        })),
      driving: derived.state === "EXECUTING",
      agvPosition: {
        x: x ?? 0,
        y: y ?? 0,
        theta: theta ?? 0,
        mapId: input.mapId ?? `swampai.${machine.name}`,
        positionInitialized: x !== null && y !== null,
      },
      velocity: {
        vx: numberReading(readings, "velocity.vx") ?? 0,
        vy: numberReading(readings, "velocity.vy") ?? 0,
        omega: numberReading(readings, "velocity.omega") ?? 0,
      },
      batteryState: {
        batteryCharge: charge ?? -1,
        charging: chargingReading === 1 || derived.state === "CHARGING",
      },
      errors,
      safetyState: {
        eStop: "NONE",
        // Reported, never inferred. A bridge that guessed here would be claiming a
        // safety property, which this platform never does anywhere.
        fieldViolation: false,
      },
    },
  };
}

/** The `connection` message, which is how a client sees a robot come and go. */
export function connectionMessage(input: {
  machine: MachineLike;
  headerId: number;
  nowMs: number;
  staleAfterMs?: number;
}): VdaHeader & { connectionState: ConnectionState } {
  return {
    ...header(input),
    connectionState: connectionFor(input.machine.last_report_at ?? null, input.nowMs, input.staleAfterMs ?? STALE_AFTER_MS),
  };
}
