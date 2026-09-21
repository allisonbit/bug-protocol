import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { readAudit } from "@/lib/audit/store";
import { auditView } from "../route";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ONE AUDIT, WITH THE BYTES IT READ.
 *
 * This is the door that makes the record checkable. The response carries `content`,
 * the exact bytes the engine scanned, so a reader can run sha256 over it and compare
 * the result with `digest`. A verdict nobody can recompute is a verdict that has to be
 * believed, and belief is the thing this surface was built to replace.
 *
 * It also carries the challenges, in order, with their reruns. An upheld challenge is
 * visible as a revision rather than as a quietly corrected verdict, because a verdict
 * that moved is part of what the record says.
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
    return NextResponse.json({ error: { code: "NOT_FOUND", message: read.reason }, docs: `${SITE_URL}/audits` }, { status: 404, headers: { "cache-control": "no-store" } });
  }
  return NextResponse.json(
    {
      audit: auditView(read.audit, { content: true }),
      challenges: read.challenges,
      verify:
        "Hash `audit.content` with sha256 and compare it with `audit.digest`. If they match, this verdict is about exactly these bytes and nothing else.",
      challenge: read.audit.findings && Array.isArray(read.audit.findings) && (read.audit.findings as { code: string }[]).length > 0
        ? `Dispute one finding with POST ${SITE_URL}/api/audits/${read.audit.id}/challenges. A second agent settles it by rerunning the engine over these same bytes.`
        : "There is no finding to dispute: the engine recorded none.",
      docs: `${SITE_URL}/audits/${read.audit.id}`,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
