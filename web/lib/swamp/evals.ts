/**
 * EVALS: DID THE DEPLOYMENT ACTUALLY DO ANYTHING THIS WINDOW.
 *
 * This is not a benchmark of intelligence. It is a count over the spans the pulse
 * already writes about itself, and every number here is derivable from the public
 * log by anyone reading it. That is the point. An agent platform that cannot say
 * whether its own beats produced work is trusting a feeling about itself, and the
 * 2026 literature on agent evaluation is clear that the useful measurement is the
 * trajectory (rule, action, result) rather than the eloquence of a final answer.
 *
 * Three things are deliberately NOT here:
 *
 *   - No model is asked to grade anything. A model judging a model's output turns
 *     a measurement into a second unmeasured claim.
 *   - No score is a rate over zero. A window with no planned actions reports a null
 *     landed rate, not a perfect one, because "nothing was attempted" and "everything
 *     that was attempted worked" are different facts and a dashboard that merges them
 *     reports a calm deployment during an outage.
 *   - Nothing here changes a rule, a prompt or a weight. It reports. A regression is
 *     a sentence a reader can act on, not an action this module takes.
 *
 * PURE. No database, no fetch, no clock. scripts/verify-evals.cjs walks every branch.
 */

/** One beat, as the pulse recorded it. Tolerant of the log's optional fields. */
export type EvalSpan = {
  seq: number;
  at: string;
  agent: string;
  planned: number;
  ran: number;
  failed: number;
  dropped: number;
  /** Present only when the brain degraded; the sentence saying why. */
  degraded: string | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number | null;
  durationMs: number | null;
  errorType: string | null;
};

export type AgentScore = {
  agent: string;
  beats: number;
  planned: number;
  landed: number;
  degradedBeats: number;
  landedRate: number | null;
};

export type Scoreboard = {
  /** The window the numbers describe, as half-open [from, to). */
  from: string;
  to: string;
  beats: number;
  agents: number;
  planned: number;
  ran: number;
  failed: number;
  /** Actions that ran and did not fail. Not "planned minus failed": a rule that
   *  planned work and ran none reports here honestly as zero landed. */
  landed: number;
  dropped: number;
  /** landed / planned as an integer percent, or null when nothing was planned. */
  landedRate: number | null;
  degradedBeats: number;
  /** degradedBeats / beats as an integer percent, or null when there were no beats. */
  degradationRate: number | null;
  /** Beats that planned at least one action AND ran at least one. The trajectory the
   *  research names: a beat that planned nothing or ran nothing has no trajectory. */
  actedBeats: number;
  modelCalls: number;
  tokensIn: number;
  tokensOut: number;
  avgLatencyMs: number | null;
  perAgent: AgentScore[];
  /** A 0..100 composite, and the sentence saying exactly how it is composed. */
  score: number;
};

export type Regression = {
  metric: "landed_rate" | "degradation_rate" | "acted_share";
  was: number | null;
  now: number | null;
  delta: number;
  threshold: number;
  regressed: boolean;
  note: string;
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0);
const optNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const optStr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** Percent of a over b, rounded, or null when b is zero. */
export function rate(a: number, b: number): number | null {
  if (b <= 0) return null;
  return Math.round((a / b) * 100);
}

/**
 * One event's payload to one span, or null when it is not a beat span.
 *
 * The payload nests everything under `span`. A row that is not an object, or that
 * has no agent, is not a beat and is skipped rather than counted as an empty one:
 * counting a malformed row as a beat inflates the beat count and deflates every rate
 * computed over it, which is the direction that hides a broken writer.
 */
export function parseEvalSpan(event: { seq: number; created_at: string; topic?: string; payload: unknown }): EvalSpan | null {
  if (event.topic && event.topic !== "pulse.span") return null;
  const p = event.payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return null;
  const s = p.span as Record<string, unknown> | undefined;
  if (!s || typeof s !== "object") return null;
  const agent = optStr(s["agent_handle"]);
  if (!agent) return null;
  return {
    seq: event.seq,
    at: event.created_at,
    agent,
    planned: num(s["swamp.actions.planned"]),
    ran: num(s["swamp.actions.ran"]),
    failed: num(s["swamp.actions.failed"]),
    dropped: num(s["swamp.dropped"]),
    degraded: optStr(s["swamp.degraded"]),
    model: optStr(s["gen_ai.request.model"]),
    tokensIn: num(s["gen_ai.usage.input_tokens"]),
    tokensOut: num(s["gen_ai.usage.output_tokens"]),
    latencyMs: optNum(s["gen_ai.request.latency_ms"]),
    durationMs: optNum(s["duration_ms"]),
    errorType: optStr(s["error.type"]),
  };
}

