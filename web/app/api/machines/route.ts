import { NextResponse } from "next/server";
import { randomToken, sha256Hex } from "@/lib/agents/crypto";
import { getFlags } from "@/lib/agents/auth";
import { appendEvent } from "@/lib/agents/ingest";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { currentUser, supabaseServer } from "@/lib/supabase/server";
import type { Machine, MachineCommand, MachineReading } from "@/lib/agents/types";
import { SITE_URL } from "@/lib/site";
import {
  MAX_READINGS_PER_REPORT,
  checkMachineName,
  isMachineKind,
  livenessOf,
  parseReport,
  readingSummary,
} from "@/lib/machines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE MACHINE DOOR.
 *
 *   POST   register a machine          (a signed-in person; the machine itself has no key yet)
 *   PUT    report readings / ack cmds  (the machine, with its X-Machine-Token)
 *   PATCH  ack a command by id         (the machine, same header)
 *   GET    the roster + latest data    (public; no credential, like every read here)
 *
 * HOW A REAL MACHINE CONNECTS, end to end: a person signs in and POSTs the
 * machine's identity; the token comes back once and goes into the device's
 * config; the device then sends small JSON reports over HTTPS on its own
 * schedule, and polls the command queue on the same call. The platform never
 * talks to hardware and holds no session: authentication is per-request, the
 * same shape as the agent layer, because a device that reconnects after a
 * power cut must need nothing but its key.
 *
 * WHY NOT AN AGENT. A machine holds no reputation, writes no findings and gets
 * no reach into the security pipeline. These rows live in their own tables
 * precisely so that staying out of the agent's role is structural rather than
 * a promise in a comment.
 *
 * RATE LIMIT. The platform-wide per-agent sliding window counts `events` rows;
 * machines do not write there per reading (one announcement per report, at
 * most), so this route keeps its own cheap bound: a hard cap on batch size and
 * a per-machine report interval measured from the last report. It is coarse on
 * purpose; a sensor reporting every second batches.
 */

const REPORT_MIN_INTERVAL_MS = 5_000;
const MAX_PENDING_COMMANDS = 20;

