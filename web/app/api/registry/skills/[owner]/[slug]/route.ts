import { NextResponse } from "next/server";
import { SUPABASE_CONFIGURED, supabaseAdmin } from "@/lib/supabase";
import { SITE_URL } from "@/lib/site";
import { REGISTRY_DISCLOSURE, fileUrl, parseRef } from "@/lib/registry/clawhub";
import { readRegistrySkill } from "@/lib/registry/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/registry/skills/{owner}/{slug}
 *
 * One mirrored skill, addressed the way a reader would say it.
 *
 * WHY THE PATH IS HIERARCHICAL RATHER THAN A QUERY PARAMETER. Slugs are not globally unique
 * in this registry, so an entry's identity is the owner-qualified pair, and a URL that
 * spells that as two path segments is the same shape as the registry's own canonical page.
 * It also means a citation can be copied out of this platform and read as what it is.
 *
 * WHAT THIS RETURNS, AND WHAT IT REFUSES TO. Both verdicts, the digest the second one is
 * bound to, the reason that document was read before the others, the canonical page, and
 * the citation if one of this deployment's own capabilities has this skill recorded against
 * it. It does not return the document's text: that lives on the audit record, where a
 * reader can hash it, and a caller who wants to judge the skill can follow the audit link.
 * A blocked entry is not served at all.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ owner: string; slug: string }> }) {
  const sb = supabaseAdmin();
  if (!sb || !SUPABASE_CONFIGURED) {
    return NextResponse.json(
      { error: { code: "BACKEND_UNCONFIGURED", message: "The swamp backend isn't configured on this deployment yet." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const { owner, slug } = await ctx.params;
  const ref = `${decodeURIComponent(owner)}/${decodeURIComponent(slug)}`.toLowerCase();
  if (!parseRef(ref)) {
    return NextResponse.json(
      {
        error: {
          code: "BAD_REF",
          message: "A skill here is addressed as /api/registry/skills/{owner}/{slug}, and this registry qualifies every slug by its publisher because slugs are not globally unique.",
        },
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const entry = await readRegistrySkill(sb, ref);
  if (!entry || entry.clawhub.blocked) {
    return NextResponse.json(
      {
        error: { code: "NOT_MIRRORED", message: `Nothing is mirrored for ${ref}. Either the crawl has not reached it yet or the registry has it blocked, and a blocked skill is deliberately never served from here.` },
        search: `${SITE_URL}/api/registry/skills?q=${encodeURIComponent(slug)}`,
      },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      skill: entry,
      // What the auditor would fetch if this skill were read again, stated so a reader can
      // see the exact address the verdict came from rather than taking the digest on faith.
      read_from: fileUrl(ref),
      source: { canonical: entry.canonical_url, disclosure: REGISTRY_DISCLOSURE },
    },
    { headers: { "cache-control": "public, max-age=120, stale-while-revalidate=600", "access-control-allow-origin": "*" } },
  );
}
