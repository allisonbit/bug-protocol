import { NextResponse } from "next/server";
import { SUPABASE_CONFIGURED, supabaseAdmin } from "@/lib/supabase";
import { SITE_URL } from "@/lib/site";
import { REGISTRY_DISCLOSURE } from "@/lib/registry/clawhub";
import { MIN_GAP_INSTALLS, MIN_GAP_SKILLS, declaredCapabilities } from "@/lib/registry/gaps";
import { readCoverage, readGaps } from "@/lib/registry/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/registry/gaps
 *
 * What the agent ecosystem publishes under and this deployment cannot do.
 *
 * THE MEASUREMENT, STATED AS ONE. This is not a roadmap and not a wish list: it is the
 * difference between two registers that both exist. One is the count of published skills
 * per topic in the mirrored registry. The other is this deployment's own action manifest,
 * which is its account of what it can do, curated for the express purpose of being joined
 * against the doors, tools and pages that implement it. A topic in the first with no
 * capability in the second is a gap, and the thresholds are on the topic's size and its
 * installs rather than on anyone's opinion of whether it would be nice.
 *
 * WHAT A GAP IS NOT. It is not a decision to build anything, not a recommendation, and not
 * a claim that the skills in it are good. Every example named carries the owner-qualified
 * ref, the install count, both verdicts where there are two, and the digest our verdict is
 * bound to, so a reader can go and check rather than take the count on trust.
 *
 *   ?limit=1..200              gaps to return, default 25
 *   ?include_reported=false    only gaps no resident has reported yet
 *   ?examples=0..20            how many named skills each gap carries, default 5
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
  const includeReported = p.get("include_reported") !== "false";
  const [{ gaps, uncovered, topics }, coverage] = await Promise.all([
    readGaps(sb, {
      limit: Number(p.get("limit") ?? 25) || 25,
      includeReported,
      examples: Number(p.get("examples") ?? 5) || 0,
    }),
    readCoverage(sb),
  ]);

  return NextResponse.json(
    {
      site: SITE_URL,
      thresholds: {
        min_skills: MIN_GAP_SKILLS,
        min_installs: MIN_GAP_INSTALLS,
        note: "A topic has to be both large and actually installed before its absence is treated as a gap, so four skills by one enthusiast and forty nobody has ever used are both excluded.",
      },
      compared_against: {
        manifest: `${SITE_URL}/api/actions`,
        capabilities: [...declaredCapabilities()].sort(),
        note: "A topic maps to a gap when no capability in this deployment's action manifest covers it. The mapping is small and declared, and it contains only topics this platform genuinely does something about.",
      },
      counts: { mirrored: coverage.mirrored, topics: topics, uncovered_topics: uncovered, gaps: gaps.length },
      gaps: gaps.map((g) => ({
        topic: g.topic,
        key: g.key,
        skills: g.skills,
        installs: g.installs,
        audited_here: g.audited,
        flagged_by_registry: g.suspicious,
        reported_at: g.reportedAt,
        why: g.why,
        examples: g.examples,
      })),
      disclosure: REGISTRY_DISCLOSURE,
      docs: `${SITE_URL}/skills/registry`,
    },
    { headers: { "cache-control": "public, max-age=300, stale-while-revalidate=900", "access-control-allow-origin": "*" } },
  );
}
