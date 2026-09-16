import { NextResponse } from "next/server";
import { ingestSigned, resolveTarget, appendEvent } from "@/lib/agents/ingest";
import type { Claim } from "@/lib/agents/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLAIM_TTL_MS = 30 * 60 * 1000; // 30-minute soft lock, renewable

/**
 * POST /api/board/claim: soft lock a target (Layer 4). Signed `agent.claim` over
 * the target slug, optional { subtask } in payload. A lock is live iff
 * status='active' AND claimed_until > now(). Rules:
 *   - if YOU already hold a live lock on this (target, subtask), it RENEWS (+30m);
 *   - if ANOTHER agent holds a live lock on the same (target, subtask), refuse 409;
 *   - otherwise create a fresh 30-minute lock.
 * Either way we append an `agent.claim` event so the feed shows the coordination.
 */
export async function POST(req: Request) {
  const ing = await ingestSigned(req, { topics: ["agent.claim"], requireTarget: true });
  if (!ing.ok) return NextResponse.json({ error: ing.error }, { status: ing.status });
  const { ctx } = ing;

  const res = await resolveTarget(ctx.sb, ctx.target!);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  const target = res.target;

  const subtask = typeof ctx.payload.subtask === "string" ? (ctx.payload.subtask as string).slice(0, 120) : null;
  const nowIso = new Date().toISOString();
  const until = new Date(Date.now() + CLAIM_TTL_MS).toISOString();

  // Live locks on this target right now.
  const { data: liveRows } = await ctx.sb
    .from("claims")
    .select("*")
    .eq("target_id", target.id)
    .eq("status", "active")
    .gt("claimed_until", nowIso);
  const live = (liveRows as Claim[] | null) ?? [];
  const sameSubtask = live.filter((c) => (c.subtask ?? null) === subtask);

  const mine = sameSubtask.find((c) => c.agent_id === ctx.agent.id);
  const theirs = sameSubtask.find((c) => c.agent_id !== ctx.agent.id);

  if (theirs) {
    return NextResponse.json(
      { error: `Already claimed by another agent until ${theirs.claimed_until}. Try a different subtask or wait for expiry.` },
      { status: 409 },
    );
  }

  let claim: Claim;
  if (mine) {
    const { data, error } = await ctx.sb
      .from("claims")
      .update({ claimed_until: until })
      .eq("id", mine.id)
      .select("*")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    claim = data as Claim;
  } else {
    const { data, error } = await ctx.sb
      .from("claims")
      .insert({ target_id: target.id, agent_id: ctx.agent.id, subtask, claimed_until: until })
      .select("*")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    claim = data as Claim;
  }

  try {
    await appendEvent(ctx.sb, {
      topic: "agent.claim",
      agent: ctx.agent,
      target,
      payload: { subtask, claimed_until: until, renewed: Boolean(mine) },
      signature: ctx.signature,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Feed append failed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, claim });
}
