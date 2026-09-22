import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { authenticateAgent } from "@/lib/agents/auth";
import { SITE_URL } from "@/lib/site";
import type { ToolContext } from "@/lib/mcp/tools";
import { CAPABILITY_TOOLS } from "@/lib/mcp/tools-capabilities";
import {
  STALE_AFTER_MS,
  VDA_VERSION,
  connectionMessage,
  intakeOrder,
  stateFromMachine,
  type CommandLike,
  type ReadingLike,
} from "@/lib/machines/fleet/vda5050";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE FLEET BRIDGE: this platform, as a VDA 5050 robot a fleet can read and dispatch to.
 *
 *   GET   the `state` and `connection` messages for one machine, built from its rows
 *   POST  an `order`, which becomes a queued command the device collects on its poll
 *
 * WHY THIS EXISTS. VDA 5050 over MQTT is what warehouse fleets speak, and a platform
 * holding a machine's row, its reading history and its command queue already has
 * everything a fleet manager needs. Serving those rows in the protocol's shape means an
 * Open-RMF adapter or a vendor master control can treat a machine registered here as a
 * robot in its fleet, rather than as a web page somebody reads beside one.
 *
 * WHY GET IS PUBLIC AND POST IS NOT. A state message is a public record of the same rows
 * every other machine surface already publishes, so reading it costs nothing and hides
 * nothing. An order moves hardware, so it requires an agent key and passes through the
 * SAME closed command palette and cool-down decision the `command_machine` tool runs. A
 * bridge that accepted a free-form instruction from an agent would be the hole in the
 * rule that agents may read the fleet and may not move it, which is why the two doors
 * exist together: the owner's dashboard queues prose, an agent's order queues a palette
 * command, and this door refuses prose with a pointer to the door that takes it.
 *
 * WHAT IT PUBLISHES AND WHAT IT ACCEPTS ARE NOT SYMMETRIC, AND THAT IS ON PURPOSE. The
 * state message carries every queued command including prose ones an owner wrote, because
 * that is what the machine is actually doing. Intake accepts only a palette command. We
 * publish more than we take, which is the honest direction for a rule about actuation.
 *
 * WHAT IT NEVER CLAIMS. This is not a certified VDA 5050 implementation, `safetyState` is
 * carried or reported unknown and never invented, and nothing here asserts a safety
 * function.
 */

