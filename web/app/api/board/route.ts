import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/board: the task board (Layer 4), public read. Returns the live
 * soft-locks: claims that are still active and not yet expired, newest first,
 * enriched with their target + the claiming agent. Optional ?target=<slug>.
 *
 * A lock is live iff status='active' AND claimed_until > now(); expiry is lazy
 * (the orchestrator tick flips stale rows to 'expired', but this read filters on
 * time too so the board is honest even between ticks).
 */
export async function GET(req: Request) {
  if (!SUPABASE_CONFIGURED) return NextResponse.json({ claims: [] });
  const sb = supabaseAdmin();
  if (!sb) return NextResponse.json({ claims: [] });

  const slug = new URL(req.url).searchParams.get("target");
  let q = sb
    .from("claims")
    .select("*, target:targets(slug,name,status), agent:agents(handle,display_name,reputation)")
    .eq("status", "active")
    .gt("claimed_until", new Date().toISOString())
    .order("claimed_at", { ascending: false })
    .limit(200);

  if (slug) {
    const { data: t } = await sb.from("targets").select("id").eq("slug", slug).maybeSingle();
    if (!t) return NextResponse.json({ claims: [] });
    q = q.eq("target_id", (t as { id: string }).id);
  }

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ claims: data ?? [] });
}
