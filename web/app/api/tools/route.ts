import { NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { supabaseAdmin, type ToolRow } from "@/lib/supabase";
import { chainMeta } from "@/lib/chains";
import { toolRegistryAbi, type ToolView, type VersionView } from "@/lib/toolRegistry.abi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tools: search the marketplace mirror.
 * Query: q (text), platform, category, chainId. Returns { configured, tools }.
 * `configured:false` means Supabase isn't wired for this deploy yet; the page
 * shows the first-party tools and the on-chain publish flow can still run, the
 * browse list is just empty until the mirror exists.
 */
export async function GET(req: Request) {
  const sb = supabaseAdmin();
  if (!sb) return NextResponse.json({ configured: false, tools: [] });

  const { searchParams } = new URL(req.url);
  const platform = searchParams.get("platform");
  const category = searchParams.get("category");
  const chainId = searchParams.get("chainId");
  const q = searchParams.get("q")?.trim();

  let query = sb
    .from("tools")
    .select("*")
    .order("downloads", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200);

  if (platform && platform !== "0") query = query.eq("platform", Number(platform));
  if (category && category !== "0") query = query.eq("category", Number(category));
  if (chainId) query = query.eq("chain_id", Number(chainId));
  if (q) {
    // Strip PostgREST filter metacharacters before interpolating into `.or`.
    const safe = q.replace(/[,()*%:\\]/g, " ").trim();
    if (safe) query = query.or(`name.ilike.%${safe}%,description.ilike.%${safe}%`);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ configured: true, tools: [], error: error.message }, { status: 500 });
  return NextResponse.json({ configured: true, tools: data ?? [] });
}

/**
 * POST /api/tools: confirm a publish into the mirror AFTER it's on chain.
 * We re-read the tool from chain and require the on-chain checksum to match what
 * the client claims before writing the row. This is the trust hinge: the mirror
 * can only ever hold rows that exist on chain with matching bytes, so a lying
 * client can't seed a fake listing or point a real listing at other bytes.
 */
export async function POST(req: Request) {
  const sb = supabaseAdmin();
  if (!sb) return NextResponse.json({ error: "Supabase is not configured for this project." }, { status: 503 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "JSON body required" }, { status: 400 });

  const chainId = Number(body.chainId);
  const toolId = Number(body.toolId);
  if (!chainId || !Number.isFinite(toolId)) return NextResponse.json({ error: "chainId and toolId required" }, { status: 400 });

  const meta = chainMeta(chainId);
  if (!meta.toolRegistry) return NextResponse.json({ error: "registry not deployed on this chain" }, { status: 400 });

  let tool: ToolView;
  let version: VersionView;
  try {
    const client = createPublicClient({ chain: meta.chain, transport: http() });
    const base = { address: meta.toolRegistry, abi: toolRegistryAbi } as const;
    tool = (await client.readContract({ ...base, functionName: "getTool", args: [BigInt(toolId)] })) as ToolView;
    version = (await client.readContract({ ...base, functionName: "latestVersion", args: [BigInt(toolId)] })) as VersionView;
  } catch {
    return NextResponse.json({ error: "could not read this tool from chain" }, { status: 400 });
  }

  const claimed = String(body.checksum ?? "").toLowerCase();
  if (!version.checksum || version.checksum.toLowerCase() !== claimed) {
    return NextResponse.json({ error: "checksum does not match the on-chain listing" }, { status: 400 });
  }

  const row: ToolRow = {
    chain_id: chainId,
    tool_id: toolId,
    publisher: tool.publisher,
    name: (String(body.name ?? "").trim() || `tool #${toolId}`).slice(0, 200),
    description: body.description ? String(body.description).slice(0, 2000) : null,
    platform: Number(tool.platform),
    category: Number(tool.category),
    semver: version.semver || null,
    checksum: claimed,
    artifact_url: String(body.artifactUrl ?? ""),
    artifact_name: String(body.artifactName ?? "tool").slice(0, 120),
    metadata_url: version.metadataURI,
    source_url: body.sourceUrl ? String(body.sourceUrl).slice(0, 400) : null,
    tx_hash: body.txHash ? String(body.txHash) : null,
    downloads: Number(tool.downloads),
    flagged: Number(tool.status) === 1,
    flag_count: Number(tool.flagCount),
    created_at: new Date(Number(tool.createdAt) * 1000).toISOString(),
  };

  const { error } = await sb.from("tools").upsert(row, { onConflict: "chain_id,tool_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, tool: row });
}
