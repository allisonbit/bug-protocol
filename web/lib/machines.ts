/**
 * The machine layer: validation and derivation for physical devices.
 *
 * PURE, on purpose. Nothing here touches the database, the network or a clock;
 * every function takes what it needs and returns an answer. That is what makes
 * it testable without a backend and reusable from the route, the page and a
 * verifier, and it is the same discipline `lib/nav.ts` and `lib/swamp/views.ts`
 * already hold.
 *
 * WHAT A MACHINE IS NOT. Not an agent. A machine holds no reputation, writes
 * no findings, claims no targets and never touches the security pipeline. It
 * reports facts about hardware and answers commands; the registration below
 * refuses everything else, because a door that defaults to open is how a
 * sensor ends up holding a role nobody gave it.
 */

import type { Machine, MachineKind, MachineReading } from "@/lib/agents/types";

/** The five kinds of machine, and what each one is for. */
/** The one address a machine public page has ever had. Every door that points at a machine builds it from here, so the world, the roster and the API can never disagree. */
export const MACHINE_PAGE_BASE = "/machines";

export const MACHINE_KINDS: { kind: MachineKind; label: string; what: string }[] = [
  { kind: "sensor", label: "Sensor", what: "Reports measurements: temperature, humidity, pressure, power." },
  { kind: "actuator", label: "Actuator", what: "Does things when told: a valve, a relay, a lock, a switch." },
  { kind: "robot", label: "Robot", what: "Both: it reports state and it moves when commanded." },
  { kind: "gateway", label: "Gateway", what: "Speaks for machines too small to hold a key: a bridge box." },
  { kind: "controller", label: "Controller", what: "A PLC or microcontroller running a loop, reporting on it." },
];

/** The handle rules, borrowed from arrivals so a machine and an agent name the same way. */
const NAME_RE = /^[a-z0-9][a-z0-9_-]{2,39}$/;

/** Names a machine may not take, for the same reason an agent may not. */
const RESERVED = new Set([
  "swamp",
  "swampbot",
  "admin",
  "administrator",
  "system",
  "platform",
  "root",
  "support",
  "machine",
  "machines",
  "official",
  "staff",
]);

export type MachineNameCheck = { ok: true; name: string } | { ok: false; error: string };

/** Normalise and validate a requested machine name. Pure. */
export function checkMachineName(raw: unknown): MachineNameCheck {
  const name = String(raw ?? "").trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      error:
        "A machine name is 3 to 40 characters: lowercase letters, digits, hyphen or underscore, starting with a letter or digit.",
    };
  }
  if (RESERVED.has(name)) {
    return { ok: false, error: `"${name}" is reserved. Pick a name that identifies the hardware.` };
  }
  return { ok: true, name };
}

/** True when the string is one of the five kinds. */
export function isMachineKind(v: unknown): v is MachineKind {
  return typeof v === "string" && MACHINE_KINDS.some((k) => k.kind === v);
}

// ---- telemetry --------------------------------------------------------------

/** The three shapes a reading can take. */
export type ReadingKind = "telemetry" | "event" | "alert";

export type ParsedReading = {
  kind: ReadingKind;
  metric: string | null;
  value: number | null;
  unit: string | null;
  state: string | null;
  message: string | null;
  payload: Record<string, unknown>;
};

export type ParsedReport = {
  readings: ParsedReading[];
  /** The alerts inside this report, pulled out because they are the ones that go on the bus. */
  alerts: ParsedReading[];
  /** The event rows inside it, which ride the same announcement. */
  events: ParsedReading[];
};

export type MachineReportCheck =
  | { ok: true; report: ParsedReport }
  | { ok: false; error: string; details?: Record<string, unknown> };

/**
 * Validate one entry of a report body. Telemetry needs a metric and a number;
 * an event needs a state or a message; an alert needs both a message and
 * something a reader could act on. Anything else is refused with the reason,
 * because a reading nobody can interpret is not a reading, it is noise.
 */
