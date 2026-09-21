import type { ReactElement } from "react";

/**
 * The sparkline for a machine's telemetry, shared by the roster and the
 * detail page, as plain server-rendered SVG. No client JS and no chart
 * library: a reading true when the page was drawn is the reading it shows.
 * The area under the line is filled so a flat series still reads as a shape.
 */
export function Sparkline({ points, min, max }: { points: number[]; min: number; max: number }): ReactElement {
  const W = 560;
  const H = 56;
  const PAD = 3;
  const span = max - min || 1;
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - PAD * 2);
  const line = points.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H - PAD} L${x(0).toFixed(1)},${H - PAD} Z`;
  const lastX = x(points.length - 1).toFixed(1);
  const lastY = y(points[points.length - 1]).toFixed(1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-14 w-full" preserveAspectRatio="none" role="img" aria-label="recent telemetry">
      <path d={area} className="fill-bug/10" />
      <path d={line} fill="none" className="stroke-bug" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
      <circle cx={lastX} cy={lastY} r={2.4} className="fill-bug" />
    </svg>
  );
}

export type SeriesPoint = { v: number; at: number; metric: string; unit: string };

/**
 * The telemetry history for one machine, oldest first, grouped by metric.
 *
 * Drawn from the deeper history read rather than a latest-readings slice, so
 * the line shows the shape of the day and not just its last three points. A
 * gap longer than three times the median spacing is marked in the caption
 * rather than smoothed over: hours where a machine said nothing are hours,
 * not points, and joining across them would invent a flat line that never
 * existed.
 */
export function telemetrySeries(
  history: { machine_id: string; metric: string | null; value: number | null; unit: string | null; created_at: string }[],
  machineId: string,
  maxPoints = 120,
) {
  const mine = history
    .filter((r) => r.machine_id === machineId && typeof r.value === "number" && Number.isFinite(r.value))
    .map((r) => ({ v: r.value as number, at: Date.parse(r.created_at), metric: r.metric ?? "value", unit: r.unit ?? "" }));
  if (mine.length < 3) return null;
  const byMetric = new Map<string, SeriesPoint[]>();
  for (const p of mine) {
    const list = byMetric.get(p.metric) ?? [];
    list.push(p);
    byMetric.set(p.metric, list);
  }
  // The metric with the most points is the machine's main channel.
  let best = { metric: "", points: [] as SeriesPoint[] };
  for (const [metric, points] of byMetric) {
    if (points.length > best.points.length) best = { metric, points };
  }
  if (best.points.length < 3) return null;
  const points = best.points.sort((a, b) => a.at - b.at).slice(-maxPoints);
  const values = points.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // Median spacing, so one slow report does not invent a gap.
  const gaps = points.slice(1).map((p, i) => p.at - points[i].at).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] ?? 0;
  const spanMinutes = Math.max(1, Math.round((points[points.length - 1].at - points[0].at) / 60000));
  const gap = points.slice(1).some((p, i) => p.at - points[i].at > Math.max(median * 3, 10 * 60 * 1000));
  const round1 = (v: number) => Math.round(v * 10) / 10;
  return {
    metric: best.metric,
    unit: best.points[best.points.length - 1].unit,
    last: round1(values[values.length - 1]),
    min: round1(min),
    max: round1(max),
    points: values,
    spanMinutes,
    gap,
  };
}
