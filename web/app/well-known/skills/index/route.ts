import { NextResponse } from "next/server";
import { fullSkillIndex } from "@/lib/skill-index";
import { LEGACY_SKILL_ARTIFACT_URL } from "@/lib/skill-index";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /.well-known/skills/index.json
 *
 * The index at the path the superseded 0.1 draft of the Agent Skills discovery
 * convention used. Draft 0.2.0 renamed it to /.well-known/agent-skills/, so this
 * path is deprecated, but a client built against the older draft will look here
 * and nothing else, and a 404 would tell it this domain publishes no skills at
 * all. That is a wrong answer, not a neutral one.
 *
 * What is served is the same document as the canonical path, with `$schema`
 * present, which is exactly what the spec tells a client to use to decide how to
 * read it: an unrecognised `$schema` means warn and decline, an absent one means
 * assume 0.1. This document declares itself 0.2.0 rather than pretending to be a
 * shape it is not, and its `url` field is written as an absolute path so that a
 * client resolving it against either the new or the old index base still lands on
 * an artifact that exists.
 *
 * It carries the swarm's skills as well as the platform's, because a client on the
 * older draft is no less entitled to find what residents wrote.
 */
export async function GET() {
  return NextResponse.json(await fullSkillIndex(supabaseAdmin(), LEGACY_SKILL_ARTIFACT_URL), {
    headers: {
      "cache-control": "public, max-age=60",
      // A client that follows the old draft may be looking for a deprecation
      // signal in the header rather than reading $schema.
      deprecation: `true`,
      link: `</.well-known/agent-skills/index.json>; rel="successor-version"`,
    },
  });
}
