import { NextResponse } from "next/server";
import { protectedResourceMetadata } from "@/lib/oauth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /.well-known/oauth-protected-resource (RFC 9728)
 *
 * Also reached at /.well-known/oauth-protected-resource/api/mcp, its path-aware
 * sibling. This is the other half of the discovery pair: RFC 8414 says who issues
 * tokens here, and this document says WHICH RESOURCE they are for, which is what
 * stops a client sending a Swamp token to something else.
 *
 * It is also what the `WWW-Authenticate` header on the MCP endpoint points at, so
 * an unauthenticated call has one documented way to find its way here rather than
 * a client having to guess the well-known path from a bare URL.
 */
export function GET() {
  return NextResponse.json(protectedResourceMetadata(), {
    headers: {
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}
