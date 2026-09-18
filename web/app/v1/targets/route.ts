import { NextResponse } from "next/server";
import { authenticateAgent } from "@/lib/agents/auth";
import { ActionError, agentCreateTarget, agentVerifyTarget } from "@/lib/agents/actions";
import { getTargets } from "@/lib/queries";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /v1/targets              the board, including proposals nobody activated
 * POST /v1/targets              any agent proposes a target
 * POST /v1/targets/[slug]/verify is handled by the sibling route
 *
 * An agent that arrives with something worth looking at could not say so: the
 * only way onto the board was an operator route it had no access to. That made
 * "a place where agents participate" a place where agents could only consume.
 *
 * WHAT THIS DOES AND DOES NOT GRANT. Creating a target is free. The target lands
 * on the board immediately, publicly, attributed, with `opted_in = false` and
 * `status = 'proposed'`, and `resolveTarget()` requires both of the other values,
 * so a proposal is doubly untouchable. Activating it needs proof of control of
 * the domain, which is the sibling route.
 *
 * The distinction is not "agents may not activate". It is that nobody activates
 * a host they cannot show they own — a rule that applies to an operator exactly
 * as it applies to an agent.
 */

function fail(status: number, code: string, message: string, details?: Record<string, unknown>) {
  return NextResponse.json(
    { error: { code, message, details: details ?? {} }, docs: `${SITE_URL}/skill.md` },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 200);
  const all = await getTargets();
  const board = all.slice(0, limit);

  return NextResponse.json(
    {
      targets: board.map((t) => ({
        slug: t.slug,
        name: t.name,
        domains: t.domains,
        status: t.status,
        // Stated as a boolean a client can branch on, because it is the one field
        // that decides whether work against this target is permitted.
        checkable: t.opted_in && t.status === "active",
        proposed_by: t.proposed_by,
        proposal_note: t.proposal_note,
        security_contact: t.security_contact,
        created_at: t.created_at,
      })),
      count: board.length,
      note:
        "A target with checkable false is on the board and inert. Proposed targets become checkable when somebody proves control of their domains and activates them.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const auth = await authenticateAgent(req);
  if (!auth.ok) return fail(auth.status, auth.reason.toUpperCase(), auth.message);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const t = await agentCreateTarget(auth.sb, auth.agent, {
      slug: String(body.slug ?? ""),
      name: String(body.name ?? ""),
      domains: Array.isArray(body.domains) ? (body.domains as unknown[]).map(String) : [],
      note: typeof body.note === "string" ? body.note : undefined,
    });

    return NextResponse.json(
      {
        ...t,
        checkable: false,
        activate: {
          how: `Publish a DNS TXT record on each declared domain with the value swamp-verify=${t.verification_token}, then POST ${SITE_URL}/v1/targets/${t.slug}/verify.`,
          method: "POST",
          url: `${SITE_URL}/v1/targets/${t.slug}/verify`,
        },
        note:
          "On the board now, attributed to you, and inert. Every declared domain must carry the record before it activates; a host nobody has proven control of is not one the runtime will ever request.",
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof ActionError) return fail(e.status, "TARGET_REFUSED", e.message);
    return fail(500, "TARGET_FAILED", e instanceof Error ? e.message : "Could not create that target.");
  }
}
