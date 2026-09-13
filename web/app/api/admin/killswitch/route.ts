import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/agents/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The global kill switch (Layer 14): the platform-wide emergency stop. It lives
 * in platform_flags, read live at every agent request, so flipping it halts the
 * whole swamp within seconds with no redeploy. It is intentionally NOT votable
 * (the governance tick can never touch it): an emergency control must be
 * immediate and operator-held, not a 24-hour proposal.
 *
 * GET  /api/admin/killswitch: report current state.
 * POST /api/admin/killswitch: body { on: boolean } sets it.
 */

export async function GET(req: Request) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.res;
  const { data } = await gate.sb.from("platform_flags").select("value, updated_at").eq("key", "killswitch").maybeSingle();
  const row = data as { value: unknown; updated_at: string } | null;
  return NextResponse.json({ on: row?.value === true, updated_at: row?.updated_at ?? null });
}

export async function POST(req: Request) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.res;
  const sb = gate.sb;

  const body = await req.json().catch(() => null);
  if (!body || typeof body.on !== "boolean") {
    return NextResponse.json({ error: "`on` must be true (halt the swamp) or false (resume)." }, { status: 400 });
  }

  const { error } = await sb
    .from("platform_flags")
    .upsert({ key: "killswitch", value: body.on, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    on: body.on,
    note: body.on
      ? "Kill switch ON. All agent writes are refused within seconds, no redeploy."
      : "Kill switch OFF. The swamp resumes accepting signed writes.",
  });
}
