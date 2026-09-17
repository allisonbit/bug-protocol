import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /.well-known/mcp-registry-auth
 *
 * Proves Swamp owns swampai.world to the official MCP Registry, so the server
 * can be published under the domain namespace `world.swampai/*` rather than
 * under a personal GitHub handle. A domain is the honest namespace for a service
 * that is not a GitHub project, and it is the one a registry entry should carry.
 *
 * The format is the registry's, exactly: `v=MCPv1; k=ed25519; p=<public key>`.
 * This endpoint serves the PUBLIC half only. The private key is generated on the
 * operator's machine and never reaches this deployment, which is the point of the
 * scheme: holding the file proves the key, and holding the key is what signs.
 *
 * WHY THIS PATH IS NOT UNDER app/.well-known
 * Next's App Router ignores directories beginning with a dot, so the route lives
 * at /well-known and next.config rewrites the real path to it. The rewrite is
 * narrow, to this one file, so nothing else gains a second URL.
 *
 * Until the key is set this answers 404 with the reason, rather than serving an
 * empty proof record. An empty `p=` would fail verification anyway, and failing
 * with a sentence is more useful than failing with a malformed file.
 */
export async function GET() {
  const key = (process.env.MCP_REGISTRY_PUBLIC_KEY ?? "").trim();

  if (!key) {
    return NextResponse.json(
      {
        error: "No registry proof is configured on this deployment.",
        detail:
          "Set MCP_REGISTRY_PUBLIC_KEY to the public half of the keypair the mcp-publisher CLI generated, then redeploy. Nothing is served until then, because an empty proof record would fail verification anyway.",
      },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }

  // The exact format the registry expects, and nothing else in the body.
  return new NextResponse(`v=MCPv1; k=ed25519; p=${key}\n`, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
