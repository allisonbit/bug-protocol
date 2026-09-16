import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { SUPABASE_CONFIGURED } from "@/lib/supabase/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/agents/runtime: owner switches an agent between owner run and
 * Swamp hosted, and picks which brain decides its actions.
 *
 * The write runs on the CALLER'S session, not the service role, so ownership is
 * enforced by the `agents_update_own` RLS policy rather than by a check here,
  * which means a bug in this file cannot widen who is allowed to flip someone
 * else's agent. The agent_id is the only input; everything else is derived.
 *
 * Why this is safe to offer self-serve, when `targets.opted_in` is service-role
 * only: an owner authorises work on their OWN agent, and a hosted agent gets no
 * extra reach, every action still resolves through the target fence. What an
 * owner is actually deciding is who runs the policy, and the honest consequence
 * is stated in the response they get back: hosted events are labelled `runtime`
 * and are not key signed, because Swamp does not hold their private key. Their
 * own client can keep connecting with the same identity, and its writes stay
 * key verifiable.
 */

export async function POST(req: Request) {
  if (!SUPABASE_CONFIGURED) {
    return NextResponse.json({ error: "The swamp backend isn't configured on this deployment yet." }, { status: 503 });
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body.agent_id !== "string" || !body.agent_id) {
    return NextResponse.json({ error: "`agent_id` is required." }, { status: 400 });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.runtime_enabled === "boolean") patch.runtime_enabled = body.runtime_enabled;
  if (body.brain === "reflex" || body.brain === "model") patch.brain = body.brain;
  if (Object.keys(patch).length === 1) {
    return NextResponse.json({ error: "Nothing to change: pass `runtime_enabled` and/or `brain`." }, { status: 400 });
  }

  const sb = await supabaseServer();
  if (!sb) {
    return NextResponse.json({ error: "The swamp backend isn't configured on this deployment yet." }, { status: 503 });
  }
  const { data: userData } = await sb.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ error: "Sign in to change an agent's hosting." }, { status: 401 });
  }

  // No owner check in code: RLS refuses the update if this agent isn't the
  // caller's, and `.select()` then returns zero rows rather than a lie.
  const { data, error } = await sb
    .from("agents")
    .update(patch)
    .eq("id", body.agent_id)
    .select("id, handle, brain, runtime_enabled")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) {
    return NextResponse.json({ error: "No agent with that id belongs to you." }, { status: 404 });
  }

  const row = data as { id: string; handle: string; brain: string; runtime_enabled: boolean };
  return NextResponse.json({
    ok: true,
    agent: row,
    note: row.runtime_enabled
      ? `Swamp will run @${row.handle}'s ${row.brain} runtime on the next pulse. Its events are labelled runtime, attributable, not key signed. Nothing happens while the pulse is off, and a hosted agent can only act against an opted in target.`
      : `@${row.handle} is owner run again. Swamp writes nothing for it; only its owner's connected client can.`,
  });
}
