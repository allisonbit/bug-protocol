import { NextResponse } from "next/server";
import { ingestSigned, appendEvent } from "@/lib/agents/ingest";
import { getFlags } from "@/lib/agents/auth";
import type { Finding, Target } from "@/lib/agents/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = new Set(["verify", "challenge"]);

/**
 * POST /api/findings/[id]/review: peer review (Layer 8). A signed `finding.review`
 * with payload { kind: 'verify'|'challenge', rationale }. Rules:
 *   - you cannot review your OWN finding (no self-verification);
 *   - the finding must still be open (new / under_review / challenged); terminal
 *     findings (verified/rejected/disclosing/disclosed) reject with 409;
 *   - one review of each kind per agent per finding (DB unique constraint, so a 409).
 * A `challenge` moves the finding to `challenged` and opens a debate window; a
 * `verify` on a fresh finding moves it to `under_review`. The orchestrator tick
 * resolves the outcome at the deadline. Reputation is moved by DB triggers only.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const ing = await ingestSigned(req, { topics: ["finding.review"] });
  if (!ing.ok) return NextResponse.json({ error: ing.error }, { status: ing.status });
  const { ctx } = ing;

  // The signed envelope must name the same finding as the URL, or the signature
  // wouldn't cover what we're acting on.
  if (ctx.finding && ctx.finding !== id) {
    return NextResponse.json({ error: "Signed finding id does not match the URL." }, { status: 400 });
  }

  const kind = String(ctx.payload.kind ?? "");
  if (!KINDS.has(kind)) return NextResponse.json({ error: "kind must be 'verify' or 'challenge'." }, { status: 400 });
  const rationale = typeof ctx.payload.rationale === "string" ? ctx.payload.rationale.trim().slice(0, 4000) : null;

  const { data: fData } = await ctx.sb.from("findings").select("*").eq("id", id).maybeSingle();
  const finding = fData as Finding | null;
  if (!finding) return NextResponse.json({ error: "No such finding." }, { status: 404 });

  if (finding.agent_id === ctx.agent.id) {
    return NextResponse.json({ error: "You cannot review your own finding." }, { status: 403 });
  }
  if (!["new", "under_review", "challenged"].includes(finding.status)) {
    return NextResponse.json({ error: `Finding is ${finding.status}; review is closed.` }, { status: 409 });
  }

  // Record the signed review. The unique(finding_id, agent_id, kind) constraint
  // makes a repeat of the same kind a clean 409.
  const { error: rErr } = await ctx.sb.from("reviews").insert({
    finding_id: id,
    agent_id: ctx.agent.id,
    kind,
    rationale,
    signature: ctx.signature,
  });
  if (rErr) {
    if (rErr.code === "23505") {
      return NextResponse.json({ error: `You already filed a ${kind} on this finding.` }, { status: 409 });
    }
    return NextResponse.json({ error: rErr.message }, { status: 500 });
  }

  // Advance the finding's state. A challenge opens the debate window; the first
  // verify moves a fresh finding into review. The tick does final resolution.
  const flags = await getFlags(ctx.sb);
  if (kind === "challenge" && finding.status !== "challenged") {
    const debate_deadline = new Date(Date.now() + flags.debate_window_secs * 1000).toISOString();
    await ctx.sb.from("findings").update({ status: "challenged", debate_deadline }).eq("id", id);
  } else if (kind === "verify" && finding.status === "new") {
    await ctx.sb.from("findings").update({ status: "under_review" }).eq("id", id);
  }

  // Denormalize the target slug onto the feed event so it links.
  const { data: tData } = await ctx.sb.from("targets").select("*").eq("id", finding.target_id).maybeSingle();
  const target = tData as Target | null;

  try {
    await appendEvent(ctx.sb, {
      topic: "finding.review",
      agent: ctx.agent,
      target,
      finding_id: id,
      payload: { kind, rationale, finding_title: finding.title },
      signature: ctx.signature,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Feed append failed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, kind });
}
