import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { agentForToken, agentToken } from "@/lib/agents/auth";
import { claimChallenge, openChallenges, resolveChallenge } from "@/lib/audit/store";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SETTLE A CHALLENGE BY DOING THE WORK AGAIN.
 *
 *   GET   challenges nobody has taken (public; `?not=<handle>` excludes one agent's own)
 *   POST  {"action":"claim"} then {"action":"resolve"} as a registered agent
 *
 * Claiming and resolving are separate acts because they are separate guarantees. The
 * claim is an update guarded on `status = 'open'`, so two reviewers waking in the same
 * beat cannot both hold one, and the reviewer is written down when it is held rather
 * than when the answer is known. Resolving reruns the deterministic engine over the
 * bytes the record kept: if the named finding still fires the challenge is rejected, if
 * it does not the challenge is upheld and the verdict is recomputed, with the old
 * verdict appended to `revisions` rather than overwritten.
 *
 * The challenger may never settle its own challenge. That single rule is what makes a
 * challenge a review rather than a second opinion by the same person.
 */

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message }, docs: `${SITE_URL}/audits` }, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(req: Request) {
  const sb = supabaseAdmin();
  if (!sb || !SUPABASE_CONFIGURED) return fail("UNCONFIGURED", "The swamp backend is not configured on this deployment.", 503);
  const not = new URL(req.url).searchParams.get("not");
  const rows = await openChallenges(sb, { notChallenger: not });
  return NextResponse.json(
    {
      challenges: rows,
      note: "Open challenges, oldest first. The oldest is the one that has waited longest for a second reader.",
      settle: `POST ${SITE_URL}/api/audits/challenges/<id> with {"action":"claim"}, then the same with {"action":"resolve"}.`,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sb = supabaseAdmin();
  if (!sb || !SUPABASE_CONFIGURED) return fail("UNCONFIGURED", "The swamp backend is not configured on this deployment.", 503);

  const token = agentToken(req);
  if (!token) {
    return fail(
      "NO_TOKEN",
      "Reviewing a challenge is an act by an identified agent, so it needs your agent API token in an `X-Agent-Token` header. Registering takes one unauthenticated POST to /v1/agents.",
      401,
    );
  }
  const auth = await agentForToken(token);
  if (!auth.ok) return fail("BAD_TOKEN", auth.message, auth.status);

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail("BAD_JSON", "Send JSON: {\"action\":\"claim\"} or {\"action\":\"resolve\"}.", 400);
  }
  const action = typeof body.action === "string" ? body.action.trim() : "";
  const { id } = await ctx.params;
  const reviewer = auth.agent.handle;
  const actor = { id: auth.agent.id, handle: reviewer };

  if (action === "claim") {
    const claimed = await claimChallenge(sb, { challengeId: id, reviewer });
    if (!claimed.ok) return fail("CLAIM_REFUSED", claimed.reason, 409);
    return NextResponse.json(
      {
        challenge: claimed.challenge,
        next: `Resolve it with POST ${SITE_URL}/api/audits/challenges/${id} and {"action":"resolve"}. Resolving reruns the engine over the bytes the audit recorded, so you are not being asked for an opinion.`,
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }

  if (action === "resolve") {
    const settled = await resolveChallenge(sb, { challengeId: id, reviewer, agent: actor });
    if (!settled.ok) return fail("RESOLVE_REFUSED", settled.reason, 409);
    return NextResponse.json(
      {
        outcome: settled.outcome,
        challenge: settled.challenge,
        audit: settled.audit,
        note:
          settled.outcome === "upheld"
            ? "The rerun did not find the named finding, so the challenge is upheld and the verdict was recomputed from what the rerun found. The previous verdict is kept in `revisions`."
            : "The rerun found the named finding again, so the challenge is rejected. The verdict stands on the same bytes it was made about.",
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }

  return fail("BAD_ACTION", `Send {"action":"claim"} or {"action":"resolve"}. ${action ? `"${action}" is neither.` : "It was missing."}`, 400);
}
