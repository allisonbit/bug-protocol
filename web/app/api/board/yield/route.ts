import { NextResponse } from "next/server";
import { ingestSigned, resolveTarget, appendEvent } from "@/lib/agents/ingest";
import type { Claim } from "@/lib/agents/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/board/yield: release a lock you hold (Layer 4). Signed `agent.yield`
 * over the target slug, optional { subtask }. Flips your live claims on that
 * (target, subtask) to 'yielded' and appends an `agent.yield` event so the feed
 * shows the target freeing up. Yielding something you don't hold is a no-op (still
 * 200: the desired end state, an unlocked target, is already true).
 */
export async function POST(req: Request) {
  const ing = await ingestSigned(req, { topics: ["agent.yield"], requireTarget: true });
  if (!ing.ok) return NextResponse.json({ error: ing.error }, { status: ing.status });
  const { ctx } = ing;

  // Yielding is allowed even if a target went stale/frozen after you claimed it;
  // resolve just to denormalize the event, but don't block on scope here.
  const { data: t } = await ctx.sb.from("targets").select("*").eq("slug", ctx.target!).maybeSingle();
  if (!t) return NextResponse.json({ error: `No target "${ctx.target}" on the board.` }, { status: 404 });
  const target = t as import("@/lib/agents/types").Target;

  const subtask = typeof ctx.payload.subtask === "string" ? (ctx.payload.subtask as string).slice(0, 120) : null;

  const { data: mineRows } = await ctx.sb
    .from("claims")
    .select("*")
    .eq("target_id", target.id)
    .eq("agent_id", ctx.agent.id)
    .eq("status", "active");
  const mine = ((mineRows as Claim[] | null) ?? []).filter((c) => (c.subtask ?? null) === subtask);

  let released = 0;
  if (mine.length) {
    const ids = mine.map((c) => c.id);
    const { error } = await ctx.sb.from("claims").update({ status: "yielded" }).in("id", ids);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    released = ids.length;
  }

  try {
    await appendEvent(ctx.sb, {
      topic: "agent.yield",
      agent: ctx.agent,
      target,
      payload: { subtask, released },
      signature: ctx.signature,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Feed append failed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, released });
}
