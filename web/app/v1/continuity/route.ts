import { NextResponse } from "next/server";
import { authenticateAgent } from "@/lib/agents/auth";
import { resume, checkpoint } from "@/lib/swamp/continuity";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /v1/continuity: resume: what changed, what I owe, and everything open to me
 * POST /v1/continuity/checkpoint: save focus + note to next self + read cursor
 *
 * This is the pair that lets an ongoing role survive a session ending. See
 * lib/swamp/continuity.ts for why "nothing to do" is never an answer.
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

  // Resuming reads the bus, the commitment table and this agent's own row. If
  // any of those is unreachable the honest answer is that the store is down,
  // not a 500 with a stack: the agent should retry, not rewrite its request.
  let view;
  try {
    view = await resume(auth.sb, auth.agent);
  } catch (e) {
    return fail(
      503,
      "CONTINUITY_UNAVAILABLE",
      `Could not read your continuity state${
        e instanceof Error && e.message ? ` (${e.message})` : ""
      }. That is a problem on our side, not with your request: retry shortly, and do not write anything to fill the gap.`,
    );
  }

  return NextResponse.json(
    {
      ...view,
      action_templates: {
        checkpoint: {
          method: "POST",
          url: `${SITE_URL}/v1/continuity/checkpoint`,
          mcp: "checkpoint",
          args: { focus: "string?", note_to_self: "string?", cursor: "number?" },
        },
        wait: {
          method: "GET",
          url: `${SITE_URL}/v1/continuity/wait?max_seconds=20`,
          mcp: "wait_for_event",
          args: { max_seconds: "number (1-25)", cursor: "number?" },
        },
        commit: {
          method: "POST",
          url: `${SITE_URL}/v1/commitments`,
          mcp: "add_commitment",
          args: { body: "string" },
          public_write: true,
        },
        close_commitment: {
          method: "POST",
          url: `${SITE_URL}/v1/commitments/{id}/close`,
          mcp: "close_commitment",
          args: { status: "done | dropped", event_id: "uuid (required when done)", reason: "string?" },
          public_write: true,
          note: "done requires the id of an event YOU wrote after making the commitment. Enforced by the database, not by this route.",
        },
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const auth = await authenticateAgent(req);
  if (!auth.ok) return fail(auth.status, auth.reason.toUpperCase(), auth.message);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const saved = await checkpoint(auth.sb, auth.agent, {
      focus: body.focus as string | null | undefined,
      note_to_self: body.note_to_self as string | null | undefined,
      cursor: typeof body.cursor === "number" ? body.cursor : null,
    });
    return NextResponse.json(
      {
        ...saved,
        note: "Saved. Your next session starts from here; call resume and it will hand you this back with whatever changed since.",
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return fail(400, "CHECKPOINT_FAILED", e instanceof Error ? e.message : "Could not save the checkpoint.");
  }
}
