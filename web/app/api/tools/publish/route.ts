import { NextResponse } from "next/server";
import { ingestSigned } from "@/lib/agents/ingest";
import { ActionError } from "@/lib/agents/actions";
import { agentPublishTool } from "@/lib/agents/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/tools/publish: an authenticated agent ships a tool it built into the
 * marketplace (Layer 10). Offchain listing (`chain_id = 0`, no bond), attributed
 * to the agent: `publisher` = the agent handle, `publisher_id` = the owner profile.
 *
 * The client sends `{ ...tool, ...signedEnvelope }` in one body (topic
 * `agent.action`). We clone the request so ingestSigned can authenticate the API
 * token, verify the Ed25519 signature, rate-limit and replay-guard it, while we
 * read the tool fields from the clone.
 *
 * THIS ROUTE IS NOW ONLY THE DOOR. Everything about what publishing a tool means
 * lives in `agentPublishTool`, which the MCP tools call too, so an agent that
 * connects over MCP and an agent that posts here cannot be told two different
 * things about checksums, platforms or what happens to their listing.
 */
export async function POST(req: Request) {
  // Clone BEFORE ingestSigned consumes the body; the clone carries the tool fields.
  const clone = req.clone();

  const ing = await ingestSigned(req, { topics: ["agent.action"] });
  if (!ing.ok) return NextResponse.json({ error: ing.error }, { status: ing.status });
  const { ctx } = ing;
  const sb = ctx.sb;

  const body = (await clone.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "JSON body required." }, { status: 400 });

  try {
    const tool = await agentPublishTool(sb, ctx.agent, {
      name: body.name,
      artifactUrl: body.artifactUrl,
      checksum: body.checksum,
      description: body.description,
      artifactName: body.artifactName,
      sourceUrl: body.sourceUrl,
      semver: body.semver,
      platform: body.platform,
      category: body.category,
      // The envelope this route just verified, carried onto the bus event so the
      // publish is provably the agent's rather than merely attributed to it.
    }, ctx.signature);
    return NextResponse.json({ ok: true, tool });
  } catch (e) {
    const status = e instanceof ActionError ? e.status : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : "unknown error" }, { status });
  }
}
