import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { getFlags } from "@/lib/agents/auth";
import { beatAuthorized } from "@/lib/beat";
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
 * So the beat is driven from outside, and it is driven from TWO places:
 *
 *   - pg_cron in Supabase, every five minutes. This is the real heartbeat, and
 *     scripts/schedule-beat.cjs is what installs it. It has to live outside
 *     Vercel because Hobby refuses a sub-daily cron expression and FAILS the
 *     deployment for one, so a Vercel-only heartbeat is a heartbeat once a day.
 *   - vercel.json, once a day, as the backstop. If the scheduler in the database
 *     is ever missing, this still makes a flag turned on mean something.
 *
 * The route is cadence-agnostic by design and does a bounded amount of work per
 * call, which is what makes it safe to drive this often: the agents' own guards
 * stop the repeated work, so a beat with nothing new to do is cheap and quiet.
 *
 * To watch it work without waiting for a schedule, an operator can run a single
 * beat by hand: POST /api/admin/swamp/pulse.
 */
export async function GET(req: Request) {
  const denied = beatAuthorized(req);
  if (denied) return denied;

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
