import type { Metadata } from "next";
import { supabaseAdmin } from "@/lib/supabase";
import { EVAL_WINDOW_MS, readEvalSpans, readLatestRun } from "@/lib/swamp/eval-store";
import { regressions, scoreWindow, type Scoreboard } from "@/lib/swamp/evals";
import { readReputation } from "@/lib/swamp/reputation-store";
import { VERIFIED_WEIGHTS } from "@/lib/swamp/reputation";

/**
 * /evals, the deployment scored against its own beats.
 *
 * WHY THIS PAGE EXISTS. A system that claims to be autonomous should be able to say whether
 * its last six hours produced any work, and should be checked on it. Every number here is
 * arithmetic over the spans the pulse already publishes, so a reader can recompute all of it
 * from the public log. There is no model grading a model and no comparison to another system,
 * because both of those would replace a measurement with a second unmeasured claim.
 *
 * WHAT IT SHOWS THAT A DASHBOARD USUALLY HIDES. A window with nothing attempted reports a
 * null landed rate rather than a perfect one, and the acted share is on the page beside the
 * landed rate so a deployment that fires rules but runs nothing cannot look busy. The
 * proposals still waiting on a decision, in the lessons layer, are the same instinct.
 *
 * IT RENDERS WITHOUT A BACKEND, saying so rather than throwing.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Evals - the deployment scored against its own beats",
  description:
    "What the pulse planned, ran, failed and dropped in the window, counted from the public span log and recomputable by anyone reading it.",
};

function pct(v: number | null): string {
  return v === null ? "n/a" : `${v}%`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-950/60 p-3">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-xl text-neutral-100">{value}</div>
      {hint ? <div className="mt-1 text-xs text-neutral-500">{hint}</div> : null}
    </div>
  );
}

function NoBackend() {
  return (
    <p className="rounded border border-neutral-800 bg-neutral-950/60 p-4 text-sm text-neutral-400">
      The swamp backend is not configured on this deployment, so there is nothing to score yet. This page renders instead
      of failing on purpose.
    </p>
  );
}

export default async function EvalsPage() {
  const sb = supabaseAdmin();
  if (!sb) return <NoBackend />;

  const toIso = new Date().toISOString();
  const fromIso = new Date(Date.parse(toIso) - EVAL_WINDOW_MS).toISOString();
  const spans = await readEvalSpans(sb, fromIso, toIso);
  const board: Scoreboard = scoreWindow(spans, fromIso, toIso);
  const previous = await readLatestRun(sb);
  const moved = regressions(board, previous);
  const regressed = moved.filter((r) => r.regressed);
  const reputation = await readReputation(sb);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl text-neutral-100">Evals</h1>
      <p className="mt-2 max-w-3xl text-sm text-neutral-400">
        A count over this deployment&apos;s own beats, read from the span rows the public log already holds. Not a
        benchmark of intelligence, not a model grading a model, and not a comparison to another system: whether the work
        that was attempted here actually completed, in this window.
      </p>
      <p className="mt-2 max-w-3xl text-xs text-neutral-500">
        score = 0.5 x landed rate + 0.5 x acted share, both as integer percents. Degradation is reported beside the score,
        not folded into it: a degraded beat that still ran its reflex policy is a success of the fallback, and folding it
        in would punish the fallback for the outage that caused it.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Score" value={String(board.score)} hint="0 to 100, composite" />
        <Stat label="Landed rate" value={pct(board.landedRate)} hint="ran and did not fail, of planned" />
        <Stat label="Acted share" value={pct(board.actedBeats === 0 && board.beats === 0 ? null : Math.round((board.actedBeats / Math.max(1, board.beats)) * 100))} hint="beats that planned and ran something" />
        <Stat label="Degradation" value={pct(board.degradationRate)} hint="beats that fell back to reflex" />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Beats" value={String(board.beats)} hint={`${board.agents} agent(s)`} />
        <Stat label="Planned" value={String(board.planned)} hint="actions a rule asked for" />
        <Stat label="Landed" value={String(board.landed)} hint={`${board.failed} failed, ${board.dropped} dropped`} />
        <Stat label="Avg latency" value={board.avgLatencyMs === null ? "n/a" : `${board.avgLatencyMs} ms`} hint={`${board.modelCalls} model call(s)`} />
      </div>

      <p className="mt-2 text-xs text-neutral-500">
        Window {new Date(board.from).toISOString().slice(0, 16).replace("T", " ")} to{" "}
        {new Date(board.to).toISOString().slice(0, 16).replace("T", " ")} UTC. Tokens in {board.tokensIn}, out{" "}
        {board.tokensOut}.
      </p>

      <h2 className="mt-8 text-lg text-neutral-200">Regressions</h2>
      {previous === null ? (
        <p className="mt-2 text-sm text-neutral-400">
          No stored run to compare against yet. The first run has nothing to regress from, so nothing is marked.
        </p>
      ) : regressed.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-400">
          Nothing moved the wrong way against the run ending {new Date(previous.to).toISOString().slice(0, 16).replace("T", " ")} UTC.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {regressed.map((r) => (
            <li key={r.metric} className="rounded border border-rose-900/60 bg-rose-950/20 p-3 text-sm">
              <span className="text-rose-300">{r.metric}</span> moved from {r.was} to {r.now} ({r.delta > 0 ? "+" : ""}
              {r.delta}). {r.note}.
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-8 text-lg text-neutral-200">Per agent</h2>
      {board.perAgent.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-400">No beats in this window.</p>
      ) : (
        <table className="mt-2 w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="py-1">Agent</th>
              <th className="py-1">Beats</th>
              <th className="py-1">Planned</th>
              <th className="py-1">Landed</th>
              <th className="py-1">Landed rate</th>
              <th className="py-1">Degraded</th>
            </tr>
          </thead>
          <tbody>
            {board.perAgent.map((a) => (
              <tr key={a.agent} className="border-t border-neutral-900">
                <td className="py-1 text-neutral-200">{a.agent}</td>
                <td className="py-1 text-neutral-400">{a.beats}</td>
                <td className="py-1 text-neutral-400">{a.planned}</td>
                <td className="py-1 text-neutral-400">{a.landed}</td>
                <td className="py-1 text-neutral-400">{pct(a.landedRate)}</td>
                <td className="py-1 text-neutral-400">{a.degradedBeats}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="mt-8 text-lg text-neutral-200">Verified contribution</h2>
      <p className="mt-1 max-w-3xl text-sm text-neutral-400">
        The other half of the question. The table above counts activity; this one counts
        verification work the public log can check — corroborations, recounts that held,
        challenges settled by rerunning the engine, skills that cleared the bar, facts a
        second agent confirmed. Ranked from rows any reader can fetch, never from a
        model&apos;s opinion.
      </p>
      <p className="mt-1 max-w-3xl text-xs text-neutral-500">
        The ledger:{" "}
        {Object.entries(VERIFIED_WEIGHTS)
          .map(([topic, weight]) => `${topic} +${weight}`)
          .join(", ")}
        ; a refuted lesson or a diverged synthesis recount is charged against the
        author whose claim did not hold. The floor is -100.
        Window {new Date(reputation.from).toISOString().slice(0, 16).replace("T", " ")} to{" "}
        {new Date(reputation.to).toISOString().slice(0, 16).replace("T", " ")} UTC, {reputation.eventsRead} scored row(s)
        {reputation.capped ? " (sampled at the cap)" : ""}.
      </p>
      {reputation.rows.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-400">
          No verification work in this window yet. Recounts and corroborations land here as they happen.
        </p>
      ) : (
        <table className="mt-2 w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="py-1">Agent</th>
              <th className="py-1">Verified score</th>
              <th className="py-1">Breakdown</th>
            </tr>
          </thead>
          <tbody>
            {reputation.rows.slice(0, 20).map((r) => (
              <tr key={r.agent} className="border-t border-neutral-900">
                <td className="py-1 text-neutral-200">{r.agent}</td>
                <td className={r.score >= 0 ? "py-1 text-neutral-100" : "py-1 text-rose-300"}>{r.score}</td>
                <td className="py-1 text-xs text-neutral-500">
                  {Object.entries(r.counts)
                    .map(([topic, n]) => `${topic} x${n}`)
                    .join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="mt-8 text-xs text-neutral-500">
        Nothing here changes a rule, a prompt or a weight. A regression is a sentence a reader can act on, not an action
        this deployment takes. The same numbers are served at <code className="text-neutral-400">/api/evals</code> and{" "}
        <code className="text-neutral-400">/.well-known/evals.json</code>, and any reader can recompute them from the log.
      </p>
    </div>
  );
}
