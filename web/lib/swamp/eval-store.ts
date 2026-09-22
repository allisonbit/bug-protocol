import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appendSystemEvent } from "@/lib/agents/ingest";
import { parseEvalSpan, regressions, scoreWindow, type EvalSpan, type Regression, type Scoreboard } from "./evals";

/**
 * THE SCOREBOARD, READ AND WRITTEN.
 *
 * `lib/swamp/evals.ts` is the arithmetic and this is the storage around it, the
 * same split the rest of this layer uses. Spans come from `events`, which is where
 * the pulse already writes them, so nothing here is a second measurement of the
 * same work: there is one writer of spans and this is a reader of them.
 */

/** How many spans a window reads. Bounded: a window is a sample, and it says so. */
export const EVAL_WINDOW_SPANS = 800;

/** The default window, in milliseconds. Six hours of beats. */
export const EVAL_WINDOW_MS = 6 * 60 * 60 * 1000;

type SpanRow = { seq: number; created_at: string; payload: unknown };

/** The beat spans in the window, oldest first so a reader can walk them in time order. */
export async function readEvalSpans(sb: SupabaseClient, fromIso: string, toIso: string): Promise<EvalSpan[]> {
  const { data, error } = await sb
    .from("events")
    .select("seq, created_at, payload")
    .eq("topic", "pulse.span")
    .gte("created_at", fromIso)
    .lt("created_at", toIso)
    .order("seq", { ascending: true })
    .limit(EVAL_WINDOW_SPANS);
  if (error || !data) return [];
  return (data as SpanRow[])
    .map((row) => parseEvalSpan({ seq: row.seq, created_at: row.created_at, topic: "pulse.span", payload: row.payload }))
    .filter((s): s is EvalSpan => s !== null);
}

/** The most recent stored run, whatever window it covered. */
export async function readLatestRun(sb: SupabaseClient): Promise<Scoreboard | null> {
  const { data, error } = await sb
    .from("eval_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const r = data as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === "number" ? v : 0);
  const o = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const s = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    from: s(r.window_from),
    to: s(r.window_to),
    beats: n(r.beats),
    agents: n(r.agents),
    planned: n(r.planned),
    ran: n(r.ran),
    failed: n(r.failed),
    landed: n(r.landed),
    dropped: n(r.dropped),
    landedRate: o(r.landed_rate),
    degradedBeats: n(r.degraded_beats),
    degradationRate: o(r.degradation_rate),
    actedBeats: n(r.acted_beats),
    modelCalls: n(r.model_calls),
    tokensIn: n(r.tokens_in),
    tokensOut: n(r.tokens_out),
    avgLatencyMs: o(r.avg_latency_ms),
    perAgent: Array.isArray(r.per_agent) ? (r.per_agent as Scoreboard["perAgent"]) : [],
    score: n(r.score),
  };
}

export type EvalOutcome = {
  scoreboard: Scoreboard;
  regressions: Regression[];
  comparedTo: string | null;
  recorded: boolean;
  eventSeq: number | null;
};

/**
 * Score a window, compare it to the last stored run, store the result and say so on
 * the bus.
 *
 * The write and the event are both best effort: a failed insert must not lose the
 * scoreboard the caller asked for, and a failed event must not lose the row. The
 * caller gets `recorded` either way so a page can tell a stored run from a computed
 * one rather than implying a trend that was never kept.
 */
export async function scoreAndRecord(
  sb: SupabaseClient,
  opts?: { fromIso?: string; toIso?: string; agent?: string },
): Promise<EvalOutcome> {
  const toIso = opts?.toIso ?? new Date().toISOString();
  const fromIso = opts?.fromIso ?? new Date(Date.parse(toIso) - EVAL_WINDOW_MS).toISOString();

  const spans = await readEvalSpans(sb, fromIso, toIso);
  const scoreboard = scoreWindow(spans, fromIso, toIso);
  const previous = await readLatestRun(sb);
  const moved = regressions(scoreboard, previous);

  let recorded = false;
  let eventSeq: number | null = null;
  try {
    const { error } = await sb.from("eval_runs").insert({
      window_from: fromIso,
      window_to: toIso,
      beats: scoreboard.beats,
      agents: scoreboard.agents,
      planned: scoreboard.planned,
      ran: scoreboard.ran,
      failed: scoreboard.failed,
      landed: scoreboard.landed,
      dropped: scoreboard.dropped,
      landed_rate: scoreboard.landedRate,
      degraded_beats: scoreboard.degradedBeats,
      degradation_rate: scoreboard.degradationRate,
      acted_beats: scoreboard.actedBeats,
      model_calls: scoreboard.modelCalls,
      tokens_in: scoreboard.tokensIn,
      tokens_out: scoreboard.tokensOut,
      avg_latency_ms: scoreboard.avgLatencyMs,
      score: scoreboard.score,
      regressions: moved,
      per_agent: scoreboard.perAgent,
    });
    recorded = !error;
  } catch {
    recorded = false;
  }

  const regressed = moved.filter((r) => r.regressed);
  try {
    const topic = regressed.length > 0 ? "eval.regressed" : "eval.scored";
    eventSeq = await appendSystemEvent(sb, {
      topic,
      payload: {
        score: scoreboard.score,
        beats: scoreboard.beats,
        planned: scoreboard.planned,
        landed: scoreboard.landed,
        landed_rate: scoreboard.landedRate,
        degradation_rate: scoreboard.degradationRate,
        acted_beats: scoreboard.actedBeats,
        window_from: fromIso,
        window_to: toIso,
        regressions: regressed.map((r) => ({ metric: r.metric, was: r.was, now: r.now, delta: r.delta })),
      },
    });
  } catch {
    eventSeq = null;
  }

  return {
    scoreboard,
    regressions: moved,
    comparedTo: previous ? previous.to : null,
    recorded,
    eventSeq,
  };
}
