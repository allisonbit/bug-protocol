import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { getFlags } from "@/lib/agents/auth";
import { runPulse } from "@/lib/swamp/pulse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/swamp/pulse: one beat of the habitat (the living-swamp runtime).
 *
 * This is the single place the swamp takes action on its own behalf. It is
 * guarded twice and refuses to be clever about either:
 *
 *   1. CRON_SECRET: Vercel Cron sends `Authorization: Bearer $CRON_SECRET`.
 *      Same pattern as /api/orchestrator/tick: if the secret is unset we still
 *      run (so a fresh deploy isn't dead), but when it IS set we require it.
 *
 *   2. `pulse_enabled`: a platform flag, default FALSE, that must be turned on
 *      deliberately. Unlike the tick, which only advances deadlines that have
 *      already passed, a pulse makes outbound requests to live hosts. A system
 *      like that must not start itself because a branch merged. With the flag
 *      off this returns immediately and writes nothing at all, no events, no
 *      status changes, not even a cursor bump.
 *
 * THE CADENCE. The pulse runs ONE beat and returns. It does not schedule itself:
 * an unbounded self-invoking chain is a runaway that spends money and makes
 * traffic with nobody watching, and a stuck chain is invisible from the outside.
 * So the beat is driven from outside, and vercel.json carries a daily entry for
 * it, the slowest cadence that still means a flag turned on is not a flag that
 * does nothing. On a plan that allows per-minute crons (Pro and above), change
 * that entry's schedule to `* * * * *` and the habitat beats continuously: the
 * route is cadence-agnostic by design and does a bounded amount of work per call.
 * A sub-daily expression on Hobby FAILS the deployment, which is why the default
 * is daily rather than assumed.
 *
 * To watch it work without waiting for a schedule, an operator can run a single
 * beat by hand: POST /api/admin/swamp/pulse.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
  }

  if (!SUPABASE_CONFIGURED) return NextResponse.json({ ok: true, skipped: "backend not configured" });
  const sb = supabaseAdmin();
  if (!sb) return NextResponse.json({ ok: true, skipped: "backend not configured" });

  const flags = await getFlags(sb);
  if (!flags.pulse_enabled) {
    // The honest off state: nothing happened, and here is the switch.
    return NextResponse.json({
      ok: true,
      enabled: false,
      note: "The swamp pulse is off. Set the `pulse_enabled` platform flag to true to let hosted agents act.",
    });
  }

  const report = await runPulse(sb, {
    maxAgents: Math.max(1, flags.pulse_max_agents),
    actionsPerAgent: Math.max(1, flags.pulse_actions_per_agent),
  });
  return NextResponse.json({ ...report, enabled: true });
}
