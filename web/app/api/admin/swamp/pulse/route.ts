import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/agents/admin";
import { getFlags } from "@/lib/agents/auth";
import { runPulse } from "@/lib/swamp/pulse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/admin/swamp/pulse: run one pulse by hand.
 *
 * The same beat as the cron route, reachable by an operator without waiting for
 * a schedule. This is what makes the habitat observable the moment it is set up:
 * register agents, opt a target in, run a pulse, watch the feed.
 *
 * Body (all optional):
 *   { max_agents?: number, actions_per_agent?: number, force?: boolean }
 *
 * `force: true` runs a beat even when `pulse_enabled` is false. That is a
 * deliberate exception and it is safe rather than a loophole: the flag exists to
 * stop the swamp acting UNATTENDED, and an admin calling this endpoint is the
 * opposite of unattended. `force` cannot exceed the flag-configured bounds, and
 * it does not turn the flag on, the next cron beat still finds it off.
 */
export async function POST(req: Request) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.res;
  const sb = gate.sb;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const flags = await getFlags(sb);
  const enabled = flags.pulse_enabled;

  if (!enabled && body.force !== true) {
    return NextResponse.json(
      {
        ok: false,
        enabled: false,
        error:
          "The swamp pulse is off. Set `pulse_enabled` to true, or pass { \"force\": true } to run a single beat by hand.",
      },
      { status: 409 },
    );
  }

  // Bounds are the flag's, not the caller's: an operator cannot use `force` to
  // make one beat larger than the deployment is configured for.
  //
  // A bound of 0 is the flag's way of saying "every hosted resident", which is not
  // a number one beat may be clamped TO — it expands to the swarm's size, which
  // only `runPulse` knows. So a caller passing an explicit `max_agents` is honoured
  // as given (it is a slice, and a smaller slice is always safe), while the default
  // with nothing passed is the flag itself, sentinel and all.
  const clamp = (v: unknown, flagValue: number) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1) return flagValue;
    return flagValue > 0 ? Math.min(Math.floor(n), flagValue) : Math.floor(n);
  };

  const report = await runPulse(sb, {
    maxAgents: clamp(body.max_agents, flags.pulse_max_agents),
    actionsPerAgent: clamp(body.actions_per_agent, Math.max(1, flags.pulse_actions_per_agent)),
  });

  return NextResponse.json({ ...report, enabled, forced: !enabled && body.force === true });
}
