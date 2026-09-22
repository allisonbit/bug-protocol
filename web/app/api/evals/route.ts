import { NextResponse } from "next/server";
import { beatAuthorized } from "@/lib/beat";
import { SUPABASE_CONFIGURED, supabaseAdmin } from "@/lib/supabase";
import { EVAL_WINDOW_MS, readEvalSpans, readLatestRun, scoreAndRecord } from "@/lib/swamp/eval-store";
import { composite, rate, regressions, scoreWindow } from "@/lib/swamp/evals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/evals
 *
 * The scoreboard over the swarm's own beats: what the pulse planned, ran, failed and
 * dropped in the window, read from the span rows it already publishes. Public and open,
 * because a number about a system's own performance that only the system can read is a
 * number nobody can check and every part of it is arithmetic anybody can repeat.
 *
 * A GET NEVER WRITES. It computes the window live and returns the most recent stored run
 * beside it, so a reader can see the trend without visiting this door changing it. Storing
 * a run is the POST, and that one makes outbound-free work on this deployment's own rows.
 */
export async function GET(req: Request) {
  const sb = supabaseAdmin();
  if (!sb || !SUPABASE_CONFIGURED) {
    return NextResponse.json(
      { error: { code: "BACKEND_UNCONFIGURED", message: "The swamp backend isn't configured on this deployment yet." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const url = new URL(req.url);
  const hours = Math.min(Math.max(Number(url.searchParams.get("hours")) || 6, 1), 72);
  const toIso = new Date().toISOString();
  const fromIso = new Date(Date.parse(toIso) - hours * 60 * 60 * 1000).toISOString();

  const spans = await readEvalSpans(sb, fromIso, toIso);
  const scoreboard = scoreWindow(spans, fromIso, toIso);
  const previous = await readLatestRun(sb);
  const moved = regressions(scoreboard, previous);

  return NextResponse.json(
    {
      what: "A count over the pulse's own spans: what each beat planned, ran, failed and dropped. Not a benchmark of intelligence and not a model grading a model.",
      method: "POST",
      arithmetic: "Every number is arithmetic over rows in the public log, so any reader can recompute it from the same window.",
      window: { from: fromIso, to: toIso, hours },
      scoreboard,
      composite_note:
        "score = 0.5 * landed_rate + 0.5 * acted_share, both as integer percents. Degradation is reported beside the score, not folded in, because a degraded beat that still ran its reflex policy is a success of the fallback.",
      regressions: moved,
      compared_to: previous ? { to: previous.to, score: previous.score } : null,
      not_this: "Nothing here changes a rule, a prompt or a weight. A regression is a sentence a reader can act on, not an action this deployment takes.",
      docs: "/evals",
      stored_runs: "POST here with the beat secret to store this window as a run and put it on the bus.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}

/**
 * POST /api/evals
 *
 * Score the window, store it, compare it to the previous run and say so on the bus. Bounded
 * to this deployment's own rows: the read has no outbound traffic, so unlike the registry
 * doors this one has no reason to be closed, but storing a run is a write and the beat
 * secret is what keeps a stranger from filling the table.
 *
 *   ?hours=1..72   the window to score (default 6)
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
  const hours = Math.min(Math.max(Number(url.searchParams.get("hours")) || EVAL_WINDOW_MS / 3600000, 1), 72);
  const toIso = new Date().toISOString();
  const fromIso = new Date(Date.parse(toIso) - hours * 60 * 60 * 1000).toISOString();

  try {
    const outcome = await scoreAndRecord(sb, { fromIso, toIso });
    return NextResponse.json(
      {
        ok: true,
        ...outcome,
        composite: composite(outcome.scoreboard.landedRate, rate(outcome.scoreboard.actedBeats, outcome.scoreboard.beats)),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: { code: "SCORE_FAILED", message: e instanceof Error ? e.message : "unknown error" } },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
