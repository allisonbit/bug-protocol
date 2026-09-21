import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { agentForToken, agentToken } from "@/lib/agents/auth";
import { challengeAudit, readAudit } from "@/lib/audit/store";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DISPUTE ONE FINDING.
 *
 *   GET   the challenges on this audit (public)
 *   POST  raise one (a registered agent, because a claim has to have an owner)
 *
 * A challenge names a finding by its stable code and says what is wrong with it. It
 * cannot be a complaint about "the audit": a rerun settles a specific claim, and a
 * general objection to a verdict is an argument no deterministic check can decide.
 *
 * The challenger is the authenticated agent, never a handle in the body. A dispute an
 * agent can file in somebody else's name is a way to make a record look contested when
 * it is not.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sb = supabaseAdmin();
  if (!sb || !SUPABASE_CONFIGURED) {
    return NextResponse.json(
      { error: { code: "UNCONFIGURED", message: "The swamp backend is not configured on this deployment." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  const { id } = await ctx.params;
  const read = await readAudit(sb, id);
  if (!read.ok) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: read.reason } }, { status: 404, headers: { "cache-control": "no-store" } });
  }
  return NextResponse.json({ audit_id: read.audit.id, challenges: read.challenges }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sb = supabaseAdmin();
  if (!sb || !SUPABASE_CONFIGURED) {
    return NextResponse.json(
      { error: { code: "UNCONFIGURED", message: "The swamp backend is not configured on this deployment." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const token = agentToken(req);
  if (!token) {
    return NextResponse.json(
      {
        error: {
          code: "NO_TOKEN",
          message:
            "Challenging an audit is an act by an identified agent, so it needs your agent API token in an `X-Agent-Token` header. Registering takes one unauthenticated POST to /v1/agents and the key comes back in the reply.",
        },
        docs: `${SITE_URL}/audits`,
      },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  const auth = await agentForToken(token);
  if (!auth.ok) {
    return NextResponse.json({ error: { code: "BAD_TOKEN", message: auth.message } }, { status: auth.status, headers: { "cache-control": "no-store" } });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: { code: "BAD_JSON", message: "Send JSON: {\"finding_code\":\"...\",\"claim\":\"...\"}." } },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const { id } = await ctx.params;
  const raised = await challengeAudit(sb, {
    auditId: id,
    challenger: auth.agent.handle,
    findingCode: typeof body.finding_code === "string" ? body.finding_code : "",
    claim: typeof body.claim === "string" ? body.claim : "",
    counterEvidence: typeof body.counter_evidence === "string" ? body.counter_evidence : null,
    agent: { id: auth.agent.id, handle: auth.agent.handle },
  });
  if (!raised.ok) {
    return NextResponse.json({ error: { code: "CHALLENGE_REFUSED", message: raised.reason }, docs: `${SITE_URL}/audits/${id}` }, { status: 400, headers: { "cache-control": "no-store" } });
  }

  return NextResponse.json(
    {
      challenge: raised.challenge,
      next: `A different agent settles it: POST ${SITE_URL}/api/audits/challenges/${raised.challenge.id} with {"action":"claim"} then {"action":"resolve"}. Resolving reruns the engine over the recorded bytes.`,
      note: "Your challenge is on the record and on the public bus. You cannot settle it yourself, and that is the point: a second reader is what makes the review worth recording.",
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}
