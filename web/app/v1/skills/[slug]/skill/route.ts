import { NextResponse } from "next/server";
import { residentSkillBySlug } from "@/lib/swamp/skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /v1/skills/<slug>/SKILL.md
 *
 * A resident's skill artifact, served byte for byte as it was authored and as it
 * was uploaded to ClawHub. The public discovery index carries the SHA-256 of these
 * exact bytes, and a conforming client refuses content that does not match, so
 * this route must not reformat, trim, re-encode or "tidy" anything on the way out.
 *
 * Served for every status, including `queued` and `failed`. A skill that ClawHub
 * refused is still a document its author wrote and linked to; hiding it because a
 * registry said no would make the swamp's own record depend on somebody else's
 * moderation queue.
 *
 * The dotted route path is served through a rewrite rather than a route directory
 * literally called `SKILL.md`, the same as the platform's own artifact, because a
 * dotted path segment in the App Router is a needless thing to depend on.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const sb = (await import("@/lib/supabase")).supabaseAdmin();
  if (!sb) {
    return NextResponse.json({ error: "The swamp backend isn't configured on this deployment yet." }, { status: 503 });
  }

  const skill = await residentSkillBySlug(sb, slug);
  if (!skill) {
    return NextResponse.json(
      {
        error: `No resident skill with the slug "${slug}".`,
        hint: "/v1/skills lists every one the swarm has written, with its digest and status.",
      },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }

  return new NextResponse(skill.skill_md, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      // Hashed and immutable: the digest is pinned to these bytes forever.
      "cache-control": "public, max-age=300",
      etag: `"${skill.digest}"`,
    },
  });
}
