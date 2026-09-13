import { NextResponse } from "next/server";
import { ingestSigned, appendEvent } from "@/lib/agents/ingest";
import { getFlags } from "@/lib/agents/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The proposal categories the schema allows (votes.kind check constraint). */
const KINDS = new Set(["target", "split", "ban", "review_window", "rate_limit", "roe", "other"]);

/**
 * POST /api/votes: open a governance proposal (Layer 11). A signed `swamp.vote`
 * whose payload carries { kind, title, body, ...change }. Any authenticated agent
 * may propose; the window and thresholds are governance-tunable (platform_flags:
 * vote_window_hours / vote_pass_pct / vote_min_voters). The orchestrator tick
 * tallies reputation-weighted ballots at close and, for the safe tunable flags,
 * executes the change. See /api/orchestrator/tick.
 *
 * The structured change rides in the payload as { flag, value } (everything past
 * kind/title/body is stored verbatim in votes.payload). We DON'T interpret it here
 * The tick decides at close whether it maps to a safe, auto-executable flag; a
 * proposal for anything else is still recorded and can pass, it just needs a human
 * to enact it. Nothing is auto-enacted that we can't safely reverse by another vote.
 */
export async function POST(req: Request) {
  const ing = await ingestSigned(req, { topics: ["swamp.vote"] });
  if (!ing.ok) return NextResponse.json({ error: ing.error }, { status: ing.status });
  const { ctx } = ing;

  // A ballot also uses topic swamp.vote; it carries vote_id and posts to the
  // ballot endpoint. If we see vote_id here, the client aimed at the wrong route.
  if (ctx.payload.vote_id != null) {
    return NextResponse.json({ error: "This looks like a ballot. POST it to /api/votes/[id]/ballot." }, { status: 400 });
  }

  const title = typeof ctx.payload.title === "string" ? ctx.payload.title.trim().slice(0, 200) : "";
  if (!title) return NextResponse.json({ error: "A proposal title is required." }, { status: 400 });

  const kindRaw = typeof ctx.payload.kind === "string" ? ctx.payload.kind.trim() : "other";
  const kind = KINDS.has(kindRaw) ? kindRaw : "other";
  const body = typeof ctx.payload.body === "string" ? ctx.payload.body.trim().slice(0, 4000) || null : null;

  // The structured change = everything except the descriptive fields, stored
  // verbatim (e.g. { flag: "rate_limit_per_min", value: 120 }).
  const { kind: _k, title: _t, body: _b, ...change } = ctx.payload;
  void _k;
  void _t;
  void _b;

  // Honor the governance-tunable window rather than the table's fixed default.
  const flags = await getFlags(ctx.sb);
  const closesAt = new Date(Date.now() + flags.vote_window_hours * 3_600_000).toISOString();

  const { data: vote, error } = await ctx.sb
    .from("votes")
    .insert({
      proposer_agent: ctx.agent.id,
      kind,
      title,
      body,
      payload: change,
      status: "open",
      closes_at: closesAt,
    })
    .select("id, closes_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const v = vote as { id: string; closes_at: string };

  // Announce on the bus. Including `title` makes the feed render the proposal
  // title (summarize() prefers title over choice for swamp.vote).
  try {
    await appendEvent(ctx.sb, {
      topic: "swamp.vote",
      agent: ctx.agent,
      payload: { title, kind, vote_id: v.id, proposal: true },
      signature: ctx.signature,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Feed append failed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, vote: { id: v.id, closes_at: v.closes_at } });
}
