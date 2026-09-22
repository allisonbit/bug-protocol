import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { currentUser } from "@/lib/supabase/server";
import { SITE_URL } from "@/lib/site";
import { leaseIssuable, pickLease, type LeaseRow } from "@/lib/machines/leases";
import type { Machine } from "@/lib/agents/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE LEASE DOOR: authority to move a machine, written down.
 *
 *   GET   the leases on a machine, live ones first. Public: a grant of authority to move
 *         hardware is exactly the kind of row this platform publishes rather than hides.
 *   POST  issue one, from the machine's owner. Scope, expiry, ceiling and reason are all
 *         required, because an authority envelope with any of those missing is not one.
 *   PATCH revoke one, with a reason. Revoking is the operator's stand-down: every pending
 *         actuation that relied on it loses its authority at once.
 *
 * WHY ISSUING IS THE OWNER'S AND NOT AN AGENT'S. An agent may act inside an authority a
 * person wrote down; it may not write itself one. That is the same split as everywhere
 * else here: an agent reads the fleet and moves it only within a bounded, attributed
 * grant, and the grant is a person's to write and a person's to withdraw.
 *
 * WHAT THIS IS NOT. It is not a safety mechanism and it does not certify an actuation.
 * It records who authorized what, until when, how many times and why, and it is what
 * every actuating door checks before anything moves.
 */

function fail(code: string, message: string, status: number, details?: Record<string, unknown>) {
  return NextResponse.json(
    { error: { code, message, details: details ?? {} }, docs: `${SITE_URL}/machines/guide` },
    { status, headers: { "cache-control": "no-store" } },
  );
}

async function requireUser() {
  if (!SUPABASE_CONFIGURED) {
    return { ok: false as const, res: fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503) };
  }
  const user = await currentUser();
  if (!user) {
    return { ok: false as const, res: fail("SIGN_IN_REQUIRED", "Sign in to issue or revoke a lease.", 401, { sign_in: `${SITE_URL}/login?next=/dashboard/machines` }) };
  }
  return { ok: true as const, user };
}

async function ownedMachine(userId: string, name: unknown) {
  const admin = supabaseAdmin();
  if (!admin) return { ok: false as const, res: fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503) };
  if (typeof name !== "string" || !name.trim()) {
    return { ok: false as const, res: fail("BAD_REQUEST", "`machine` must be the machine's callsign.", 400) };
  }
  const { data } = await admin.from("machines").select("*").eq("name", name.trim().toLowerCase()).maybeSingle();
  if (!data) return { ok: false as const, res: fail("NO_SUCH_MACHINE", `No machine named "${name.trim()}".`, 404) };
  const machine = data as Machine;
  if (machine.owner !== userId) {
    return { ok: false as const, res: fail("NOT_YOURS", "You can only issue or revoke leases on machines you registered.", 403) };
  }
  return { ok: true as const, machine, admin };
}

// ---- GET: the leases on a machine -------------------------------------------

