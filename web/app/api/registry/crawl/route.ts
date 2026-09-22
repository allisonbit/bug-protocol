import { NextResponse } from "next/server";
import { beatAuthorized } from "@/lib/beat";
import { SUPABASE_CONFIGURED, supabaseAdmin } from "@/lib/supabase";
import { crawlRegistry, readRegistryState } from "@/lib/registry/crawl";
import { REGISTRY_API, REGISTRY_DISCLOSURE, REGISTRY_SITE } from "@/lib/registry/clawhub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/registry/crawl
 *
 * Advance the mirror of the public ClawHub registry by a bounded number of pages.
 *
 * WHY THIS NEEDS THE BEAT SECRET WHEN OTHER BEATS ARE OPEN. Every call here makes outbound
 * requests to a server this deployment does not own, under this deployment's identity, and
 * the registry documents who is asking and throttles by it. An open door would let anyone
 * spend that budget and get this host throttled by a registry it depends on, which is the
 * same argument the ClawHub publishing door makes for the operator's account.
 *
 * WHY IT IS A SWEEP RATHER THAN ONE BIG JOB. A page of two hundred skills takes about ten
 * seconds to answer. The whole catalogue is therefore half an hour of wall time, which no
 * function survives, so the cursor lives in a row and each pass is small. See
 * `lib/registry/crawl.ts` for the two modes: a first walk of everything, and an ordinary
 * pass afterwards that stops as soon as it sees a page it already holds.
 *
 *   ?pages=1..40   pages to fetch this pass (default 3)
 *   ?mode=sweep    start the walk over from the newest skill, which is what catches a skill
 *                  that was edited or delisted since the last walk. The cursor is dropped
 *                  on the first pass of the new walk and then resumed, so this is safe to
 *                  send on every pass of a driver loop.
 */
export async function POST(req: Request) {
  const denied = beatAuthorized(req, { requireSecret: true });
  if (denied) return denied;

  const sb = supabaseAdmin();
  if (!sb || !SUPABASE_CONFIGURED) {
    return NextResponse.json(
      { error: { code: "BACKEND_UNCONFIGURED", message: "The swamp backend isn't configured on this deployment yet." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const url = new URL(req.url);
  const pages = Number(url.searchParams.get("pages") ?? 3) || 3;
  const force = url.searchParams.get("mode") === "sweep";

  try {
    const outcome = await crawlRegistry(sb, { pages, force });
    return NextResponse.json(outcome, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    // The pass is reported rather than thrown, because the caller is a scheduler that has
    // to be able to tell a throttled registry from a broken deployment by reading the reply.
    return NextResponse.json(
      { error: { code: "CRAWL_FAILED", message: e instanceof Error ? e.message : "unknown error" } },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

/**
 * A GET explains the door and reports the sweep's state rather than 405-ing.
 *
 * It reads and never writes: the state row is created by a pass, not by somebody looking.
 * A read that failed is reported as such rather than folded into "never walked", because
 * those two answers lead a caller to opposite actions.
 */
export async function GET() {
  const sb = supabaseAdmin();
  let sweepError: string | null = null;
  const state =
    sb && SUPABASE_CONFIGURED
      ? await readRegistryState(sb).catch((e: unknown) => {
          sweepError = e instanceof Error ? e.message : "the sweep state could not be read";
          return null;
        })
      : null;
  return NextResponse.json(
    {
      what: "Mirrors the public ClawHub skill registry into this deployment, a few pages per pass, so the whole published corpus can be searched here with a verdict attached.",
      method: "POST",
      auth: "the platform's beat secret in the Authorization header (CRON_SECRET or SWAMP_BEAT_SECRET)",
      params: {
        pages: "1 to 40 pages of 200 skills, default 3",
        mode: "`sweep` starts the walk over from the newest skill, and then resumes it pass by pass, which is the only mode that notices an edit or a delisting",
      },
      source: { api: REGISTRY_API, site: REGISTRY_SITE, disclosure: REGISTRY_DISCLOSURE },
      sweep_error: sweepError,
      sweep: state
        ? {
            sort: state.sort,
            complete: state.complete,
            pages_seen: state.pages_seen,
            skills_seen: state.skills_seen,
            sweeps: state.sweeps,
            last_run_at: state.last_run_at,
            last_error: state.last_error,
            note: state.complete
              ? "The catalogue has been walked end to end at least once. Ordinary passes now fetch one page and stop as soon as it holds nothing new."
              : "The first walk of the catalogue is still in progress: each pass advances a stored cursor.",
          }
        : null,
      docs: "/skills/registry",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
