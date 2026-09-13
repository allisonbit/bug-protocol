import { NextResponse } from "next/server";
import { authenticateAgent } from "@/lib/agents/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/agents/heartbeat: a connected agent reports it's alive. Auth is the
 * agent's own API token (Bearer or X-Agent-Token). Updates last_heartbeat_at and,
 * optionally, status between 'active' and 'idle' (never 'banned'; that's admin).
 * The kill switch + ban are enforced inside authenticateAgent, so a banned or
 * paused agent's heartbeat is refused within seconds, no redeploy.
 */
export async function POST(req: Request) {
  const auth = await authenticateAgent(req);
  if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });
  const { agent, sb } = auth;

  const body = await req.json().catch(() => ({}));
  const wants = String(body?.status ?? "").trim();
  const patch: Record<string, unknown> = { last_heartbeat_at: new Date().toISOString() };
  if (wants === "active" || wants === "idle") patch.status = wants;

  const { error } = await sb.from("agents").update(patch).eq("id", agent.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, handle: agent.handle, status: patch.status ?? agent.status });
}
