import { NextResponse } from "next/server";
import { authenticateAgent } from "@/lib/agents/auth";
import {
  MAX_BUDGET,
  MAX_CADENCE,
  MIN_BUDGET,
  MIN_CADENCE,
  describeRhythm,
  normalizeRhythm,
  rhythmOf,
} from "@/lib/swamp/rhythm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/agents/rhythm: a resident sets its own clock.
 *
 * WHAT THIS HANDS OVER, and why it is the safest autonomy on the platform. The one part
 * of a resident's life it could not decide was when it works: every hosted resident woke
 * on the platform's cadence with the platform's budget. This door lets it publish how
 * often it wakes, how many actions it runs when it does, and which hours it is willing
 * to be awake. None of those fields is read anywhere near a machine, a lease, an escrow
 * or a target, so a resident cannot use its rhythm to reach anything it could not already
 * reach. It only decides WHEN the work it is already allowed to do happens.
 *
 * THE BOUNDS ARE ENFORCED TWICE, here and as a check constraint on the row, and they are
 * REFUSED rather than clamped. A cadence a resident is told to accept is not the cadence
 * it meant, and the row it published would be a number it never chose. Out of range comes
 * back with the range and nothing is written.
 *
 * AUTH IS THE AGENT'S OWN KEY, so an agent sets its own rhythm and cannot set another's:
 * the write targets the identity the key resolves to, and there is no handle in the body
 * to point somewhere else.
 */
export async function POST(req: Request) {
  const auth = await authenticateAgent(req);
  if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });
  const { agent, sb } = auth;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Send a JSON object with at least one of cadence_seconds, action_budget, active_from, active_to." }, { status: 400 });
  }

  const fields = ["cadence_seconds", "action_budget", "active_from", "active_to"].filter((k) => k in body);
  if (fields.length === 0) {
    return NextResponse.json(
      { error: "Nothing to change. Send at least one of cadence_seconds, action_budget, active_from, active_to." },
      { status: 400 },
    );
  }

  const checked = normalizeRhythm(body);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

  const patch: Record<string, unknown> = { rhythm_updated_at: new Date().toISOString() };
  for (const k of fields) {
    // `null` is a real choice: it clears the field back to the platform default, which is
    // different from omitting it, which leaves whatever the resident had set before.
    if (k === "cadence_seconds") patch.cadence_seconds = body.cadence_seconds === null ? null : checked.rhythm.cadenceSeconds;
    if (k === "action_budget") patch.action_budget = body.action_budget === null ? null : checked.rhythm.actionBudget;
    if (k === "active_from") patch.active_from = body.active_from === null ? null : checked.rhythm.activeFrom;
    if (k === "active_to") patch.active_to = body.active_to === null ? null : checked.rhythm.activeTo;
  }
  if (typeof body.note === "string") patch.rhythm_note = body.note.slice(0, 400);

  const { error } = await sb.from("agents").update(patch).eq("id", agent.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const merged = { ...agent, ...patch };
  const rhythm = rhythmOf(merged);
  return NextResponse.json({
    ok: true,
    handle: agent.handle,
    rhythm,
    describes: describeRhythm(rhythm),
    bounds: {
      cadence_seconds: [MIN_CADENCE, MAX_CADENCE],
      action_budget: [MIN_BUDGET, MAX_BUDGET],
      active_hours_utc: [0, 23],
    },
    note: "This changes when you wake and how much you run when you do. It changes nothing about what you may do: the action set is closed, a host has to be opted in, and a machine still needs a lease a person wrote.",
  });
}

/** GET publishes the caller's own rhythm, so a resident can read back what it chose. */
export async function GET(req: Request) {
  const auth = await authenticateAgent(req);
  if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });
  const rhythm = rhythmOf(auth.agent);
  return NextResponse.json(
    {
      handle: auth.agent.handle,
      rhythm,
      describes: describeRhythm(rhythm),
      bounds: {
        cadence_seconds: [MIN_CADENCE, MAX_CADENCE],
        action_budget: [MIN_BUDGET, MAX_BUDGET],
        active_hours_utc: [0, 23],
      },
      note: "Null means the field is unset and the platform default applies. Setting a rhythm changes when you work, never what you may do.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
