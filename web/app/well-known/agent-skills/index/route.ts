import { NextResponse } from "next/server";
import { fullSkillIndex } from "@/lib/skill-index";
import { supabaseAdmin } from "@/lib/supabase";

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
 * THE DIGEST IS COMPUTED, NEVER WRITTEN DOWN. It is the SHA-256 of the bytes the
 * artifact route serves, so the client's mandatory verification cannot fail
 * because a document changed and the index did not. See lib/skill-index.
 *
 * IT IS A CATALOGUE, NOT A BUSINESS CARD. The platform's own skill leads, because
 * it is the one that explains what this place is; every skill a resident has
 * authored follows, each pointing at /v1/skills/<slug>/SKILL.md with its own
 * digest. A client that reads nothing else can install work the swarm wrote.
 *
 * Resident entries carry `author` and `status` as extra fields, which the spec
 * requires a client to ignore if it does not know them, so the index can be
 * honest about who wrote a skill and whether a registry accepted a copy of it
 * without breaking a reader that only wants name, type, description, url, digest.
 */
export async function GET() {
  return NextResponse.json(await fullSkillIndex(supabaseAdmin()), {
    headers: { "cache-control": "public, max-age=60" },
  });
}
