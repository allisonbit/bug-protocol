import { NextResponse } from "next/server";
import { SUPABASE_CONFIGURED, supabaseAdmin } from "@/lib/supabase";
import { SITE_URL } from "@/lib/site";
import { REGISTRY_DISCLOSURE, REGISTRY_SITE } from "@/lib/registry/clawhub";
import { readCoverage, searchRegistry } from "@/lib/registry/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/registry/skills
 *
 * Search the mirrored public ClawHub registry with this deployment's own verdicts attached.
 *
 * WHY THIS EXISTS RATHER THAN POINTING AT CLAWHUB. ClawHub answers what exists. It does not
 * answer "which of these has anybody independent read, and what did they find", which is the
 * question an agent about to install something should be asking and the one this deployment
 * is in a position to answer, because it ran a different engine over the same bytes and
 * wrote the verdict down against their SHA-256.
 *
 * THE TERMS THIS HONOURS. ClawHub's API documentation permits third party directories and
 * sets four conditions: cache results, honour 429 and Retry-After, link every entry back to
 * its canonical page, and do not imply endorsement. The mirror is the cache and it is
 * refreshed by a bounded crawl rather than by a request per read; the canonical URL is on
 * every entry and is built by one function so it cannot go missing; and the disclosure
 * sentence travels with every reply. Moderation-blocked skills are excluded here and marked
 * on the row, which is the fourth.
 *
 *   ?q=          match on the publisher's name for it, the slug, the owner or the summary
 *   ?topic=      an exact topic spelling, as the rollup publishes it
 *   ?verdict=    this deployment's verdict: clean, notes, caution, risky, unsafe
 *   ?agreement=  agree, swamp_stricter, swamp_looser, unreadable
 *   ?min_installs=  floor on the install count
 *   ?sort=       installs (default), updated, name
 *   ?limit=      1..200, default 40
 *   ?offset=     for paging
 */
export async function GET(req: Request) {
  const sb = supabaseAdmin();
  if (!sb || !SUPABASE_CONFIGURED) {
    return NextResponse.json(
      { error: { code: "BACKEND_UNCONFIGURED", message: "The swamp backend isn't configured on this deployment yet." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const p = new URL(req.url).searchParams;
  const [search, coverage] = await Promise.all([
    searchRegistry(sb, {
      q: p.get("q"),
      topic: p.get("topic"),
      verdict: p.get("verdict"),
      agreement: p.get("agreement"),
      minInstalls: Number(p.get("min_installs") ?? 0) || 0,
      sort: p.get("sort") ?? undefined,
      limit: Number(p.get("limit") ?? 40) || 40,
      offset: Number(p.get("offset") ?? 0) || 0,
    }),
    readCoverage(sb),
  ]);

  return NextResponse.json(
    {
      site: SITE_URL,
      source: { registry: REGISTRY_SITE, api: `${REGISTRY_SITE}/api/v1` },
      query: { q: search.q, topic: search.topic, sort: search.sort },
      matched: search.matched,
      count: search.entries.length,
      coverage: { mirrored: coverage.mirrored, audited: coverage.audited, topics: coverage.topics },
      skills: search.entries,
      note: search.note,
      disclosure: REGISTRY_DISCLOSURE,
      docs: `${SITE_URL}/skills/registry`,
    },
    // Cached, because the registry's own terms ask for it and because a directory that
    // re-reads its mirror on every hit is a directory that will be throttled.
    { headers: { "cache-control": "public, max-age=60, stale-while-revalidate=300", "access-control-allow-origin": "*" } },
  );
}
