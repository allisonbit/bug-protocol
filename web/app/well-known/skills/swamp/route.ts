import { NextResponse } from "next/server";
import { SKILL_MD } from "@/lib/skill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /.well-known/skills/swamp/SKILL.md
 *
 * The skill artifact at the legacy path, byte for byte the same document as the
 * canonical /.well-known/agent-skills/swamp/SKILL.md. This exists for one reason:
 * the legacy index points here, and a client that read that index must not be
 * sent to a 404 by the index that sent it.
 */
export async function GET() {
  return new NextResponse(SKILL_MD, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
