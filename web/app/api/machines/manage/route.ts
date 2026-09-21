import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { currentUser, supabaseServer } from "@/lib/supabase/server";
import type { Machine, MachineCommand } from "@/lib/agents/types";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE OWNER'S SIDE OF THE MACHINE DOOR.
 *
 * /api/machines is the machine's side. It speaks a token and reports readings.
 * This door is the human's side. It is signed in like every dashboard route
 * and it issues commands, retires and reactivates the machines you registered.
 *
 *   GET    your machines and the commands still in flight
 *   POST   { action: "issue_command" | "retire" | "reactivate", ... }
 *
 * THE RULE ON COMMANDS. You command machines YOU registered. A machine row
 * carries `owner` for exactly this check. Hardware is not a commons asset, and
 * the alternative, anybody driving anybody's valve, is how a transparency
 * platform becomes a hazard. Once a command is issued the row itself is public
 * like every other row here, so the record of what was asked stays open.
 *
 * NOTHING HERE EXECUTES. A command row waits in `pending`, the machine fetches
 * it on its next report and acknowledges it by id. The platform never reaches
 * out to hardware, so this route records the request and cannot promise the
 * actuation. The statuses after `pending` are all written by the machine.
 */

const MAX_UNDELIVERED_COMMANDS = 10;

function fail(code: string, message: string, status: number, details?: Record<string, unknown>) {
  return NextResponse.json(
    { error: { code, message, details: details ?? {} }, docs: `${SITE_URL}/dashboard/machines` },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/** The signed in caller, or the reason there is none. */
async function requireUser() {
  if (!SUPABASE_CONFIGURED) {
    return { ok: false as const, res: fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503) };
  }
  const user = await currentUser();
  if (!user) {
    return {
      ok: false as const,
      res: fail("SIGN_IN_REQUIRED", "Sign in to manage your machines.", 401, {
        sign_in: `${SITE_URL}/login?next=/dashboard/machines`,
      }),
    };
  }
  return { ok: true as const, user };
}

/**
 * The named machine, only when the caller owns it. A machine registered with
 * no session has a null owner and answers to nobody through this door. Its
 * rows stay public and it keeps reporting, but there is no account that may
 * command it, which is the honest consequence of registering without one.
 */
async function ownedMachine(userId: string, name: unknown) {
  const admin = supabaseAdmin();
  if (!admin) return { ok: false as const, res: fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503) };
  if (typeof name !== "string" || !name.trim()) {
    return { ok: false as const, res: fail("BAD_REQUEST", "`machine` must be the machine's callsign.", 400) };
  }
  const { data: machine } = await admin.from("machines").select("*").eq("name", name.trim().toLowerCase()).maybeSingle();
  if (!machine) {
    return { ok: false as const, res: fail("NO_SUCH_MACHINE", `No machine named "${name.trim()}".`, 404) };
  }
  const m = machine as Machine;
  if (m.owner !== userId) {
    return { ok: false as const, res: fail("NOT_YOURS", "You can only manage machines you registered.", 403) };
  }
  return { ok: true as const, machine: m, admin };
}

// GET: your machines and their commands in flight ------------------------

export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;
  const admin = supabaseAdmin();
  if (!admin) return fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503);

  const [machinesRes, commandsRes] = await Promise.all([
    admin.from("machines").select("*").eq("owner", auth.user.id).order("created_at", { ascending: false }),
    admin
      .from("machine_commands")
      .select("*")
      .in("status", ["pending", "delivered"])
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const machines = (machinesRes.data as Machine[] | null) ?? [];
  const mine = new Set(machines.map((m) => m.id));
  const commands = ((commandsRes.data as MachineCommand[] | null) ?? []).filter((c) => mine.has(c.machine_id));

  return NextResponse.json(
    {
      machines: machines.map((m) => ({
        ...m,
        pending_commands: commands.filter((c) => c.machine_id === m.id && c.status === "pending").length,
      })),
      commands,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

// POST: issue a command, retire, reactivate -------------------------------

export async function POST(req: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;
  const user = auth.user;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return fail("JSON_REQUIRED", 'Send { action, machine } with action one of "issue_command", "retire", "reactivate".', 400, {
      actions: ["issue_command", "retire", "reactivate"],
    });
  }
  const action = body.action;

  if (action === "issue_command") {
    const found = await ownedMachine(user.id, body.machine);
    if (!found.ok) return found.res;
    const { machine, admin } = found;

    if (machine.status === "retired") {
      return fail("MACHINE_RETIRED", `${machine.name} is retired. Reactivate it before issuing commands.`, 409);
    }
    const text = typeof body.body === "string" ? body.body.trim().slice(0, 500) : "";
    if (!text) {
      return fail("BAD_REQUEST", "`body` is the instruction for the machine, 1 to 500 characters, in words the machine's firmware will understand.", 400, {
        example: { action: "issue_command", machine: machine.name, body: "open the vent for 10 minutes" },
      });
    }

    const { count } = await admin
      .from("machine_commands")
      .select("id", { count: "exact", head: true })
      .eq("machine_id", machine.id)
      .in("status", ["pending", "delivered"]);
    if ((count ?? 0) >= MAX_UNDELIVERED_COMMANDS) {
      return fail(
        "QUEUE_FULL",
        `${machine.name} already has ${MAX_UNDELIVERED_COMMANDS} commands waiting to be collected. It collects them when it reports. Wait for its next poll.`,
        429,
      );
    }

    const { data: command, error } = await admin
      .from("machine_commands")
      .insert({ machine_id: machine.id, machine_name: machine.name, body: text, issued_by: user.id })
      .select("*")
      .single();
    if (error) return fail("COMMAND_REFUSED", error.message, 500);

    await admin
      .from("events")
      .insert({
        topic: "machine.command",
        agent_id: null,
        agent_handle: null,
        payload: {
          text: `command issued for ${machine.name}: ${text.slice(0, 160)}`,
          machine: machine.name,
          direction: "issued",
          command: command.id,
        },
        signature: null,
        signed_ok: false,
        provenance: "system",
      })
      .then(undefined, () => null);

    return NextResponse.json(
      {
        ok: true,
        command,
        note: "Held, not sent. The machine picks this up on its next report and acknowledges it by id.",
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  }

  if (action === "retire" || action === "reactivate") {
    const found = await ownedMachine(user.id, body.machine);
    if (!found.ok) return found.res;
    const { machine, admin } = found;
    const status = action === "retire" ? "retired" : "active";
    const { data: updated, error } = await admin
      .from("machines")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", machine.id)
      .select("*")
      .single();
    if (error) return fail("UPDATE_REFUSED", error.message, 500);
    return NextResponse.json(
      {
        ok: true,
        machine: updated,
        note:
          action === "retire"
            ? "Retired machines are refused at the token door and hidden from the public roster. The rows stay. Nothing here deletes."
            : "Active again. The machine's own reports decide its liveness from here.",
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  return fail("UNKNOWN_ACTION", 'action must be "issue_command", "retire" or "reactivate".', 400, {
    actions: ["issue_command", "retire", "reactivate"],
  });
}
