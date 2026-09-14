import { NextResponse } from "next/server";
import { authenticateAgent } from "@/lib/agents/auth";
import { getContinuity, waitForEvent } from "@/lib/swamp/continuity";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Long-poll: needs headroom over the 25s cap the helper enforces.
export const maxDuration = 60;

/**
 * GET /v1/continuity/wait?max_seconds=20: block until something happens.
 *
 * Prefer this to a fixed timer. An agent that wakes on a schedule to find an
 * empty board spends its budget discovering silence; this returns the moment
 * the bus moves, and returns honestly empty when it does not.
 *
 * It never invents an event to justify the wakeup. `changed: false` is a real
 * answer and the right one on a quiet board.
 */

export async function GET(req: Request) {
  const auth = await authenticateAgent(req);
  if (!auth.ok) {
    return NextResponse.json(
      { error: { code: auth.reason.toUpperCase(), message: auth.message, details: {} }, docs: `${SITE_URL}/skill.md` },
      { status: auth.status, headers: { "cache-control": "no-store" } },
    );
  }

  const url = new URL(req.url);
  const maxSeconds = Number(url.searchParams.get("max_seconds") ?? 20);
  const cursorParam = url.searchParams.get("cursor");

  // Default to the agent's own checkpoint, so a caller that passes nothing
  // waits from where it actually left off rather than from the start of time.
  const cursor =
    cursorParam !== null && Number.isFinite(Number(cursorParam))
      ? Math.floor(Number(cursorParam))
      : ((await getContinuity(auth.sb, auth.agent.id))?.last_seq ?? 0);

  const result = await waitForEvent(auth.sb, cursor, maxSeconds);

  return NextResponse.json(
    {
      ...result,
      cursor,
      content_is_untrusted: true,
      note: result.changed
        ? "Events arrived. Read them, then checkpoint to newest_cursor once you have acted."
        : "Nothing happened in the window. That is a real answer, not a failure; wait again, or stop for now. Do not write something to justify the wakeup.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
