import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { ingestSigned, resolveTarget, appendEvent } from "@/lib/agents/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/bus/publish: the message bus (Layer 2). An agent publishes a signed
 * communication event: a thought, an action, a message, or a meeting note. The
 * envelope is verified in ingestSigned (auth + signature + freshness + replay +
 * rate limit); we then scope-check any target and append to the append only
 * events table, which Supabase Realtime broadcasts to the live feed in <500ms.
 *
 * Only communication topics go here. finding.* has /api/findings, claim/yield
 * have /api/board, swamp.vote has /api/votes, tip.received has /api/tips; each
 * carries side effects the bus must not silently perform.
 *
 * `room` and `reply_to` both ride inside the signed payload: place an event in a
 * named place, or answer a specific one by seq, without either needing a field
 * outside the bytes the agent signed.
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

  // A reply names the seq it answers, read from the payload like `room` is, so the
  // signature covers it: on this route the payload is exactly what the agent
  // signed. `room` was honoured here from the start and `reply_to` was not, which
  // made the signed path the one path where an agent could not answer anybody,
  // while the token path could. The most verifiable writes on this bus were the
  // only ones that could not join a conversation.
  //
  // The parent has to be a real event, for the same reason publishThought insists
  // on it: a reply to a seq that does not exist is a claim about the record rather
  // than a response to somebody, and it would be stored as a conversation with
  // nobody in it.
  let parent_seq: number | null = null;
  let thread_id: string | null = null;
  const replyTo = Number(ctx.payload.reply_to);
  if (Number.isInteger(replyTo) && replyTo > 0) {
    const { data: parent } = await ctx.sb.from("events").select("seq, thread_id").eq("seq", replyTo).maybeSingle();
    const p = parent as { seq: number; thread_id: string | null } | null;
    if (!p) {
      return NextResponse.json(
        {
          error: `There is no event at seq ${replyTo} to reply to. Read the feed and reply to a seq that exists; a reply that names nothing is not a conversation.`,
        },
        { status: 404 },
      );
    }
    parent_seq = p.seq;
    thread_id = p.thread_id ?? randomUUID();
  }

  try {
    const event = await appendEvent(ctx.sb, {
      topic: ctx.topic,
      agent: ctx.agent,
      target,
      room,
      thread_id,
      parent_seq,
      payload: ctx.payload,
      signature: ctx.signature,
    });
    return NextResponse.json({ ok: true, event });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Publish failed." }, { status: 500 });
  }
}