/**
 * The composite, and its arithmetic stated so a reader can recompute it.
 *
 * Half the weight is the landed rate over planned actions: did the work that was
 * attempted actually complete. Half is the acted share, the beats that both planned
 * and ran something: a deployment whose rules fire but never run anything is idle
 * while looking busy. Degradation is reported beside the score, not folded into it,
 * because a degraded beat that still ran its reflex policy is a success of the
 * fallback and folding it in would punish the fallback for the outage that caused it.
 */
export function composite(landedRate: number | null, actedShare: number | null): number {
  const l = landedRate ?? 0;
  const a = actedShare ?? 0;
  return Math.round(0.5 * l + 0.5 * a);
}

/** Score a window of spans. `from` and `to` are labels the caller supplies. */
export function scoreWindow(spans: EvalSpan[], from: string, to: string): Scoreboard {
  let planned = 0;
  let ran = 0;
  let failed = 0;
  let dropped = 0;
  let degradedBeats = 0;
  let actedBeats = 0;
  let modelCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let latencySum = 0;
  let latencyN = 0;

  const byAgent = new Map<string, AgentScore>();

  for (const s of spans) {
    planned += s.planned;
    ran += s.ran;
    failed += s.failed;
    dropped += s.dropped;
    if (s.degraded) degradedBeats += 1;
    if (s.planned > 0 && s.ran > 0) actedBeats += 1;
    if (s.model) modelCalls += 1;
    tokensIn += s.tokensIn;
    tokensOut += s.tokensOut;
    if (s.latencyMs !== null) {
      latencySum += s.latencyMs;
      latencyN += 1;
    }

    const a = byAgent.get(s.agent) ?? { agent: s.agent, beats: 0, planned: 0, landed: 0, degradedBeats: 0, landedRate: null };
    a.beats += 1;
    a.planned += s.planned;
    a.landed += Math.max(0, s.ran - s.failed);
    if (s.degraded) a.degradedBeats += 1;
    byAgent.set(s.agent, a);
  }

  for (const a of byAgent.values()) a.landedRate = rate(a.landed, a.planned);

  const landed = Math.max(0, ran - failed);
  const beats = spans.length;
  const landedRate = rate(landed, planned);
  const actedShare = rate(actedBeats, beats);

  return {
    from,
    to,
    beats,
    agents: byAgent.size,
    planned,
    ran,
    failed,
    landed,
    dropped,
    landedRate,
    degradedBeats,
    degradationRate: rate(degradedBeats, beats),
    actedBeats,
    modelCalls,
    tokensIn,
    tokensOut,
    avgLatencyMs: latencyN > 0 ? Math.round(latencySum / latencyN) : null,
    perAgent: [...byAgent.values()].sort((a, b) => b.beats - a.beats || a.agent.localeCompare(b.agent)),
    score: composite(landedRate, actedShare),
  };
}

/**
 * Which metrics moved the wrong way, against the previous run.
 *
 * A metric with no baseline is reported as not a regression rather than as one:
 * the first run of a deployment has nothing to regress from, and inventing a
 * baseline of zero would mark every first run as an improvement or a collapse.
 */
export function regressions(now: Scoreboard, was: Scoreboard | null, opts?: { landedDrop?: number; degradationRise?: number; actedDrop?: number }): Regression[] {
  const landedDrop = opts?.landedDrop ?? 10;
  const degradationRise = opts?.degradationRise ?? 15;
  const actedDrop = opts?.actedDrop ?? 15;
  if (!was) return [];

  const out: Regression[] = [];

  const lr = now.landedRate;
  const lw = was.landedRate;
  out.push({
    metric: "landed_rate",
    was: lw,
    now: lr,
    delta: lr !== null && lw !== null ? lr - lw : 0,
    threshold: -landedDrop,
    regressed: lr !== null && lw !== null && lw - lr >= landedDrop,
    note: "the share of planned actions that ran and did not fail",
  });

  const dr = now.degradationRate;
  const dw = was.degradationRate;
  out.push({
    metric: "degradation_rate",
    was: dw,
    now: dr,
    delta: dr !== null && dw !== null ? dr - dw : 0,
    threshold: degradationRise,
    regressed: dr !== null && dw !== null && dr - dw >= degradationRise,
    note: "the share of beats where the brain fell back to the reflex policy",
  });

  const ar = rate(now.actedBeats, now.beats);
  const aw = rate(was.actedBeats, was.beats);
  out.push({
    metric: "acted_share",
    was: aw,
    now: ar,
    delta: ar !== null && aw !== null ? ar - aw : 0,
    threshold: -actedDrop,
    regressed: ar !== null && aw !== null && aw - ar >= actedDrop,
    note: "the share of beats that both planned and ran at least one action",
  });

  return out;
}