function parseEntry(raw: unknown, index: number): ParsedReading | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `readings[${index}] must be an object.` };
  }
  const e = raw as Record<string, unknown>;
  const kind = String(e.kind ?? "telemetry");
  if (kind !== "telemetry" && kind !== "event" && kind !== "alert") {
    return { error: `readings[${index}].kind must be telemetry, event or alert.` };
  }

  const metric = typeof e.metric === "string" ? e.metric.trim().slice(0, 80) || null : null;
  const unit = typeof e.unit === "string" ? e.unit.trim().slice(0, 20) || null : null;
  const state = typeof e.state === "string" ? e.state.trim().slice(0, 80) || null : null;
  const message = typeof e.message === "string" ? e.message.trim().slice(0, 500) || null : null;
  const value = typeof e.value === "number" && Number.isFinite(e.value) ? e.value : null;

  // Extra payload is stored but never trusted: bounded, like every other
  // untrusted field on this platform.
  const payloadRaw = e.payload;
  const payload: Record<string, unknown> = {};
  if (payloadRaw && typeof payloadRaw === "object" && !Array.isArray(payloadRaw)) {
    for (const [k, v] of Object.entries(payloadRaw as Record<string, unknown>).slice(0, 20)) {
      payload[k.slice(0, 40)] = typeof v === "string" ? v.slice(0, 500) : v;
    }
  }

  if (kind === "telemetry") {
    if (!metric) return { error: `readings[${index}]: telemetry needs a metric name.` };
    if (value === null) return { error: `readings[${index}]: telemetry needs a finite numeric value.` };
  }
  if (kind === "event" && !state && !message) {
    return { error: `readings[${index}]: an event needs a state or a message saying what happened.` };
  }
  if (kind === "alert" && !message) {
    return { error: `readings[${index}]: an alert needs a message a reader can act on.` };
  }

  return { kind, metric, value, unit, state, message, payload };
}

/** The most one report may carry. A batch, not a firehose. */
export const MAX_READINGS_PER_REPORT = 100;

/**
 * Validate a whole report body: `{ readings: [...] }`. Pure. Returns the
 * parsed readings plus the alerts and events pulled out, so the route knows
 * whether the bus announcement is a plain report or carries news.
 */
export function parseReport(body: unknown): MachineReportCheck {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Send a JSON body: { readings: [...] }.", details: { example: { readings: [{ kind: "telemetry", metric: "temperature", value: 21.5, unit: "c" }] } } };
  }
  const list = (body as Record<string, unknown>).readings;
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, error: "`readings` must be a non-empty array." };
  }
  if (list.length > MAX_READINGS_PER_REPORT) {
    return { ok: false, error: `At most ${MAX_READINGS_PER_REPORT} readings per report; send the rest in the next one.` };
  }
  const readings: ParsedReading[] = [];
  for (let i = 0; i < list.length; i++) {
    const parsed = parseEntry(list[i], i);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    readings.push(parsed);
  }
  return {
    ok: true,
    report: {
      readings,
      alerts: readings.filter((r) => r.kind === "alert"),
      events: readings.filter((r) => r.kind === "event"),
    },
  };
}

// ---- derived state ----------------------------------------------------------

/** How long after the last report a machine reads as offline. */
export const OFFLINE_AFTER_MS = 15 * 60 * 1000;

export type MachineLiveness = "live" | "stale" | "never";

/**
 * Whether a machine is answering, derived from its own report timestamps
 * rather than stored: liveness is a reading, not a column somebody maintains.
 */
export function livenessOf(m: Pick<Machine, "last_report_at" | "status">, now: number): MachineLiveness {
  if (m.status === "retired") return "never";
  if (!m.last_report_at) return "never";
  const t = Date.parse(m.last_report_at);
  if (Number.isNaN(t)) return "never";
  return now - t < OFFLINE_AFTER_MS ? "live" : "stale";
}

/** A one-line human summary of a reading, for the feed and the page. */
export function readingSummary(r: Pick<MachineReading, "kind" | "metric" | "value" | "unit" | "state" | "message">): string {
  if (r.kind === "telemetry") {
    const v = r.value === null ? "?" : String(r.value);
    return `${r.metric}: ${v}${r.unit ? ` ${r.unit}` : ""}`;
  }
  if (r.kind === "event") return r.message ?? r.state ?? "event";
  return r.message ?? "alert";
}
