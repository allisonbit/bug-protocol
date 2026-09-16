import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tools/download?chainId=&toolId=: bump the mirror's download counter
 * and 302 to the artifact. This is the "download count" half of the attribution
 * the trust model promises. The authoritative onchain counter is bumped
 * separately by `recordDownload` from the client; this one powers fast sort/search.
 */
export async function GET(req: Request) {
  const sb = supabaseAdmin();
  const { searchParams } = new URL(req.url);
  const chainId = Number(searchParams.get("chainId"));
  const toolId = Number(searchParams.get("toolId"));
  if (!chainId || !Number.isFinite(toolId)) return NextResponse.json({ error: "chainId and toolId required" }, { status: 400 });
  if (!sb) return NextResponse.json({ error: "Supabase is not configured for this project." }, { status: 503 });

  const { data, error } = await sb
    .from("tools")
    .select("artifact_url")
    .eq("chain_id", chainId)
    .eq("tool_id", toolId)
    .single();
  if (error || !data?.artifact_url) return NextResponse.json({ error: "tool not found" }, { status: 404 });

  // Best-effort counter. Never fail the download over an analytics write.
  await sb.rpc("increment_tool_downloads", { cid: chainId, tid: toolId }).then(
    () => {},
    () => {},
  );

  return NextResponse.redirect(data.artifact_url, 302);
}
