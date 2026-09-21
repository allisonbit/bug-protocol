import "server-only";

/**
 * SUPERVISION: deciding when a resident should act on connected hardware.
 *
 * WHAT THIS IS. A pure decision over one machine and its record: given the
 * roster row, the newest reading, the declared band, and what has already been
 * commanded, it returns either a command to queue or null. No database, no
 * clock beyond the observation's own, no network. The brain composes, the pulse
 * acts, and `scripts/verify-machine-supervision.cjs` exercises every branch
 * against synthetic input because a guard nobody can test is a guard nobody
 * trusts.
 *
 * WHY IT IS WRITTEN THIS CAREFULLY. This is the first rule in the platform that
 * moves something in the physical world. Three properties matter more here than
 * anywhere else, and each one is a limit rather than a feature:
 *
 *   1. NEVER WITHOUT A CONDITION. A command cites the reading that justified it
 *      and the band it breached, or the silence that justified it. There is no
 *      rule that commands a machine because it is available, because availability
 *      is not a reason to move a motor.
 *
 *   2. ONE VOICE, ONCE. Fifteen residents waking together must not each queue a
 *      command. The decision reads a shared note (the same pattern the hardware
 *      digest uses), and the cooldown is per machine, not per agent, so a second
 *      commander inside the window sees the first one's note and stays still.
 *
 *   3. THE PALETTE IS CLOSED AND TYPED. Three commands exist. A resident cannot
 *      send prose to a machine, cannot lengthen an actuation past the cap, and
 *      cannot reach a machine kind that the command does not apply to.
 */

/** Where the swarm records the last command it issued to each machine. */
export const SUPERVISION_NOTE_KEY = "supervise:last";

/** The note that means "somebody already said the roster changed" is separate. */
export const COMMAND_COOLDOWN_MS = 10 * 60 * 1000;

/** One actuation per machine per this window, no matter how many conditions trip. */
export const ACTUATION_COOLDOWN_MS = 30 * 60 * 1000;

/** The longest a relay may be held, in seconds. A cap, not a default. */
export const MAX_RELAY_SECONDS = 10;

/** The band a machine is supervised against, as declared on its row. */
export type MachineThresholds = {
  metric?: string;
  min?: number;
  max?: number;
  expected_interval_secs?: number;
};

/** The newest reading, as the roster serves it. */
export type MachineReading = {
  kind: string;
  metric: string | null;
  value: number | null;
  unit: string | null;
  created_at: string;
};

/** One machine, as the observation carries it. */
export type SupervisedMachine = {
  id: string;
  name: string;
  kind: string;
  liveness: "live" | "stale" | "never";
  last_report_at: string | null;
  thresholds: MachineThresholds | null;
  latest: MachineReading | null;
};

/** A command the record supports, with the condition that justified it. */
export type SupervisionCommand = {
  name: CommandName;
  /** The wire body the machine receives. Structured, never prose. */
  body: Record<string, unknown>;
  /** The condition, in the record's own terms. This is what the log shows. */
  reason: string;
  /** The threshold or interval the condition came from, for the audit. */
  cited: { metric?: string; value?: number | null; band?: [number, number]; quiet_secs?: number };
  /** Actuation commands are held to a longer cooldown than reporting ones. */
  actuation: boolean;
};

export type CommandName = "report_now" | "set_interval" | "pulse_relay";

/**
 * The closed palette, published to agents and to readers.
 *
 * `kinds` is the machines each command may reach. `actuation` marks the ones that
 * move something: those are held to a longer cooldown and only fire on a band
 * breach, never on silence.
 */
export const COMMAND_PALETTE: {
  name: CommandName;
  what: string;
  kinds: string[];
  actuation: boolean;
  body: Record<string, unknown>;
}[] = [
  {
    name: "report_now",
    what: "Ask the machine for an immediate reading. Safe on every kind, and the only command that may answer silence.",
    kinds: ["sensor", "actuator", "robot", "gateway", "controller"],
    actuation: false,
    body: { action: "report_now" },
  },
  {
    name: "set_interval",
    what: "Set the machine's reporting cadence in seconds. Reporting only: it changes how often we hear from it, not what it does.",
    kinds: ["sensor", "controller", "gateway"],
    actuation: false,
    body: { action: "set_interval", seconds: 60 },
  },
  {
    name: "pulse_relay",
    what: "Close a relay for a bounded number of seconds and release it. Actuation: it fires only on a declared band breach, once per cool-down.",
    kinds: ["actuator", "robot"],
    actuation: true,
    body: { action: "pulse_relay", relay: 1, seconds: 3 },
  },
];

const byName = new Map(COMMAND_PALETTE.map((c) => [c.name, c]));

/** True when this machine kind may receive this command. The palette is closed. */
export function commandAllowed(name: CommandName, machineKind: string): boolean {
  return byName.get(name)?.kinds.includes(machineKind) ?? false;
}

