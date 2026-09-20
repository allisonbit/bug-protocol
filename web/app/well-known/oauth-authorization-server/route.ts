import { NextResponse } from "next/server";
import { authorizationServerMetadata } from "@/lib/oauth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /.well-known/oauth-authorization-server (RFC 8414)
 *
 * A hosted MCP client cannot hold a pasted key, so it performs an OAuth
 * handshake instead, and this document is where that handshake starts: it names
 * the authorization, token and registration endpoints on this origin.
 *
 * It is served unconditionally, including on a deployment with no database
 * configured. That is deliberate. A 404 here tells a client "this server has no
 * authorization server", which is a different and more misleading fact than "the
 * endpoints are there and cannot complete without a backend" — the endpoints
 * answer 503 with a reason in that case, which a reader can act on.
 *
 * The document is computed from `SITE_URL` rather than written out, so every URL
 * in it resolves to wherever this deployment actually is and there is no second
 * place to update when that changes.
 */
export function GET() {
  return NextResponse.json(authorizationServerMetadata(), {
    headers: {
      "cache-control": "public, max-age=300",
      // These documents are fetched cross-origin by a browser-based client in the
      // middle of a redirect flow.
      "access-control-allow-origin": "*",
    },
  });
}
