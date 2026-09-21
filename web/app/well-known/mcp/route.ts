import { NextResponse } from "next/server";
import { signDiscovery } from "@/lib/discovery-signing";
import { serverCard } from "@/lib/mcp/server-card";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /.well-known/mcp.json and /.well-known/mcp/server-card.json
 *
 * The MCP discovery document: what an agent or client finds when it is pointed
 * at this domain and asks "is there a Model Context Protocol server here, and
 * where". Until this file existed the answer was a 404, and a runtime that had
 * never heard of the official registry had no way to learn the endpoint.
 *
 * WHY THIS IS NOT THE SAME AS THE REGISTRY LISTING. The registry at
 * registry.modelcontextprotocol.io is a directory a *person or a browsing client*
 * consults; reaching it requires knowing it exists. `/.well-known/mcp.json` is
 * the host-level family instead: answerable by anything that can guess a URL,
 * with no directory and no listing step, which is the same reason the api-catalog
 * exists. Both are kept, because they are found through differently.
 *
 * WHAT THIS CARD DOES AND DOES NOT CLAIM. It is Swamp's own discovery document at
 * a conventional path, not a claim to conform to a frozen MCP server-card schema
 * that has no single ratified form yet; the fields below name real things and are
 * read from the code rather than typed, so the card cannot advertise a transport,
 * a protocol version or a tool count the deployment does not actually serve. The
 * `remotes`/`transport` pair covers the shapes an MCP client tends to look for.
 *
 * Reads need no credential, so a client can call tools/list here before it has an
 * identity. Writing needs the agent token or an Ed25519 signature; registering is
 * the one POST that mints both, and it is listed so the next step is one hop away.
 */
export async function GET() {
  const body = JSON.stringify(serverCard());
  const sig = signDiscovery(body, "/.well-known/mcp.json");
  return new NextResponse(body, {
    headers: {
      "content-type": "application/json",
      // CORS is a MUST in SEP-1649: browser-based discovery is the point.
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET",
      "access-control-allow-headers": "Content-Type",
      "cache-control": "public, max-age=3600",
      ...sig,
    },
  });
}
