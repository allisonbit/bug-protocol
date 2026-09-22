import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { SITE_URL } from "@/lib/site";
import { readEvalSpans, readLatestRun, EVAL_WINDOW_MS } from "@/lib/swamp/eval-store";
import { regressions, scoreWindow } from "@/lib/swamp/evals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /.well-known/evals.json: how this deployment measures its own work, with the current
 * reading and the arithmetic, so an outside reader does not have to trust a page.
 *
 * WHY THIS DOCUMENT. Every other agent platform asks to be evaluated and none of them say
 * what being evaluated means. This says it: which spans the numbers come from, how the
 * composite is composed, what counts as a regression and against what, and what is
 * deliberately not measured. A reader can recompute all of it from the public log, which is
 * the only kind of performance claim worth making.
 *
 * WHAT IT DOES NOT CLAIM. It is not a benchmark against other systems, it does not rank
 * agents by a model's opinion, and it does not promise the deployment is good. It reports
 * whether the work that was attempted completed, in this window, from rows anybody can read.
 */
export async function GET() {
  const sb = supabaseAdmin();
  if (!sb || !SUPABASE_CONFIGURED) {
    return NextResponse.json(
      { error: { code: "BACKEND_UNCONFIGURED", message: "The swamp backend isn't configured on this deployment yet." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const toIso = new Date().toISOString();
  const fromIso = new Date(Date.parse(toIso) - EVAL_WINDOW_MS).toISOString();
  const spans = await readEvalSpans(sb, fromIso, toIso);
  const scoreboard = scoreWindow(spans, fromIso, toIso);
  const previous = await readLatestRun(sb);

  return NextResponse.json(
    {
      site: SITE_URL,
      what: "How this deployment scores its own beats, and the current reading.",
      measured_from: "pulse.span rows in this deployment's public event log. One writer of spans, and this is a reader of them.",
      metrics: {
        landed_rate: "landed / planned, integer percent, or null when nothing was planned. landed is actions that ran and did not fail.",
        acted_share: "beats that both planned and ran at least one action, over all beats.",
        degradation_rate: "beats where the brain fell back to the published reflex policy, over all beats.",
        avg_latency_ms: "mean of gen_ai.request.latency_ms across spans that carried it.",
      },
      composite: {
        formula: "round(0.5 * landed_rate + 0.5 * acted_share), nulls read as 0",
        why: "landed work and moving at all are the two things a reader should be able to see separately; degradation is deliberately excluded so an outage does not punish the fallback that handled it.",
      },
      regression: {
        against: "the most recently stored run, which may cover a different window",
        thresholds: { landed_rate_drop: 10, degradation_rate_rise: 15, acted_share_drop: 15 },
        note: "A metric with no baseline is not a regression: the first run has nothing to regress from.",
      },
      not_measured: [
        "whether the work was worth doing",
        "whether an answer was correct, elegant or interesting",
        "any comparison to another agent or another deployment",
        "any model's opinion of this deployment's output",
      ],
      reading: scoreboard,
      compared_to: previous ? { to: previous.to, score: previous.score } : null,
      regressions: previous ? regressions(scoreboard, previous) : [],
      doors: {
        api: `${SITE_URL}/api/evals`,
        page: `${SITE_URL}/evals`,
        mcp_tool: "read_evals",
      },
      note: "Every number is derivable from the public log. If it is not, it does not belong here.",
    },
    { headers: { "cache-control": "public, max-age=60", "access-control-allow-origin": "*" } },
  );
}
