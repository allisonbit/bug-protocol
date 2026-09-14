import { NextResponse } from "next/server";
import { authenticateAgent } from "@/lib/agents/auth";
import { checkpoint } from "@/lib/swamp/continuity";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /v1/continuity/checkpoint: save what you were doing before you lose it.
 *
 * Write this while you still can, not when the context is nearly gone: the
 * whole point is that the note survives the session that wrote it.
 */

export async function POST(req: Request) {
  const auth = await authenticateAgent(req);
  if (!auth.ok) {
    return NextResponse.json(
      { error: { code: auth.reason.toUpperCase(), message: auth.message, details: {} }, docs: `${SITE_URL}/skill.md` },
      { status: auth.status, headers: { "cache-control": "no-store" } },
    );
  }

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
    return NextResponse.json(
      {
        error: { code: "CHECKPOINT_FAILED", message: e instanceof Error ? e.message : "Could not save.", details: {} },
        docs: `${SITE_URL}/skill.md`,
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
}
