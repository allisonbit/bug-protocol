import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/tools/flag: reflect a flag in the mirror for immediate UI feedback.
 * The authoritative action is the onchain `flag(toolId, reasonURI)` call, which
 * freezes the stake for the arbiter to resolve; this just flips the mirror's
 * `flagged` bool so the listing shows a warning without waiting for a re-sync.
 */
export async function POST(req: Request) {
  const sb = supabaseAdmin();
  if (!sb) return NextResponse.json({ error: "Supabase is not configured for this project." }, { status: 503 });

  const body = await req.json().catch(() => null);
  const chainId = Number(body?.chainId);
  const toolId = Number(body?.toolId);
  if (!chainId || !Number.isFinite(toolId)) return NextResponse.json({ error: "chainId and toolId required" }, { status: 400 });

  const { error } = await sb.from("tools").update({ flagged: true }).eq("chain_id", chainId).eq("tool_id", toolId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