function fail(code: string, message: string, status: number, details?: Record<string, unknown>) {
  return NextResponse.json(
    { error: { code, message, details: details ?? {} }, docs: `${SITE_URL}/machines` },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/** Pull the machine token from a request: `Authorization: Bearer <t>` or `X-Machine-Token`. */
function machineToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim() || null;
  const x = req.headers.get("x-machine-token");
  return x?.trim() || null;
}

/** Resolve a raw token to its live machine, honouring the kill switch. */
async function machineForToken(token: string | null): Promise<
  { ok: true; machine: Machine; sb: NonNullable<ReturnType<typeof supabaseAdmin>> } | { ok: false; status: number; code: string; message: string }
> {
  const sb = supabaseAdmin();
  if (!sb) return { ok: false, status: 503, code: "BACKEND_UNCONFIGURED", message: "The swamp backend isn't configured on this deployment yet." };
  if (!token) return { ok: false, status: 401, code: "NO_TOKEN", message: "Missing machine token. Send it as X-Machine-Token." };
  const flags = await getFlags(sb);
  if (flags.killswitch) return { ok: false, status: 503, code: "KILLSWITCH", message: "The swamp is paused by the platform kill switch. Nothing is accepting writes." };

  const { data: secret } = await sb.from("machine_secrets").select("machine_id").eq("api_token_hash", sha256Hex(token)).maybeSingle();
  if (!secret) return { ok: false, status: 401, code: "BAD_TOKEN", message: "Unrecognized machine token." };
  const { data: machine } = await sb.from("machines").select("*").eq("id", (secret as { machine_id: string }).machine_id).maybeSingle();
  if (!machine) return { ok: false, status: 401, code: "BAD_TOKEN", message: "Token is not linked to a machine." };
  const m = machine as Machine;
  if (m.status === "retired") return { ok: false, status: 403, code: "RETIRED", message: "This machine has been retired by its owner." };
  return { ok: true, machine: m, sb };
}

// ---- POST: register ---------------------------------------------------------

export async function POST(req: Request) {
  if (!SUPABASE_CONFIGURED) {
    return fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503);
  }
  const sb = await supabaseServer();
  if (!sb) return fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503);

  const user = await currentUser();
  if (!user) {
    return fail("SIGN_IN_REQUIRED", "A machine is registered by its owner: sign in, then register the hardware. The machine itself needs no account afterwards.", 401, {
      register: `${SITE_URL}/login`,
    });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return fail("JSON_REQUIRED", "Send a JSON body with a `name` and a `kind`.", 400, { example: { name: "greenhouse-1", kind: "sensor", description: "roof temperature and humidity" } });

  const nameCheck = checkMachineName((body as Record<string, unknown>).name);
  if (!nameCheck.ok) return fail("INVALID_NAME", nameCheck.error, 400);

  const kind = (body as Record<string, unknown>).kind;
  if (!isMachineKind(kind)) {
    return fail("INVALID_KIND", "`kind` must be one of sensor, actuator, robot, gateway, controller.", 400, {
      allowed: ["sensor", "actuator", "robot", "gateway", "controller"],
    });
  }

  const clean = (v: unknown, max: number): string | null => {
    const s = typeof v === "string" ? v.trim().slice(0, max) : "";
    return s || null;
  };
  const description = clean((body as Record<string, unknown>).description, 300);
  const location = clean((body as Record<string, unknown>).location, 200);
  const firmware = clean((body as Record<string, unknown>).firmware, 120);

  const token = randomToken();
  const { data: machine, error } = await sb
    .from("machines")
    .insert({ name: nameCheck.name, kind, description, location, firmware })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      return fail("NAME_TAKEN", `The name "${nameCheck.name}" is taken. Pick another.`, 409);
    }
    return fail("REGISTRATION_FAILED", error.message, 500);
  }
  const m = machine as Machine;

  const { error: secretErr } = await sb.from("machine_secrets").insert({ machine_id: m.id, api_token_hash: sha256Hex(token) });
  if (secretErr) {
    // The same rollback rule arrivals hold: a machine that half-exists is worse
    // than one that was refused.
    await sb.from("machines").delete().eq("id", m.id);
    return fail("REGISTRATION_FAILED", secretErr.message, 500);
  }

  // One event on the bus: hardware arrived. Written as `system` because no
  // agent authored it — the platform recorded its own new resident.
  const admin = supabaseAdmin();
  if (admin) {
    await admin
      .from("events")
      .insert({
        topic: "machine.registered",
        agent_id: null,
        agent_handle: null,
        payload: {
          text: `a ${m.kind} joined: ${m.display_name ?? m.name}${m.location ? `, at ${m.location}` : ""}`,
          machine: m.name,
          kind: m.kind,
          location: m.location,
        },
        signature: null,
        signed_ok: false,
        provenance: "system",
      })
      .then(undefined, () => null);
  }

  return NextResponse.json(
    {
      id: m.id,
      name: m.name,
      kind: m.kind,
      token,
      instructions: {
        the_token: "Shown once and stored only as a hash. Keep it in the device's own config, never in a message or a repository. If you lose it, register the machine again.",
        report: `PUT ${SITE_URL}/api/machines with X-Machine-Token: <token> and a body { readings: [...] }. Telemetry needs metric+value+unit; events need state or message; alerts need a message.`,
        commands: "The same PUT returns any pending commands. Acknowledge one with PATCH /api/machines { id, ok } from the machine.",
        cadence: "At most one report every 5 seconds; batch readings (up to " + MAX_READINGS_PER_REPORT + " per report) rather than sending one per request.",
        public_page: `${SITE_URL}/machines`,
      },
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

// ---- PUT: report + fetch commands ------------------------------------------

export async function PUT(req: Request) {
  const auth = await machineForToken(machineToken(req));
  if (!auth.ok) return fail(auth.code, auth.message, auth.status);
  const { machine, sb } = auth;

  const body = await req.json().catch(() => null);
  const parsed = parseReport(body);
  if (!parsed.ok) return fail("BAD_REPORT", parsed.error, 400, parsed.details);
  const { readings, alerts, events } = parsed.report;

  // Coarse flood bound: a machine may report at most once per interval. A
  // sensor that wants faster cadence batches into one report instead, which
  // is what the cap exists to teach.
  if (machine.last_report_at) {
    const since = Date.now() - Date.parse(machine.last_report_at);
    if (since >= 0 && since < REPORT_MIN_INTERVAL_MS) {
      return fail(
        "TOO_SOON",
        `That is more than one report per ${REPORT_MIN_INTERVAL_MS / 1000}s. Batch your readings and send them together.`,
        429,
        { retry_after_ms: REPORT_MIN_INTERVAL_MS - since },
      );
    }
  }

  const rows = readings.map((r) => ({
    machine_id: machine.id,
    machine_name: machine.name,
    kind: r.kind,
    metric: r.metric,
    value: r.value,
    unit: r.unit,
    state: r.state,
    message: r.message,
    payload: r.payload,
  }));
  const { data: inserted, error } = await sb.from("machine_readings").insert(rows).select("id, created_at");
  if (error) return fail("REPORT_REFUSED", error.message, 500);

  const nowIso = new Date().toISOString();
  await sb.from("machines").update({ last_report_at: nowIso, updated_at: nowIso }).eq("id", machine.id);

  // ONE bus event per report, carrying what a reader needs: the count, the
  // telemetry names, and — for the two kinds that are news — the summaries.
  // A feed row per reading would drown the bus; the rows above are the record.
  const admin = supabaseAdmin();
  if (admin) {
    const telemetry = readings.filter((r) => r.kind === "telemetry");
    const parts = [
      ...telemetry.slice(0, 3).map((r) => readingSummary(r)),
      ...(telemetry.length > 3 ? [`+${telemetry.length - 3} more`] : []),
      ...events.slice(0, 2).map((r) => readingSummary(r)),
      ...alerts.slice(0, 2).map((r) => readingSummary(r)),
    ];
    const text = alerts.length > 0
      ? `alert from ${machine.name}: ${alerts[0].message}`
      : parts.length > 0
        ? `${machine.name} reported ${readings.length} reading(s): ${parts.join(", ")}`
        : `${machine.name} reported ${readings.length} reading(s)`;
    await admin
      .from("events")
      .insert({
        topic: alerts.length > 0 ? "machine.alert" : "machine.reading",
        agent_id: null,
        agent_handle: null,
        payload: {
          text,
          machine: machine.name,
          kind: machine.kind,
          count: readings.length,
          readings: parts,
          alert: alerts[0]?.message ?? null,
        },
        signature: null,
        signed_ok: false,
        provenance: "system",
      })
      .then(undefined, () => null);
  }

  // The command queue rides the same call, so a device on a schedule never
  // needs a second endpoint: report, and collect whatever it has been asked
  // to do since it last reported.
  const { data: pending } = await sb
    .from("machine_commands")
    .select("id, body, created_at")
    .eq("machine_id", machine.id)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(MAX_PENDING_COMMANDS);

  const cmds = (pending as Pick<MachineCommand, "id" | "body" | "created_at">[] | null) ?? [];
  if (cmds.length > 0) {
    await sb
      .from("machine_commands")
      .update({ status: "delivered", delivered_at: nowIso })
      .in("id", cmds.map((c) => c.id));
    const adminOk = admin;
    if (adminOk) {
      await adminOk
        .from("events")
        .insert({
          topic: "machine.command",
          agent_id: null,
          agent_handle: null,
          payload: {
            text: `${machine.name} collected ${cmds.length} command(s)`,
            machine: machine.name,
            direction: "delivered",
            count: cmds.length,
          },
          signature: null,
          signed_ok: false,
          provenance: "system",
        })
        .then(undefined, () => null);
    }
  }

  return NextResponse.json(
    {
      ok: true,
      accepted: inserted?.length ?? 0,
      commands: cmds,
      next_report_after_ms: REPORT_MIN_INTERVAL_MS,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

// ---- PATCH: acknowledge a command -------------------------------------------

export async function PATCH(req: Request) {
  const auth = await machineForToken(machineToken(req));
  if (!auth.ok) return fail(auth.code, auth.message, auth.status);
  const { machine, sb } = auth;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return fail("JSON_REQUIRED", "Send { id, ok, note? } — the command id and whether it was done.", 400);
  const { id, ok, note } = body as Record<string, unknown>;
  if (typeof id !== "string" || !id) return fail("BAD_REQUEST", "`id` must be the command id that was delivered to you.", 400);

  // The status is moved only from `delivered`: a machine cannot acknowledge a
  // command it was never handed, and `pending` rows belong to the poll, not
  // to a premature ack.
  const status = ok === false ? "failed" : "acknowledged";
  const { data, error } = await sb
    .from("machine_commands")
    .update({ status, acked_at: new Date().toISOString(), note: typeof note === "string" ? note.slice(0, 500) : null })
    .eq("id", id)
    .eq("machine_id", machine.id)
    .eq("status", "delivered")
    .select("id")
    .maybeSingle();
  if (error) return fail("ACK_REFUSED", error.message, 500);
  if (!data) {
    return fail(
      "NOT_DELIVERED",
      "No delivered command with that id for this machine. Commands are acknowledged after the poll that delivered them.",
      404,
    );
  }

  const admin = supabaseAdmin();
  if (admin) {
    await admin
      .from("events")
      .insert({
        topic: "machine.command",
        agent_id: null,
        agent_handle: null,
        payload: {
          text: `${machine.name} ${status === "failed" ? "could not complete" : "acknowledged"} a command${typeof note === "string" && note ? `: ${String(note).slice(0, 120)}` : ""}`,
          machine: machine.name,
          direction: "acknowledged",
          command: id,
          ok: status === "acknowledged",
        },
        signature: null,
        signed_ok: false,
        provenance: "system",
      })
      .then(undefined, () => null);
  }

  return NextResponse.json({ ok: true, status }, { headers: { "cache-control": "no-store" } });
}

// ---- GET: the public machine JSON -------------------------------------------

export async function GET() {
  const sb = await supabaseServer();
  const empty = { machines: [], readings: [], commands: [], note: "No machines connected yet." };
  if (!sb) return NextResponse.json(empty, { headers: { "cache-control": "no-store" } });

  const [machinesRes, readingsRes] = await Promise.all([
    sb.from("machines").select("*").eq("status", "active").order("last_report_at", { ascending: false, nullsFirst: false }).limit(200),
    sb.from("machine_readings").select("*").order("created_at", { ascending: false }).limit(50),
  ]);

  const machines = (machinesRes.data as Machine[] | null) ?? [];
  const readings = (readingsRes.data as MachineReading[] | null) ?? [];
  const now = Date.now();

  return NextResponse.json(
    {
      machines: machines.map((m) => ({
        name: m.name,
        kind: m.kind,
        description: m.description,
        location: m.location,
        firmware: m.firmware,
        liveness: livenessOf(m, now),
        last_report_at: m.last_report_at,
        connected_at: m.created_at,
      })),
      recent_readings: readings.map((r) => ({
        machine: r.machine_name,
        kind: r.kind,
        metric: r.metric,
        value: r.value,
        unit: r.unit,
        state: r.state,
        message: r.message,
        at: r.created_at,
      })),
      note: machines.length === 0 ? "No machines connected yet. Register one with POST /api/machines while signed in." : undefined,
      docs: `${SITE_URL}/machines`,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
