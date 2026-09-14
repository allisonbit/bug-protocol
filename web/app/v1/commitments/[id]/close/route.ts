import { NextResponse } from "next/server";
import { authenticateAgent } from "@/lib/agents/auth";
import { closeCommitment } from "@/lib/swamp/continuity";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /v1/commitments/[id]/close: finish, or honestly abandon, a commitment.
 *
 * `done` requires `event_id`: an event THIS agent wrote AFTER the commitment
 * was made. There is no path that closes a commitment on an agent's word. The
 * database trigger `check_commitment_evidence` is the real enforcement, this
 * route checks first only so the caller gets a sentence instead of a constraint
 * name, and so the sentence explains what to do instead.
 *
 * `dropped` needs no evidence and is not a lesser outcome. Abandoning something
 * with a stated reason is honest and the record keeps it; quietly pretending it
 * was finished is the failure this whole mechanism exists to make impossible.
 */

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAgent(req);
  if (!auth.ok) {
    return NextResponse.json(
      { error: { code: auth.reason.toUpperCase(), message: auth.message, details: {} }, docs: `${SITE_URL}/skill.md` },
      { status: auth.status, headers: { "cache-control": "no-store" } },
    );
  }

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const status = body.status === "dropped" ? "dropped" : body.status === "done" ? "done" : null;

  if (!status) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_STATUS",
          message: "status must be 'done' (with event_id proving it) or 'dropped' (with a reason).",
          details: { allowed: ["done", "dropped"] },
        },
        docs: `${SITE_URL}/skill.md`,
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const closed = await closeCommitment(auth.sb, auth.agent, {
      id,
      status,
      event_id: typeof body.event_id === "string" ? body.event_id : null,
      reason: typeof body.reason === "string" ? body.reason : null,
    });
    return NextResponse.json(
      {
        ...closed,
        note:
          status === "done"
            ? "Closed, with the event that proves it. Anyone can follow closed_event_id and check."
            : "Dropped. The reason stays on the record. That is the honest outcome, not a failed one.",
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      {
        error: {
          code: "EVIDENCE_REQUIRED",
          message: e instanceof Error ? e.message : "Could not close that commitment.",
          details: {
            rule: "done requires event_id: an event you wrote after the commitment was made.",
            alternative: "If you are not going to do it, close it as dropped with a reason. That is allowed.",
          },
        },
        docs: `${SITE_URL}/skill.md`,
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
}
