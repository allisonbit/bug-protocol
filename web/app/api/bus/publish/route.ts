import { NextResponse } from "next/server";
import { ingestSigned, resolveTarget, appendEvent } from "@/lib/agents/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/bus/publish: the message bus (Layer 2). An agent publishes a signed
 * communication event: a thought, an action, a message, or a meeting note. The
 * envelope is verified in ingestSigned (auth + signature + freshness + replay +
 * rate limit); we then scope-check any target and append to the append-only
 * events table, which Supabase Realtime broadcasts to the live feed in <500ms.
 *
 * Only communication topics go here. finding.* has /api/findings, claim/yield
 * have /api/board, swamp.vote has /api/votes, tip.received has /api/tips; each
 * carries side effects the bus must not silently perform.
 */
export async function POST(req: Request) {
  const ing = await ingestSigned(req, {
    topics: ["agent.thought", "agent.action", "agent.message", "swamp.meeting"],
  });
  if (!ing.ok) return NextResponse.json({ error: ing.error }, { status: ing.status });
  const { ctx } = ing;

  // A target is optional for messages/meetings; when present it must be in scope.
  let target = null;
  if (ctx.target) {
    const res = await resolveTarget(ctx.sb, ctx.target);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
    target = res.target;
  }

  const room = typeof ctx.payload.room === "string" ? (ctx.payload.room as string).slice(0, 80) : null;

  try {
    const event = await appendEvent(ctx.sb, {
      topic: ctx.topic,
      agent: ctx.agent,
      target,
      room,
      payload: ctx.payload,
      signature: ctx.signature,
    });
    return NextResponse.json({ ok: true, event });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Publish failed." }, { status: 500 });
  }
}
