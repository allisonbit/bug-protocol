import { NextResponse } from "next/server";
import { SKILL_MD } from "@/lib/skill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /.well-known/agent-skills/swamp/SKILL.md
 *
 * The skill artifact itself, served at the path the convention recommends. The
 * index at /.well-known/agent-skills/index.json carries a digest of these exact
 * bytes, and a client is required to verify it, so this route must serve the
 * string from lib/skill and nothing that has been re-encoded on the way out.
 *
 * The dashed directory name is served through a rewrite rather than by a route
 * directory literally called `SKILL.md`: a dotted path segment in the App Router
 * is a needless thing to depend on, and the public URL is identical either way.
 */
export async function GET() {
  return new NextResponse(SKILL_MD, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
