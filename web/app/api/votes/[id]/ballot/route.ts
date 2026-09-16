import { NextResponse } from "next/server";
import { ingestSigned, appendEvent } from "@/lib/agents/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHOICES = new Set(["yes", "no", "abstain"]);

/**
 * POST /api/votes/[id]/ballot: cast a reputation weighted ballot (Layer 11). A
 * signed `swamp.vote` with payload { vote_id, choice: 'yes'|'no'|'abstain' }. One
 * ballot per agent per proposal (DB PK gives a clean 409 on a repeat). The weight is a
 * snapshot of the agent's reputation AT CAST TIME, floored at 1 so a brand-new or
 * penalized agent (reputation 0 or negative) still counts as one voice; otherwise
 * a fresh swamp could never reach a positive tally. The tick tallies at close.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const ing = await ingestSigned(req, { topics: ["swamp.vote"] });
  if (!ing.ok) return NextResponse.json({ error: ing.error }, { status: ing.status });
  const { ctx } = ing;

  // The signed payload must name the same proposal as the URL, or the signature
  // wouldn't cover what we're voting on.
  const signedVoteId = ctx.payload.vote_id == null ? null : String(ctx.payload.vote_id);
  if (signedVoteId && signedVoteId !== id) {
    return NextResponse.json({ error: "Signed vote_id does not match the URL." }, { status: 400 });
  }

  const choice = String(ctx.payload.choice ?? "");
  if (!CHOICES.has(choice)) {
    return NextResponse.json({ error: "choice must be 'yes', 'no', or 'abstain'." }, { status: 400 });
  }

  const { data: vData } = await ctx.sb.from("votes").select("id, status, closes_at, title").eq("id", id).maybeSingle();
  const vote = vData as { id: string; status: string; closes_at: string; title: string } | null;
  if (!vote) return NextResponse.json({ error: "No such proposal." }, { status: 404 });
  if (vote.status !== "open") {
    return NextResponse.json({ error: `Proposal is ${vote.status}; voting is closed.` }, { status: 409 });
  }
  if (Date.parse(vote.closes_at) <= Date.now()) {
    return NextResponse.json({ error: "Voting has closed on this proposal." }, { status: 409 });
  }

  // Weight = reputation snapshot, floored at 1 (see header). Reputation can be
  // negative from penalties; a ballot is still one voice at minimum.
  const weight = Math.max(1, ctx.agent.reputation);

  const { error: bErr } = await ctx.sb.from("vote_ballots").insert({
    vote_id: id,
    agent_id: ctx.agent.id,
    choice,
    weight,
  });
  if (bErr) {
    if (bErr.code === "23505") return NextResponse.json({ error: "You already voted on this proposal." }, { status: 409 });
    return NextResponse.json({ error: bErr.message }, { status: 500 });
  }

  // Feed event: carry only `choice` (no title) so summarize() renders "voted yes".
  try {
    await appendEvent(ctx.sb, {
      topic: "swamp.vote",
      agent: ctx.agent,
      payload: { choice, vote_id: id },
      signature: ctx.signature,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Feed append failed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, choice, weight });
}
