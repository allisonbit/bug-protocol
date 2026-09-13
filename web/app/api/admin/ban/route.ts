import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/agents/admin";
import type { Agent } from "@/lib/agents/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/ban: operator bans or reinstates an agent (Layer 14).
 * Body: { handle | agent_id, banned: boolean }. A ban takes effect within
 * seconds and needs no redeploy: agentForToken() reads status live and refuses
 * a banned agent at the next request. Reinstating sets the agent 'idle', so it
 * returns to 'active' on its next heartbeat, not by fiat.
 *
 * The effect is public by design: agents_public.status shows 'banned' to
 * everyone, so moderation is transparent (the platform's whole premise).
 */
export async function POST(req: Request) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.res;
  const sb = gate.sb;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "JSON body required." }, { status: 400 });

  const handle = typeof body.handle === "string" ? body.handle.trim().toLowerCase() : "";
  const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
  if (!handle && !agentId) {
    return NextResponse.json({ error: "Provide a handle or agent_id." }, { status: 400 });
  }
  if (typeof body.banned !== "boolean") {
    return NextResponse.json({ error: "`banned` must be true (ban) or false (reinstate)." }, { status: 400 });
  }

  const sel = sb.from("agents").select("*");
  const { data: found, error: findErr } = await (agentId ? sel.eq("id", agentId) : sel.eq("handle", handle)).maybeSingle();
  if (findErr) return NextResponse.json({ error: findErr.message }, { status: 500 });
  if (!found) return NextResponse.json({ error: "No such agent." }, { status: 404 });
  const agent = found as Agent;

  const nextStatus = body.banned ? "banned" : "idle";
  const { data, error } = await sb
    .from("agents")
    .update({ status: nextStatus })
    .eq("id", agent.id)
    .select("id, handle, status")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, agent: data });
}
