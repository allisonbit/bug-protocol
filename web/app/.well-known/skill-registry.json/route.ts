import { NextResponse } from "next/server";
import { SUPABASE_CONFIGURED, supabaseAdmin } from "@/lib/supabase";
import { SITE_URL } from "@/lib/site";
import { REGISTRY_API, REGISTRY_DISCLOSURE, REGISTRY_SITE } from "@/lib/registry/clawhub";
import { readCoverage } from "@/lib/registry/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /.well-known/skill-registry.json
 *
 * What this deployment has mirrored of the public ClawHub registry, and what its own
 * opinions about it amount to.
 *
 * WHY A DISCOVERY DOCUMENT AND NOT ONLY AN ENDPOINT. A client arriving at this host has no
 * reason to guess that tens of thousands of published skills are searchable here with an
 * independent verdict attached to each one. More importantly, a coverage document is the
 * only honest way to offer a mirror: the number of skills judged is a fact a reader should
 * be able to check before treating any of it as thorough. So the counts, how far the sweep
 * has reached, when it last looked, and what it refused to mirror are all in one place, and
 * every one of them is a query against rows rather than a sentence someone wrote.
 *
 * THE THREE VERDICT NUMBERS ARE THE ARGUMENT. `agree` against `swamp_stricter` and
 * `swamp_looser` is the whole value of running a second engine: republishing ClawHub's
 * verdict would be a mirror with a badge, and the rows where the two disagree are the only
 * ones where this deployment has said something ClawHub did not.
 */
export async function GET() {
  const sb = supabaseAdmin();
  if (!sb || !SUPABASE_CONFIGURED) {
    return NextResponse.json(
      { error: { code: "BACKEND_UNCONFIGURED", message: "The swamp backend isn't configured on this deployment yet." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const coverage = await readCoverage(sb);
  const audited = coverage.audited;
  const rate = (n: number) => (audited > 0 ? Math.round((n / audited) * 1000) / 10 : null);

  return NextResponse.json(
    {
      site: SITE_URL,
      what: "A cached, searchable mirror of the public ClawHub skill registry, with this deployment's own independent audit of each skill it has read.",
      source: {
        registry: REGISTRY_SITE,
        api: `${REGISTRY_API}/api/v1`,
        terms: "ClawHub's API documentation permits third party directories provided results are cached, 429 and Retry-After are honoured, every entry links back to its canonical page, and no endorsement is implied. This document and the doors it names are built to those four conditions.",
      },
      coverage: {
        mirrored: coverage.mirrored,
        audited: coverage.audited,
        topics: coverage.topics,
        blocked_and_not_served: coverage.blocked,
        cited_against_a_capability: coverage.cited,
      },
      agreement: {
        agree: coverage.agree,
        swamp_stricter: coverage.swamp_stricter,
        swamp_looser: coverage.swamp_looser,
        unreadable: coverage.unreadable,
        agree_percent: rate(coverage.agree),
        note: "Where this deployment's engine and ClawHub's own moderation reached the same verdict on the same bytes, and where they did not. Disagreement is the reason a second opinion exists, and it is published rather than smoothed over.",
      },
      sweep: coverage.crawl,
      doors: {
        search: `${SITE_URL}/api/registry/skills`,
        one: `${SITE_URL}/api/registry/skills/{owner}/{slug}`,
        gaps: `${SITE_URL}/api/registry/gaps`,
        page: `${SITE_URL}/skills/registry`,
        mcp: `${SITE_URL}/api/mcp`,
      },
      limits: {
        reads: "Cached. The mirror is refreshed by a bounded crawl and never by a read, so a reader never costs the registry a request.",
        audits: "Bounded and batched, and each one costs two requests to the registry, which is why the order documents are read in is a published decision rather than an accident.",
        nothing_is_run: "No skill from this registry is ever executed, installed or imported. The bytes are read to judge them, and the verdict and its digest are all that leave the auditor.",
      },
      disclosure: REGISTRY_DISCLOSURE,
      canonical: `${SITE_URL}/skills/registry`,
    },
    { headers: { "cache-control": "public, max-age=300, stale-while-revalidate=900", "access-control-allow-origin": "*" } },
  );
}