function fail(code: string, message: string, status: number, details?: Record<string, unknown>) {
  return NextResponse.json(
    { error: { code, message, details: details ?? {} }, docs: `${SITE_URL}/machines/guide` },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/** The header counter. A wall clock second is monotone enough and readable in a trace. */
function nextHeaderId(): number {
  return Math.floor(Date.now() / 1000);
}

// ---- GET: the state message -------------------------------------------------

export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  if (!SUPABASE_CONFIGURED) return fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503);
  const admin = supabaseAdmin();
  if (!admin) return fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503);

  const { name } = await ctx.params;
  const machineName = String(name ?? "").trim().toLowerCase();
  const { data: machineRow } = await admin.from("machines").select("*").eq("name", machineName).maybeSingle();
  if (!machineRow) {
    return fail("NO_SUCH_MACHINE", `No machine named "${machineName}" is registered here.`, 404, {
      fleet: `${SITE_URL}/.well-known/fleet.json`,
    });
  }
  const machine = machineRow as { name: string; hardware?: string | null; firmware?: string | null; installed_version?: string | null; status?: string | null; last_report_at?: string | null };

  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 200) || 200, 1), 5000);

  const [readingRes, commandRes] = await Promise.all([
    admin
      .from("machine_readings")
      .select("kind, metric, value, unit, state, message, created_at")
      .eq("machine_name", machineName)
      .order("created_at", { ascending: false })
      .limit(limit),
    admin
      .from("machine_commands")
      .select("id, body, status, note, created_at, acked_at")
      .eq("machine_name", machineName)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  const readings = (readingRes.data as ReadingLike[] | null) ?? [];
  const commands = (commandRes.data as CommandLike[] | null) ?? [];
  const nowMs = Date.now();

  const built = stateFromMachine({ machine, readings, commands, headerId: nextHeaderId(), nowMs });
  const conn = connectionMessage({ machine, headerId: nextHeaderId(), nowMs });

  // The visualization summary: where every machine is, in one array, which is what a
  // fleet dashboard draws. Positions come only from readings the device sent.
  const { data: fleetRows } = await admin
    .from("machines")
    .select("name, hardware, status, last_report_at")
    .eq("status", "active")
    .order("name", { ascending: true })
    .limit(500);
  const visualization = [
    {
      serialNumber: machine.name,
      manufacturer: "swampai.world",
      position: built.message.agvPosition,
      state: built.derived.state,
      connection: built.derived.connection,
    },
  ];

  return NextResponse.json(
    {
      protocol: "VDA5050",
      version: VDA_VERSION,
      machine: machine.name,
      connection: conn,
      state: built.message,
      derived: built.derived,
      visualization,
      fleet_size: (fleetRows ?? []).length,
      how_to_read: [
        "`state` is built from this machine's own rows: telemetry becomes agvPosition, velocity and batteryState; alerts become errors; delivered commands become RUNNING actionStates.",
        "An unknown field is reported unknown rather than invented: batteryCharge -1 and agvPosition.positionInitialized false are the standard's unknowns, not a claim of zero.",
        "`derived` says which AGV state the rows support and why, which can differ from what a device claims about itself.",
        "POST an order here to dispatch work; it is queued exactly as a dashboard command and the device collects it on its next poll.",
      ],
      staleness_window_secs: Math.round(STALE_AFTER_MS / 1000),
      note: "This is not a certified VDA 5050 implementation and does not claim conformance. safetyState is carried or reported unknown, never inferred, and nothing here asserts a safety function.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}

// ---- POST: an order ---------------------------------------------------------

export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  if (!SUPABASE_CONFIGURED) return fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503);
  const auth = await authenticateAgent(req);
  if (!auth.ok) {
    return fail(auth.reason === "bad_token" ? "BAD_AGENT_TOKEN" : "AGENT_KEY_REQUIRED", `${auth.message} An order moves hardware, so this door needs an agent key; reading the state message is public.`, auth.status, {
      sign_in: `${SITE_URL}/machines/guide`,
    });
  }

  const admin = supabaseAdmin();
  if (!admin) return fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503);

  const { name } = await ctx.params;
  const machineName = String(name ?? "").trim().toLowerCase();
  const { data: machineRow } = await admin.from("machines").select("*").eq("name", machineName).maybeSingle();
  if (!machineRow) return fail("NO_SUCH_MACHINE", `No machine named "${machineName}" is registered here.`, 404);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return fail("JSON_REQUIRED", "Send a VDA 5050 order object with `orderId`, `orderUpdateId` and at least one released node carrying an action.", 400, {
      example: {
        orderId: "order-1",
        orderUpdateId: 0,
        nodes: [
          {
            nodeId: "n1",
            sequenceId: 0,
            released: true,
            actions: [{ actionId: "a1", actionType: "swampCommand", blockingType: "NONE", actionParameters: [{ key: "command", value: "report_now" }] }],
          },
        ],
      },
    });
  }

  const intake = intakeOrder({
    machine: machineRow as { name: string; status?: string | null },
    order: body as { orderId?: unknown; orderUpdateId?: unknown; nodes?: unknown },
  });
  if (!intake.ok) return fail(intake.code, intake.reason, 400);

  if (!intake.command) {
    return fail(
      "PROSE_NOT_ACCEPTED_HERE",
      "This order carries a free-form `body`, which an agent may not queue directly: the platform issues only its closed palette of commands to hardware, and the condition decides which one applies. Name a `command` parameter instead, or have the machine's owner queue the instruction from the dashboard.",
      400,
      { palette: ["report_now", "set_interval", "pulse_relay"], owner_door: `${SITE_URL}/dashboard/machines` },
    );
  }

  const tool = CAPABILITY_TOOLS.find((t) => t.name === "command_machine");
  if (!tool) return fail("BRIDGE_UNAVAILABLE", "The command gate this bridge depends on is not loaded on this deployment.", 503);

  const toolCtx: ToolContext = {
    sb: auth.sb,
    user: null,
    agent: auth.agent,
    admin,
    siteUrl: SITE_URL,
  };

  const result = await tool.handler(
    {
      machine: machineName,
      command: intake.command,
      ...(typeof intake.params.seconds === "number" ? { seconds: intake.params.seconds } : {}),
      ...(typeof intake.params.interval_secs === "number" ? { interval_secs: intake.params.interval_secs } : {}),
    },
    toolCtx,
  );

  const data = (result.data ?? {}) as { sent?: boolean; allowed?: string; reason?: string; command?: string; actuation?: boolean; cited?: unknown };

  // The order became a command, or the gate stood still. Both are answers a coordinator
  // needs, so a refusal is a 200 with `sent: false` rather than an error a client retries.
  return NextResponse.json(
    {
      protocol: "VDA5050",
      order_id: typeof body.orderId === "string" ? body.orderId : null,
      accepted: data.sent === true,
      queued: data.command ?? null,
      actuation: data.actuation === true,
      because: data.reason ?? null,
      allowed: data.allowed ?? null,
      detail: result.text,
      note:
        data.sent === true
          ? "Queued. The device collects it on its next poll and its acknowledgement lands on the public log; this door never reaches out to hardware."
          : "Nothing was queued. The condition on this machine did not support an order, and standing still is the decision rather than a failure.",
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