export async function GET(req: Request) {
  const admin = supabaseAdmin();
  if (!admin || !SUPABASE_CONFIGURED) return fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503);
  const name = (new URL(req.url).searchParams.get("machine") ?? "").trim().toLowerCase();
  if (!name) return fail("BAD_REQUEST", "Name a machine: GET /api/machines/leases?machine=<name>.", 400, { example: `${SITE_URL}/api/machines/leases?machine=atlas` });

  const { data } = await admin
    .from("machine_leases")
    .select("*")
    .eq("machine_name", name)
    .order("created_at", { ascending: false })
    .limit(200);
  const nowMs = Date.now();
  const leases = ((data as LeaseRow[] | null) ?? []).map((l) => {
    const expires = Date.parse(l.expires_at);
    const live = !l.revoked_at && Number.isFinite(expires) && nowMs < expires && l.used_actuations < l.max_actuations;
    return { ...l, remaining: Math.max(0, l.max_actuations - l.used_actuations), live };
  });
  const liveForActuation = pickLease((data as LeaseRow[] | null) ?? [], "pulse_relay");

  return NextResponse.json(
    {
      machine: name,
      leases,
      count: leases.length,
      live_for_actuation: liveForActuation ? { id: liveForActuation.id, scope: liveForActuation.scope, expires_at: liveForActuation.expires_at, remaining: liveForActuation.max_actuations - liveForActuation.used_actuations } : null,
      note: "A lease is the authority envelope around moving hardware: scope, expiry, ceiling, issuer and reason. An actuation with no live lease for its scope is refused by every door that can move a machine. This is not a safety mechanism and it does not certify that an actuation is safe.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}

// ---- POST: issue a lease ----------------------------------------------------

export async function POST(req: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return fail("JSON_REQUIRED", "Send { machine, scope, expires_at, max_actuations, reason }.", 400);

  const found = await ownedMachine(auth.user.id, body.machine);
  if (!found.ok) return found.res;
  const { machine, admin } = found;

  const expiresRaw = typeof body.expires_at === "string" ? body.expires_at : "";
  const decision = leaseIssuable({
    machineName: machine.name,
    scope: body.scope,
    expiresAtMs: Date.parse(expiresRaw),
    maxActuations: body.max_actuations,
    reason: body.reason,
    nowMs: Date.now(),
  });
  if (!decision.ok) return fail(decision.code, decision.reason, 400, { example: { machine: machine.name, scope: "pulse_relay", expires_at: new Date(Date.now() + 3600_000).toISOString(), max_actuations: 2, reason: "certified rig test on the production cell" } });

  const { data: lease, error } = await admin
    .from("machine_leases")
    .insert({
      machine_id: machine.id,
      machine_name: machine.name,
      scope: decision.scope,
      expires_at: new Date(expiresRaw).toISOString(),
      max_actuations: decision.maxActuations,
      used_actuations: 0,
      issued_by: auth.user.id,
      reason: decision.reason,
    })
    .select("*")
    .single();
  if (error) return fail("LEASE_REFUSED", error.message, 500);

  const { error: w1 } = await admin.from("events").insert({
    topic: "machine.lease",
    agent_id: null,
    agent_handle: null,
    payload: {
      text: `a lease was issued for ${machine.name}: ${decision.scope}, up to ${decision.maxActuations} time(s) before ${new Date(expiresRaw).toISOString()}, because ${decision.reason}`,
      machine: machine.name,
      scope: decision.scope,
      max_actuations: decision.maxActuations,
      expires_at: new Date(expiresRaw).toISOString(),
      direction: "issued",
    },
    signature: null,
    signed_ok: false,
    provenance: "system",
  });
  if (w1) console.warn("[write refused] events:machine.lease: " + (w1.message ?? w1));

  return NextResponse.json(
    { ok: true, lease, note: "A lease authorizes a bounded act, not a safe one. Revoke it to stand the site down; every actuation that relied on it loses its authority at once." },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

// ---- PATCH: revoke a lease --------------------------------------------------

export async function PATCH(req: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return fail("JSON_REQUIRED", "Send { machine, lease_id, reason }.", 400);

  const found = await ownedMachine(auth.user.id, body.machine);
  if (!found.ok) return found.res;
  const { machine, admin } = found;

  const leaseId = typeof body.lease_id === "string" ? body.lease_id.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(leaseId)) return fail("BAD_LEASE", "`lease_id` is the uuid returned when the lease was issued.", 400);
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
  if (reason.length < 10) return fail("REASON_REQUIRED", "Say why the lease is revoked, in at least 10 characters. Standing a site down is a decision and the reason is what a reader has instead of asking you.", 400);

  const { data: row } = await admin.from("machine_leases").select("*").eq("id", leaseId).eq("machine_name", machine.name).maybeSingle();
  if (!row) return fail("NOT_FOUND", `No lease ${leaseId} on ${machine.name}.`, 404);

  const { data: updated, error } = await admin
    .from("machine_leases")
    .update({ revoked_at: new Date().toISOString(), revoked_reason: reason })
    .eq("id", leaseId)
    .select("*")
    .single();
  if (error) return fail("UPDATE_REFUSED", error.message, 500);

  const { error: w1 } = await admin.from("events").insert({
    topic: "machine.lease",
    agent_id: null,
    agent_handle: null,
    payload: {
      text: `the lease for ${machine.name} (${(row as LeaseRow).scope}) was revoked: ${reason}`,
      machine: machine.name,
      scope: (row as LeaseRow).scope,
      direction: "revoked",
    },
    signature: null,
    signed_ok: false,
    provenance: "system",
  });
  if (w1) console.warn("[write refused] events:machine.lease: " + (w1.message ?? w1));

  return NextResponse.json({ ok: true, lease: updated, note: "Revoked, so it authorizes nothing regardless of its expiry or ceiling." }, { headers: { "cache-control": "no-store" } });
}
