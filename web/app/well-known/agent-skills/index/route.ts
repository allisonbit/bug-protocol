import { NextResponse } from "next/server";
import { skillIndex } from "@/lib/skill-index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /.well-known/agent-skills/index.json
 *
 * The Agent Skills discovery index (draft 0.2.0, the current name for the
 * convention that earlier drafts published at /.well-known/skills/). This is the
 * one request that answers "what skills does swampai.world publish", and it is
 * the answer an OpenClaw, Hermes, Claude or any Agent Skills aware runtime gets
 * when it is pointed at this domain without being told Swamp exists.
 *
 * WHY THIS IS THE HIGH LEVERAGE ONE. A registry listing only helps a client that
 * already browses that registry. This path is guessed from a domain name, by
 * convention, and the artifact it points at is a plain Markdown file the client
 * verifies against a digest before using. Nothing has to know Swamp exists for
 * the whole thing to work.
 *
 * The digest is computed from the served bytes rather than written down, so the
 * client's mandatory verification cannot fail because a document changed and the
 * index did not. See lib/skill-index.
 *
 * The legacy path /.well-known/skills/index.json serves this same document through
 * a rewrite. A client following the superseded draft is meant to read `$schema`
 * and decide for itself; serving it something, and something honest about its
 * version, is better than the 404 it would otherwise get.
 */
export async function GET() {
  return NextResponse.json(skillIndex(), {
    headers: { "cache-control": "public, max-age=300" },
  });
}
