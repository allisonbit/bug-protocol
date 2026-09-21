import type { Metadata } from "next";
import { getWholeBus } from "@/lib/queries";
import type { SwampEvent } from "@/lib/agents/types";

export const metadata: Metadata = {
  title: "Observability - trace view",
  description:
    "The pulse's observe-decide-act cycle as OpenTelemetry GenAI spans, rendered from the public log.",
};

export const revalidate = 0;

type Span = {
  seq: number;
  created_at: string;
  beat: number;
  agent: string;
  phase: string;
  model: string;
  latency_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  finish: string | null;
  outcome: string;
  degraded: boolean;
  reason: string | null;
};

function parseSpan(e: SwampEvent): Span | null {
  const b = e.payload as Record<string, unknown> | null;
  if (!b) return null;
  const beat = typeof b.beat === "number" ? b.beat : null;
  const agent = typeof b.agent === "string" ? b.agent : null;
  if (beat === null || !agent) return null;
  const att = (b.attributes ?? {}) as Record<string, unknown>;
  const n = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const model =
    typeof att["gen_ai.request.model"] === "string" ? (att["gen_ai.request.model"] as string) : "-";
  const outcome = typeof b.outcome === "string" ? b.outcome : "observed";
  return {
    seq: e.seq,
    created_at: e.created_at,
    beat,
    agent,
    phase: typeof b.phase === "string" ? b.phase : "beat",
    model,
    latency_ms: n(att.latency_ms),
    tokens_in: n(att["gen_ai.usage.input_tokens"]),
    tokens_out: n(att["gen_ai.usage.output_tokens"]),
    finish:
      Array.isArray(att["gen_ai.response.finish_reasons"]) && att["gen_ai.response.finish_reasons"].length > 0
        ? String((att["gen_ai.response.finish_reasons"] as unknown[])[0])
        : null,
    outcome,
    degraded: outcome === "degraded",
    reason: typeof b.reason === "string" ? b.reason : null,
  };
}

export default async function ObservabilityPage() {
  const bus = await getWholeBus(400);
  const spans = bus
    .filter((e) => e.topic === "pulse.span")
    .map(parseSpan)
    .filter((s): s is Span => s !== null);

  const beats = new Map<number, Span[]>();
  for (const s of spans) {
    const list = beats.get(s.beat) ?? [];
    list.push(s);
    beats.set(s.beat, list);
  }
  const recent = [...beats.entries()].sort((a, b) => b[0] - a[0]).slice(0, 12);

  const modelCalls = spans.filter((s) => s.phase === "chat");
  const totals = modelCalls.reduce(
    (acc, s) => ({
      calls: acc.calls + 1,
      tin: acc.tin + (s.tokens_in ?? 0),
      tout: acc.tout + (s.tokens_out ?? 0),
      ms: acc.ms + (s.latency_ms ?? 0),
    }),
    { calls: 0, tin: 0, tout: 0, ms: 0 },
  );
  const degradations = spans.filter((s) => s.degraded);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-bold">Observability</h1>
        <p className="mt-2 max-w-3xl text-sm text-neutral-400">
          The pulse&apos;s observe-decide-act cycle as OpenTelemetry GenAI spans. Every agent beat is
          a span, every model call a child span, and the record is the public log itself: what you
          see here anyone can recompute from{" "}
          <code className="text-xs">/api/swamp/events</code> by filtering topic{" "}
          <code className="text-xs">pulse.span</code>. Field names follow the conventions:{" "}
          <code className="text-xs">gen_ai.usage.input_tokens</code>,{" "}
          <code className="text-xs">gen_ai.request.model</code>,{" "}
          <code className="text-xs">gen_ai.response.finish_reasons</code>.
        </p>
      </header>

      <section className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "spans in window", value: String(spans.length), warn: false },
          { label: "model calls", value: String(totals.calls), warn: false },
          {
            label: "tokens in / out",
            value: `${totals.tin} / ${totals.tout}`,
            warn: false,
          },
          { label: "degradations", value: String(degradations.length), warn: degradations.length > 0 },
        ].map((c) => (
          <div key={c.label} className="rounded border border-neutral-800 bg-neutral-900/50 p-3">
            <div className={`text-2xl font-semibold ${c.warn ? "text-amber-400" : ""}`}>{c.value}</div>
            <div className="text-xs text-neutral-500">{c.label}</div>
          </div>
        ))}
      </section>

      {degradations.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold text-amber-400">Degradations</h2>
          <ul className="space-y-1 text-sm">
            {degradations.slice(0, 6).map((s) => (
              <li key={s.seq} className="rounded border border-amber-900/50 bg-amber-950/20 px-3 py-2">
                beat {s.beat} · {s.agent} · {s.reason ?? "reason not stated"} ·{" "}
                <span className="text-neutral-500">seq {s.seq}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold">Traces by beat (newest first)</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No spans in the window yet. The pulse writes one span per agent per beat, quiet beats
            included; they appear here on the next pulse tick.
          </p>
        ) : (
          <div className="space-y-4">
            {recent.map(([beat, list]) => {
              const ordered = [...list].sort((a, b) => a.seq - b.seq);
              const t0 = new Date(ordered[0].created_at).getTime();
              const tEnd = new Date(ordered[ordered.length - 1].created_at).getTime();
              return (
                <div key={beat} className="rounded border border-neutral-800 bg-neutral-900/40 p-4">
                  <div className="mb-3 flex items-baseline justify-between">
                    <span className="font-mono text-sm font-semibold">beat {beat}</span>
                    <span className="text-xs text-neutral-500">
                      {ordered.length} span{ordered.length === 1 ? "" : "s"} ·{" "}
                      {((tEnd - t0) / 1000).toFixed(1)}s wall · {ordered[0].created_at.slice(11, 19)} UTC
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[640px] text-left text-xs">
                      <thead className="text-neutral-500">
                        <tr>
                          <th className="pb-1 pr-3 font-medium">agent</th>
                          <th className="pb-1 pr-3 font-medium">phase</th>
                          <th className="pb-1 pr-3 font-medium">model</th>
                          <th className="pb-1 pr-3 font-medium">latency</th>
                          <th className="pb-1 pr-3 font-medium">tokens in/out</th>
                          <th className="pb-1 pr-3 font-medium">finish</th>
                          <th className="pb-1 font-medium">outcome</th>
                        </tr>
                      </thead>
                      <tbody className="font-mono">
                        {ordered.map((s) => (
                          <tr key={s.seq} className={s.degraded ? "text-amber-400" : "text-neutral-300"}>
                            <td className="py-1 pr-3">{s.agent}</td>
                            <td className="py-1 pr-3">{s.phase}</td>
                            <td className="py-1 pr-3 text-neutral-500">{s.model}</td>
                            <td className="py-1 pr-3">
                              {s.latency_ms !== null ? `${s.latency_ms}ms` : "-"}
                            </td>
                            <td className="py-1 pr-3">
                              {s.tokens_in !== null || s.tokens_out !== null
                                ? `${s.tokens_in ?? 0} / ${s.tokens_out ?? 0}`
                                : "-"}
                            </td>
                            <td className="py-1 pr-3">{s.finish ?? "-"}</td>
                            <td className="py-1">{s.outcome}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <footer className="mt-10 text-xs text-neutral-500">
        Trace data comes from the same public event log everything else reads; recompute it
        yourself from /api/swamp/events with topic=pulse.span. The roadmap this follows is
        STANDARDS.md in the repository root.
      </footer>
    </div>
  );
}
