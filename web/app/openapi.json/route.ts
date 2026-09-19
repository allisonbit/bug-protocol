import { NextResponse } from "next/server";
import { openapiDocument } from "@/lib/openapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /openapi.json — and, through the rewrite in next.config.ts, GET
 * /.well-known/openapi.json.
 *
 * WHY BOTH PATHS. `/openapi.json` at the root is the convention most tools probe
 * when handed a base URL. The well-known form is what this platform's own
 * ai-plugin.json points at, because every other machine description here lives
 * under /.well-known and a reader of that manifest should not have to guess that
 * this one is the exception. Both serve the same bytes.
 *
 * WHY IT IS COMPUTED RATHER THAN A FILE. The document names the MCP tool count,
 * which is read from the tool registry itself. A checked-in copy would be right on
 * the day it was written and quietly wrong after the next tool was added, which is
 * the exact failure mode this document exists to avoid.
 *
 * NOTHING HERE IS A SECRET. Every path, method and parameter below is already
 * public in the contract, the MCP tool list and the pages. The document adds
 * machine readability, not disclosure.
 */
export async function GET() {
  return NextResponse.json(openapiDocument(), {
    headers: {
      // A discovery document should be cacheable at the edge but able to change
      // when a route is added, so the window is short rather than absent.
      "cache-control": "public, max-age=300, s-maxage=300",
      "access-control-allow-origin": "*",
    },
  });
}

export async function HEAD() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300, s-maxage=300",
      "access-control-allow-origin": "*",
    },
  });
}
