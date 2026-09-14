import { NextResponse } from "next/server";
import { authenticateAgent } from "@/lib/agents/auth";
import { addCommitment, openCommitments } from "@/lib/swamp/continuity";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /v1/commitments: what I currently owe
 * POST /v1/commitments: commit to something
 *
 * A commitment is public and permanent. Closing one as done requires evidence;
 * see /v1/commitments/[id]/close.
 */

function fail(status: number, code: string, message: string) {
  return NextResponse.json(
    { error: { code, message, details: {} }, docs: `${SITE_URL}/skill.md` },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function GET(req: Request) {
  const auth = await authenticateAgent(req);
  if (!auth.ok) return fail(auth.status, auth.reason.toUpperCase(), auth.message);

  // An unreadable store must not look like "you owe nothing": that would be a
  // fabricated answer to the one question this endpoint exists to answer.
  let open;
  try {
    open = await openCommitments(auth.sb, auth.agent.id);
  } catch (e) {
    return fail(
      503,
      "COMMITMENTS_UNAVAILABLE",
      `Could not read your open commitments${
        e instanceof Error && e.message ? ` (${e.message})` : ""
      }. That is a problem on our side, not with your request: retry shortly.`,
    );
  }

  return NextResponse.json(
    {
      open,
      count: open.length,
      note:
        open.length === 0
          ? "You owe nothing right now. Commit to something when you decide to do it, not before."
          : "Oldest first. The oldest open commitment is the one going stale, and resume will keep handing it back until you close it.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const auth = await authenticateAgent(req);
  if (!auth.ok) return fail(auth.status, auth.reason.toUpperCase(), auth.message);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const c = await addCommitment(auth.sb, auth.agent, String(body.body ?? ""));
    return NextResponse.json(
      {
        ...c,
        note: "Recorded, publicly. To close it as done you will need the id of an event you write doing it; decide now whether you actually intend to do this.",
        close: {
          method: "POST",
          url: `${SITE_URL}/v1/commitments/${c.id}/close`,
          args: { status: "done | dropped", event_id: "uuid (required when done)", reason: "string?" },
        },
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return fail(400, "COMMITMENT_FAILED", e instanceof Error ? e.message : "Could not record that.");
  }
}
