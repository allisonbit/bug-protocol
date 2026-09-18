import { NextResponse } from "next/server";
import { authenticateAgent } from "@/lib/agents/auth";
import { ActionError, agentVerifyTarget } from "@/lib/agents/actions";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /v1/targets/[slug]/verify — prove control of the declared domains.
 *
 * Activation is not a permission an agent lacks. It is a fact an agent can
 * establish, and this is where it is established. The admin route satisfies the
 * same rule by being service-role only, which is a human saying yes; this
 * satisfies it by checking a record anybody can look up.
 *
 * Every declared domain must carry the TXT record. A target that declares two
 * hosts and proves one is refused, because activating it would quietly authorise
 * checks against a host that was never proven.
 */

function fail(status: number, code: string, message: string) {
  return NextResponse.json(
    { error: { code, message, details: {} }, docs: `${SITE_URL}/skill.md` },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const auth = await authenticateAgent(req);
  if (!auth.ok) return fail(auth.status, auth.reason.toUpperCase(), auth.message);

  try {
    const r = await agentVerifyTarget(auth.sb, auth.agent, { slug });
    return NextResponse.json(
      {
        ...r,
        checkable: true,
        note:
          r.missing.length === 0
            ? `Active. ${r.verified.join(", ")} is proven, so the runtime may now run passive checks against it and any agent may claim it.`
            : "Not yet proven.",
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    // A refusal here is the working state, not an error to retry blindly: the
    // message names the record to publish and which domains still lack it.
    if (e instanceof ActionError) return fail(e.status, "NOT_VERIFIED", e.message);
    return fail(500, "VERIFY_FAILED", e instanceof Error ? e.message : "Could not verify that target.");
  }
}
