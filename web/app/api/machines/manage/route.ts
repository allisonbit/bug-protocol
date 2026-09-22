import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { currentUser, supabaseServer } from "@/lib/supabase/server";
import type { Machine, MachineCommand } from "@/lib/agents/types";
import type { Release } from "@/lib/machines/releases";
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
 *   POST   { action: "issue_command" | "retire" | "reactivate" | "pin" | "unpin"
 *                   | "yank_release" | "unyank_release", ... }
 *
 * A PIN IS THE FLEET'S OWN ANSWER FOR HARDWARE. An update that failed pins the
 * machine back automatically, and an operator pins one deliberately when a site must
 * not move or a version is certified for a cell. Either way the pin is a public row
 * with a reason, so a robot running old firmware reads as a decision rather than as
 * a machine nobody has looked at.
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

    const { error: w1 } = await admin
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
      if (w1) console.warn("[write refused] events:machine.command: " + (w1.message ?? w1));

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

  // A pin is the operator's answer to "this machine stays here". It is the same
  // action whether the reason is a validation rig that must not move, a site that
  // needs a version it has certified, or an update that failed and held the robot
  // back, which is why the reason is required rather than optional: a pin with no
  // reason is indistinguishable from a machine nobody has looked at.
  if (action === "pin" || action === "unpin") {
    const found = await ownedMachine(user.id, body.machine);
    if (!found.ok) return found.res;
    const { machine, admin } = found;

    if (action === "unpin") {
      const { data: updated, error } = await admin
        .from("machines")
        .update({ pinned_release_id: null, pinned_reason: null, updated_at: new Date().toISOString() })
        .eq("id", machine.id)
        .select("*")
        .single();
      if (error) return fail("UPDATE_REFUSED", error.message, 500);
      return NextResponse.json(
        {
          ok: true,
          machine: updated,
          note: "The pin is cleared, so the next rollout may offer this machine firmware again. Its own reports decide what it actually runs.",
        },
        { headers: { "cache-control": "no-store" } },
      );
    }

    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
    if (!reason) {
      return fail("REASON_REQUIRED", "A pin needs `reason`. Pinning a machine is a decision, and the fleet page shows the reason beside it so a robot running old firmware reads as a choice rather than as neglect.", 400, {
        example: { action: "pin", machine: machine.name, version: "2026.09.1", reason: "certified for the production cell until Friday" },
      });
    }

    // A pin names either a release id or a version on the machine's own channel,
    // because an operator reading a release note knows the version and not the uuid.
    const releaseId = typeof body.release_id === "string" ? body.release_id.trim() : "";
    const version = typeof body.version === "string" ? body.version.trim() : "";
    if (!releaseId && !version) {
      return fail("TARGET_REQUIRED", "A pin names what it holds the machine on: either `release_id`, or `version` with an optional `name`, so the two cannot disagree about which artifact is meant.", 400);
    }

    let query = admin.from("machine_releases").select("*");
    if (releaseId) query = query.eq("id", releaseId);
    else query = query.eq("version", version).eq("name", typeof body.name === "string" && body.name.trim() ? body.name.trim().toLowerCase() : (machine.kind === "robot" ? "swamp-robot" : ""));
    const { data: matches } = await query.limit(5);
    const candidates = (matches as Release[] | null) ?? [];
    if (candidates.length === 0) {
      return fail("NO_SUCH_RELEASE", `No published release matches ${releaseId ? `id ${releaseId}` : `${version}${typeof body.name === "string" ? ` on ${body.name}` : ""}`}. A pin has to name an artifact that exists, or the fleet would offer nothing at all and call it a pin.`, 404);
    }
    if (candidates.length > 1 && !releaseId) {
      return fail("AMBIGUOUS", `${candidates.length} releases carry version ${version}. Send \`release_id\`, one of: ${candidates.map((c) => `${c.id} (${c.name} ${c.channel})`).join(", ")}.`, 409);
    }
    const target = candidates[0];

    const { data: updated, error } = await admin
      .from("machines")
      .update({ pinned_release_id: target.id, pinned_reason: reason, updated_at: new Date().toISOString() })
      .eq("id", machine.id)
      .select("*")
      .single();
    if (error) return fail("UPDATE_REFUSED", error.message, 500);

    const { error: w2 } = await admin
      .from("events")
      .insert({
        topic: "machine.release.offered",
        agent_id: null,
        agent_handle: null,
        payload: {
          text: `${machine.name} pinned to ${target.name} ${target.version}: ${reason}`,
          machine: machine.name,
          release: `${target.name} ${target.version}`,
          count: 1,
          machines: [machine.name],
          pinned: true,
        },
        signature: null,
        signed_ok: false,
        provenance: "system",
      })
      if (w2) console.warn("[write refused] events:machine.release.offered: " + (w2.message ?? w2));

    return NextResponse.json(
      {
        ok: true,
        machine: updated,
        pinned_to: { id: target.id, name: target.name, version: target.version },
        note: "Rollouts skip a pinned machine, so this is the fleet's answer for an update that failed or a site that must not move. Unpin deliberately when the reason no longer holds.",
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  // A bad release has to be stoppable, and stopping it is not the same act as rolling a
  // device back. A yank says "no device may take this" and leaves every device that
  // already took it alone, which is why the row stays: a machine running yanked firmware
  // is exactly the thing an operator needs to be able to see.
  if (action === "yank_release" || action === "unyank_release") {
    const releaseId = String(body.release_id ?? "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(releaseId)) {
      return fail("BAD_RELEASE", "`release_id` is the uuid returned when the release was published.", 400);
    }
    const admin = supabaseAdmin();
    if (!admin) return fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503);

    const { data: releaseRow } = await admin.from("machine_releases").select("*").eq("id", releaseId).maybeSingle();
    const release = releaseRow as Release | null;
    if (!release) return fail("NOT_FOUND", `No release with id ${releaseId}.`, 404);

    // WHO MAY YANK. The publisher, and only the publisher, because a yank reaches every
    // machine that would otherwise have been offered it and that is not a decision to hand
    // to anyone who happens to be signed in. A release nobody is recorded as having
    // published can only be yanked by an operator running a migration, which is said here
    // rather than worked around.
    if (release.published_by && release.published_by !== user.id) {
      return fail("NOT_YOUR_RELEASE", `${release.name} ${release.version} was published by another account. Only the publisher may yank it, because a yank reaches every machine that would have been offered it.`, 403);
    }

    if (action === "unyank_release") {
      const { error } = await admin.from("machine_releases").update({ yanked_at: null, yanked_reason: null }).eq("id", releaseId);
      if (error) return fail("UPDATE_REFUSED", error.message, 500);
      return NextResponse.json(
        {
          ok: true,
          release: { id: release.id, name: release.name, version: release.version },
          note: "Offered again on the next rollout. Every machine that was offered it before is untouched, so stage a rollout when you want it taken.",
        },
        { headers: { "cache-control": "no-store" } },
      );
    }

    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
    if (reason.length < 10) {
      return fail("REASON_REQUIRED", "Say why the release is yanked, in at least 10 characters. A yank is a fleet-wide decision and the reason is what a reader has instead of asking you.", 400, {
        example: { action: "yank_release", release_id: releaseId, reason: "the watchdog resets on boards with the older bootloader" },
      });
    }

    const { error } = await admin
      .from("machine_releases")
      .update({ yanked_at: new Date().toISOString(), yanked_reason: reason })
      .eq("id", releaseId);
    if (error) return fail("UPDATE_REFUSED", error.message, 500);

    // How far it got before the yank, from the target rows rather than from a guess: the
    // number an operator needs is how many devices are already running it.
    const { data: targetRows } = await admin.from("machine_release_targets").select("state").eq("release_id", releaseId);
    const targets = (targetRows as { state: string }[] | null) ?? [];
    const installed = targets.filter((t) => t.state === "installed").length;

    const { error: w3 } = await admin
      .from("events")
      .insert({
        topic: "machine.release.yanked",
        agent_id: null,
        agent_handle: null,
        payload: {
          text: `${release.name} ${release.version} was yanked: ${reason}${installed > 0 ? `. ${installed} machine(s) already run it and are not touched by this.` : ""}`,
          release: `${release.name} ${release.version}`,
          reason,
          installed,
          offered: targets.length,
        },
        signature: null,
        signed_ok: false,
        provenance: "system",
      })
      if (w3) console.warn("[write refused] events:machine.release.yanked: " + (w3.message ?? w3));

    return NextResponse.json(
      {
        ok: true,
        release: { id: release.id, name: release.name, version: release.version },
        yanked_because: reason,
        offered_to: targets.length,
        already_running_it: installed,
        note:
          installed > 0
            ? `${installed} machine(s) already run this and are NOT rolled back by the yank: pulling them would be a rollout of the previous version and that is a separate decision. Pin them, then rollout what they should run instead.`
            : "Nothing had installed it yet, so the yank is the whole of it.",
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  return fail("UNKNOWN_ACTION", 'action must be "issue_command", "retire", "reactivate", "pin", "unpin", "yank_release" or "unyank_release".', 400, {
    actions: ["issue_command", "retire", "reactivate", "pin", "unpin", "yank_release", "unyank_release"],
  });
}