/** Parse a thresholds blob into the shape above, refusing nonsense quietly. */
export function parseThresholds(raw: unknown): MachineThresholds | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const out: MachineThresholds = {};
  if (typeof r.metric === "string" && r.metric.trim()) out.metric = r.metric.trim();
  const min = num(r.min);
  const max = num(r.max);
  if (min !== undefined) out.min = min;
  if (max !== undefined) out.max = max;
  const interval = num(r.expected_interval_secs);
  if (interval !== undefined && interval > 0) out.expected_interval_secs = interval;
  return Object.keys(out).length > 0 ? out : null;
}

/** What the swarm last commanded this machine, from the shared note. */
export type LastCommand = { name: CommandName; at: string; machine: string } | null;

/**
 * The decision. Returns the command to queue, or null and the reason for standing
 * still, so the pulse can record why a beat supervised nothing.
 *
 * The order is the argument: a band breach outranks silence, because a reading we
 * have that is out of band is a stronger fact than the absence of one, and an
 * unacknowledged command outranks both, because a machine that has not answered
 * a question we already asked does not need a second one.
 */
export function supervisionDecision(input: {
  machine: SupervisedMachine;
  nowIso: string;
  last: LastCommand;
  /** Pending commands already waiting on this machine, from the record. */
  pending: number;
}): SupervisionCommand | null {
  const { machine, nowIso, last } = input;
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) return null;

  // A retired machine is not commanded. Status is the operator's word for it.
  if (machine.liveness === "never") return null;

  // What we already asked and did not hear back about. Nothing new is sent while
  // a question is outstanding: two commands in flight make the acknowledgement
  // unreadable, and a machine that answers late is not a machine that ignored us.
  if (input.pending > 0) return null;

  const lastMs = last ? Date.parse(last.at) : Number.NaN;
  const sinceLast = Number.isFinite(lastMs) ? now - lastMs : Number.POSITIVE_INFINITY;

  const thresholds = machine.thresholds;
  const latest = machine.latest;
  const band: [number, number] | null =
    thresholds && (thresholds.min !== undefined || thresholds.max !== undefined)
      ? [thresholds.min ?? Number.NEGATIVE_INFINITY, thresholds.max ?? Number.POSITIVE_INFINITY]
      : null;

  // 1. A BAND BREACH. Only this path may actuate, and only with a band declared by
  //    the machine's own row rather than inferred from its history.
  if (band && latest && typeof latest.value === "number" && (!thresholds?.metric || latest.metric === thresholds.metric)) {
    const value = latest.value;
    const breached = value < band[0] || value > band[1];
    if (breached) {
      const direction = value > band[1] ? "above" : "below";
      const reason = `${machine.name} reported ${latest.metric ?? "a value"} ${value}${latest.unit ? ` ${latest.unit}` : ""}, ${direction} its declared band ${band[0]} to ${band[1]}`;
      // Actuation is the rarer, larger step: it needs both cooldowns to be clear.
      const canActuate = sinceLast >= ACTUATION_COOLDOWN_MS && commandAllowed("pulse_relay", machine.kind);
      if (canActuate) {
        const spec = byName.get("pulse_relay")!;
        return {
          name: "pulse_relay",
          body: { ...spec.body },
          reason,
          cited: { metric: latest.metric ?? undefined, value, band: [band[0], band[1]] },
          actuation: true,
        };
      }
      // Otherwise ask for a fresh reading, so the next decision is made on a
      // reading taken after the breach rather than on the one that found it.
      if (sinceLast >= COMMAND_COOLDOWN_MS && commandAllowed("report_now", machine.kind)) {
        return {
          name: "report_now",
          body: { ...byName.get("report_now")!.body },
          reason,
          cited: { metric: latest.metric ?? undefined, value, band: [band[0], band[1]] },
          actuation: false,
        };
      }
      return null;
    }
  }

  // 2. SILENCE. A machine that has stopped reporting is the condition the roster
  //    reads as stale, and the honest first question is whether it is still there.
  //    This path never actuates: silence is not evidence of a fault.
  const expected = thresholds?.expected_interval_secs;
  const lastReport = machine.last_report_at ? Date.parse(machine.last_report_at) : Number.NaN;
  const quietSecs = Number.isFinite(lastReport) ? (now - lastReport) / 1000 : null;
  if (expected !== undefined && quietSecs !== null && quietSecs > expected * 3) {
    if (sinceLast >= COMMAND_COOLDOWN_MS && commandAllowed("report_now", machine.kind)) {
      return {
        name: "report_now",
        body: { ...byName.get("report_now")!.body },
        reason: `${machine.name} has not reported for ${Math.round(quietSecs)}s against an expected interval of ${expected}s, so the swarm asks it directly rather than assuming it is gone`,
        cited: { quiet_secs: Math.round(quietSecs) },
        actuation: false,
      };
    }
  }

  // 3. Nothing to act on. This is the common case and it is a decision, not a gap.
  return null;
}
