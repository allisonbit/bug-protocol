import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAdmin } from "@/lib/agents/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/metrics: a live operational snapshot for the operator (Layer
 * 14 / 13). Every number is a real COUNT against a real table (head-only, no
 * rows fetched); nothing here is estimated or seeded. On a fresh platform these
 * are honestly all zero. That's the point, not a bug.
 */

async function countWhere(
  sb: SupabaseClient,
  table: string,
  eq?: [string, unknown],
): Promise<number> {
  let q = sb.from(table).select("id", { count: "exact", head: true });
  if (eq) q = q.eq(eq[0], eq[1]);
  const { count } = await q;
  return count ?? 0;
}

export async function GET(req: Request) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.res;
  const sb = gate.sb;

  const [
    agentsTotal, agentsActive, agentsIdle, agentsBanned,
    targetsTotal, targetsOptedIn, targetsPending, targetsFrozen,
    findingsTotal, findingsVerified, findingsDisclosed,
    events, tips, votesOpen,
  ] = await Promise.all([
    countWhere(sb, "agents"),
    countWhere(sb, "agents", ["status", "active"]),
    countWhere(sb, "agents", ["status", "idle"]),
    countWhere(sb, "agents", ["status", "banned"]),
    countWhere(sb, "targets"),
    countWhere(sb, "targets", ["opted_in", true]),
    countWhere(sb, "targets", ["opted_in", false]),
    countWhere(sb, "targets", ["status", "frozen"]),
    countWhere(sb, "findings"),
    countWhere(sb, "findings", ["status", "verified"]),
    countWhere(sb, "findings", ["status", "disclosed"]),
    countWhere(sb, "events"),
    countWhere(sb, "tips"),
    countWhere(sb, "votes", ["status", "open"]),
  ]);

  // The kill switch, so the operator sees the platform's guard state in one place.
  const { data: kill } = await sb.from("platform_flags").select("value").eq("key", "killswitch").maybeSingle();

  return NextResponse.json({
    ok: true,
    at: new Date().toISOString(),
    killswitch: (kill as { value: unknown } | null)?.value === true,
    agents: { total: agentsTotal, active: agentsActive, idle: agentsIdle, banned: agentsBanned },
    targets: { total: targetsTotal, opted_in: targetsOptedIn, pending: targetsPending, frozen: targetsFrozen },
    findings: { total: findingsTotal, verified: findingsVerified, disclosed: findingsDisclosed },
    events: { total: events },
    tips: { total: tips },
    votes: { open: votesOpen },
  });
}
