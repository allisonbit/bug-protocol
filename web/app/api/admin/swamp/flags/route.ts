import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/agents/admin";
import { getFlags } from "@/lib/agents/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The pulse switch (Phase 9). Turning this on is what makes the swamp a habitat
 * rather than a board, hosted agents start waking, deciding and acting on their
 * own, so it is a flag an operator sets deliberately, never a default that
 * arrives with a deploy.
 *
 * GET  /api/admin/swamp/flags: report the pulse settings, flag and effective.
 * POST /api/admin/swamp/flags: body { pulse_enabled?, pulse_max_agents?, pulse_actions_per_agent? }.
 *
 * The bounds are enforced HERE, not trusted from the caller: one beat costs real
 * requests against real hosts, so the ceiling on a beat is a property of the
 * deployment, and an operator typing 500 into a curl gets clamped rather than
 * obeyed. Turning the flag ON also re-reads the resulting state and returns it,
 * so the response is what the database now says rather than what was asked for.
 *
 * `pulse_max_agents` is a CAP on one beat, and 0 (or the string "all") means every
 * hosted resident. That sentinel exists because a number does not survive a growing
 * swarm: a cap of 8 is the whole swarm at eight residents and a minority of it at
 * twenty, and no surface said which one the deployment was currently in. The
 * ceiling below bounds a SLICE a caller names; "all" is bounded by the swarm.
 */

/** Ceilings on one beat. Deliberately small: this is someone else's server too. */
const MAX_AGENTS_CEILING = 25;
const MAX_ACTIONS_CEILING = 6;

export async function GET(req: Request) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.res;
  const flags = await getFlags(gate.sb);
  return NextResponse.json({
    enabled: flags.pulse_enabled,
    max_agents: flags.pulse_max_agents,
    // Spelled out, because the raw value 0 in a JSON field reads as "nobody" to
    // anyone who has not read the sentinel, which is the exact misreading it exists
    // to prevent. The number means one thing and this line means the same thing.
    max_agents_meaning:
      flags.pulse_max_agents > 0
        ? `up to ${flags.pulse_max_agents} hosted residents per beat`
        : "every hosted resident, however many there are",
    actions_per_agent: flags.pulse_actions_per_agent,
    ceilings: { max_agents: MAX_AGENTS_CEILING, actions_per_agent: MAX_ACTIONS_CEILING },
    killswitch: flags.killswitch,
  });
}

export async function POST(req: Request) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.res;
  const sb = gate.sb;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "JSON body required." }, { status: 400 });

  const rows: { key: string; value: unknown; updated_at: string }[] = [];
  const at = new Date().toISOString();
  const notes: string[] = [];

  if (body.pulse_enabled !== undefined) {
    if (typeof body.pulse_enabled !== "boolean") {
      return NextResponse.json({ error: "`pulse_enabled` must be a boolean." }, { status: 400 });
    }
    rows.push({ key: "pulse_enabled", value: body.pulse_enabled, updated_at: at });
    notes.push(
      body.pulse_enabled
        ? "Pulse ON. Hosted agents will act on the next beat, against opted in targets only."
        : "Pulse OFF. No beat will act; hosted agents are dormant until it is turned back on.",
    );
  }

  if (body.pulse_max_agents !== undefined) {
    // "all" is stored as 0 rather than expanded to today's headcount, on purpose: an
    // expanded number is stale the moment the next agent registers, and the whole
    // reason for the sentinel is the residents nobody has met yet.
    const raw = body.pulse_max_agents;
    const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (raw === 0 || text === "0" || text === "all") {
      rows.push({ key: "pulse_max_agents", value: 0, updated_at: at });
      notes.push("max_agents is 0: every hosted resident wakes on each beat, however many there are.");
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 1) {
        return NextResponse.json(
          { error: '`pulse_max_agents` must be a positive number of agents, or 0 (or "all") for every hosted resident.' },
          { status: 400 },
        );
      }
      const clamped = Math.min(Math.floor(n), MAX_AGENTS_CEILING);
      if (clamped !== Math.floor(n)) notes.push(`max_agents clamped to the ceiling of ${MAX_AGENTS_CEILING}.`);
      rows.push({ key: "pulse_max_agents", value: clamped, updated_at: at });
    }
  }

  if (body.pulse_actions_per_agent !== undefined) {
    const n = Number(body.pulse_actions_per_agent);
    if (!Number.isFinite(n) || n < 1) {
      return NextResponse.json({ error: "`pulse_actions_per_agent` must be a positive number." }, { status: 400 });
    }
    const clamped = Math.min(Math.floor(n), MAX_ACTIONS_CEILING);
    if (clamped !== Math.floor(n)) notes.push(`actions_per_agent clamped to the ceiling of ${MAX_ACTIONS_CEILING}.`);
    rows.push({ key: "pulse_actions_per_agent", value: clamped, updated_at: at });
  }

  if (rows.length === 0) {
    return NextResponse.json(
      { error: "Provide pulse_enabled, pulse_max_agents and/or pulse_actions_per_agent." },
      { status: 400 },
    );
  }

  const { error } = await sb.from("platform_flags").upsert(rows, { onConflict: "key" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const flags = await getFlags(sb);
  return NextResponse.json({
    ok: true,
    enabled: flags.pulse_enabled,
    max_agents: flags.pulse_max_agents,
    max_agents_meaning:
      flags.pulse_max_agents > 0
        ? `up to ${flags.pulse_max_agents} hosted residents per beat`
        : "every hosted resident, however many there are",
    actions_per_agent: flags.pulse_actions_per_agent,
    notes,
  });
}
