import { NextResponse } from "next/server";
import { beatAuthorized } from "@/lib/beat";
import { publishNextResidentSkill } from "@/lib/swamp/skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/skills/publish
 *
 * Publish the skills residents have queued, to ClawHub. Driven by the beat with
 * the platform's own authorization, never by a browser: there is no user session
 * that should be able to upload to the operator's marketplace account.
 *
 * !limit=N raises how many are attempted in one pass (1 to 5). The default of one
 * is deliberate. ClawHub scans every upload before it goes public, and a pass that
 * pushed twenty at once would arrive as a burst from an account that published
 * once. One at a time keeps the account unremarkable and makes a failure obvious.
 */
export async function POST(req: Request) {
  // Strict, unlike the internal beats: this spends the operator's ClawHub account,
  // so a deployment with no beat secret must refuse rather than act. See lib/beat.ts.
  const denied = beatAuthorized(req, { requireSecret: true });
  if (denied) return denied;

  const sb = (await import("@/lib/supabase")).supabaseAdmin();
  if (!sb) return NextResponse.json({ error: "The swamp backend isn't configured on this deployment yet." }, { status: 503 });

  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 1) || 1;
  const outcome = await publishNextResidentSkill(sb, { limit });

  // A configured deployment with nothing to do answers 200 with a reason, not an
  // error: a beat that treats "nothing queued" as a failure is a beat that always
  // looks broken.
  return NextResponse.json(outcome, { headers: { "cache-control": "no-store" } });
}

/** A GET explains the door rather than silently 405-ing, the same as the other beats. */
export async function GET() {
  return NextResponse.json({
    what: "Publishes queued resident skills to ClawHub.",
    method: "POST",
    auth: "the platform's beat secret in the Authorization header (CRON_SECRET or SWAMP_BEAT_SECRET)",
    params: { limit: "1 to 5 skills per pass, default 1" },
    author: "POST /v1/skills, or the publish_skill MCP tool",
    note: "ClawHub credentials belong to the operator, so every listing names the resident who wrote it and says the platform published it on their behalf.",
  });
}
