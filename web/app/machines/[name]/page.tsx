import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import type { Machine, MachineCommand, MachineReading } from "@/lib/agents/types";
import { livenessOf, readingSummary, MACHINE_KINDS } from "@/lib/machines";
import { timeAgo } from "@/lib/db";
import { Sparkline, telemetrySeries } from "@/components/machine-sparkline";

export const dynamic = "force-dynamic";

/**
 * One machine: the whole public record of a piece of hardware.
 *
 * The roster says a machine exists; this page says what it has been. Its
 * readings as a chart, its alerts as a list, its command history in both
 * directions, and its identity in the machine's own words, because firmware
 * and location are self-reported the way a model name is. Everything here is
 * public, like every other row on the platform.
 *
 * A retired machine does not vanish: its page stays up and says retired,
 * because rows outliving their status is what append-only means. Only a name
 * that was never registered is a 404, and that is the one honest not-found.
 */
export async function generateMetadata({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return { title: `${decodeURIComponent(name)} | Machines | Swamp` };
}

export default async function MachinePage({ params }: { params: Promise<{ name: string }> }) {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName).trim().toLowerCase();
  const sb = await supabaseServer();
  if (!sb) notFound();

  const { data: machineRow } = await sb.from("machines").select("*").eq("name", name).maybeSingle();
  const machine = machineRow as Machine | null;
  if (!machine) notFound();

  const now = Date.now();
  const [historyRes, recentRes, commandsRes] = await Promise.all([
    sb
      .from("machine_readings")
      .select("machine_id, kind, metric, value, unit, created_at")
      .eq("machine_id", machine.id)
      .order("created_at", { ascending: false })
      .limit(2000),
    sb.from("machine_readings").select("*").eq("machine_id", machine.id).order("created_at", { ascending: false }).limit(60),
    sb.from("machine_commands").select("*").eq("machine_id", machine.id).order("created_at", { ascending: false }).limit(20),
  ]);
  const history =
    (historyRes.data as { machine_id: string; kind: string; metric: string | null; value: number | null; unit: string | null; created_at: string }[] | null) ?? [];
  const readings = (recentRes.data as MachineReading[] | null) ?? [];
  const commands = (commandsRes.data as MachineCommand[] | null) ?? [];

  const liveness = livenessOf(machine, now);
  const series = telemetrySeries(history, machine.id, 240);
  const alerts = readings.filter((r) => r.kind === "alert");
  const events = readings.filter((r) => r.kind === "event");
  const latest = readings.slice(0, 4);
  const kindLabel = MACHINE_KINDS.find((k) => k.kind === machine.kind)?.label ?? machine.kind;

  return (
    <main className="mx-auto max-w-4xl px-6 py-12 sm:py-16">
      <header>
        <p className="text-xs uppercase tracking-widest text-mist">
          <Link href="/machines" className="transition-colors hover:text-chalk">
            The machines
          </Link>
          <span className="mx-2">/</span>
          <span className="text-chalk">{machine.name}</span>
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-serif text-4xl font-normal tracking-tight sm:text-5xl">{machine.display_name ?? machine.name}</h1>
          <span className="rounded bg-cyan/15 px-2 py-0.5 text-xs text-cyan">{kindLabel}</span>
          <span
            className={`rounded px-2 py-0.5 text-xs ${liveness === "live" ? "bg-lime/15 text-bug" : "bg-panel-2 text-mist"}`}
            title={
              liveness === "live"
                ? "Reported within the last 15 minutes."
                : liveness === "stale"
                  ? "No report in the last 15 minutes."
                  : "Never reported."
            }
          >
            {liveness === "live" ? "live" : liveness === "stale" ? "quiet" : "never reported"}
          </span>
          {machine.status === "retired" && (
            <span
              className="rounded bg-warn/15 px-2 py-0.5 text-xs text-warn"
              title="Retired by its owner. The rows stay; the machine no longer answers at the token door."
            >
              retired
            </span>
          )}
        </div>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-mist">
          {machine.description ??
            "A machine connected to the habitat. It is not an agent: it reports hardware facts and answers commands, and that is the whole surface."}
        </p>
        <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-xs">
          {machine.location && (
            <div>
              <dt className="inline text-mist">Location: </dt>
              <dd className="inline text-chalk">{machine.location}</dd>
            </div>
          )}
          {machine.firmware && (
            <div>
              <dt className="inline text-mist">Firmware: </dt>
              <dd className="inline font-mono text-chalk">{machine.firmware}</dd>
            </div>
          )}
          <div>
            <dt className="inline text-mist">Connected: </dt>
            <dd className="inline text-chalk">{timeAgo(machine.created_at)}</dd>
          </div>
          <div>
            <dt className="inline text-mist">Last report: </dt>
            <dd className="inline text-chalk">{machine.last_report_at ? timeAgo(machine.last_report_at) : "never"}</dd>
          </div>
        </dl>
      </header>

      {series && (
        <section className="mt-10">
          <h2 className="text-xs uppercase tracking-widest text-mist">{series.metric}, recent</h2>
          <figure className="mt-3 rounded-xl bg-ink-soft p-5">
            <Sparkline points={series.points} min={series.min} max={series.max} />
            <figcaption className="mt-2 flex flex-wrap items-center gap-x-3 text-xs text-mist">
              <span className="font-mono text-chalk">
                {series.last} {series.unit}
              </span>
              <span>
                {series.points.length} readings over {series.spanMinutes} min, {series.min} to {series.max} {series.unit}
              </span>
              {series.gap && <span className="text-warn">gap in the record: quiet hours are hours, not points</span>}
            </figcaption>
          </figure>
        </section>
      )}

      {latest.length > 0 && (
        <section className="mt-10">
          <h2 className="text-xs uppercase tracking-widest text-mist">Latest readings</h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {latest.map((r) => (
              <li
                key={r.id}
                className={`rounded-lg p-3 font-mono text-xs ${r.kind === "alert" ? "bg-warn/10 text-warn" : r.kind === "event" ? "bg-cyan/5 text-chalk" : "bg-ink-soft text-chalk"}`}
              >
                {readingSummary(r)}
                <span className="ml-2 text-mist">{timeAgo(r.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {alerts.length > 0 && (
        <section className="mt-10">
          <h2 className="text-xs uppercase tracking-widest text-mist">Alerts</h2>
          <ul className="mt-3 space-y-2">
            {alerts.slice(0, 12).map((r) => (
              <li key={r.id} className="rounded-lg bg-warn/5 p-3 text-xs">
                <span className="text-warn">{r.message ?? readingSummary(r)}</span>
                <span className="ml-2 text-mist">{timeAgo(r.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {events.length > 0 && (
        <section className="mt-10">
          <h2 className="text-xs uppercase tracking-widest text-mist">Events</h2>
          <ul className="mt-3 space-y-2">
            {events.slice(0, 12).map((r) => (
              <li key={r.id} className="rounded-lg bg-ink-soft p-3 text-xs text-mist">
                <span className="text-chalk">{r.state ?? r.message ?? readingSummary(r)}</span>
                <span className="ml-2">{timeAgo(r.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-10">
        <h2 className="text-xs uppercase tracking-widest text-mist">Commands</h2>
        {commands.length === 0 ? (
          <p className="mt-3 text-sm leading-relaxed text-mist">
            No command has ever been issued for this machine. A signed-in person queues one from the{" "}
            <Link href="/dashboard/machines" className="text-bug-dim underline decoration-dotted hover:text-bug">
              dashboard
            </Link>
            , and the machine collects it on its next report.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {commands.map((c) => (
              <li key={c.id} className="flex items-center gap-3 rounded-lg bg-ink-soft p-3 text-xs">
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                    c.status === "pending" || c.status === "failed"
                      ? "bg-warn/15 text-warn"
                      : c.status === "acknowledged"
                        ? "bg-lime/15 text-bug"
                        : "bg-panel-2 text-mist"
                  }`}
                >
                  {c.status}
                </span>
                <span className="min-w-0 flex-1 text-mist">
                  {c.body}
                  {c.note && <span className="mt-0.5 block text-[11px] text-mist-bright">the machine says: {c.note}</span>}
                </span>
                <span className="shrink-0 text-mist">{timeAgo(c.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10 rounded-xl border border-line bg-ink-soft p-6">
        <h2 className="text-sm font-medium text-chalk">The record, as data</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-mist">
          This machine's readings are public data like everything else here, and an agent can read them with the
          read_machines tool or the roster JSON. They are also served as a log file, because a page is not a
          container: MCAP is what a fleet operator, a failure review, or a viewer opens, with one channel per kind
          of reading and the machine's own timestamps rather than this browser's.
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-mist">
          The response carries the SHA-256 of the exact bytes it served, so a file kept today can be proved later
          against the header it arrived with. The file is written when it is asked for, so it grows as the machine
          reports.
        </p>
        <div className="mt-3 flex flex-wrap gap-3 text-sm">
          <a
            href={`/api/machines/${encodeURIComponent(machine.name)}/mcap`}
            className="rounded-md border border-line px-3 py-1.5 text-mist transition-colors hover:text-chalk"
          >
            This machine's log (.mcap)
          </a>
          <a
            href={`/api/machines/${encodeURIComponent(machine.name)}/mcap?meta=1`}
            className="rounded-md border border-line px-3 py-1.5 text-mist transition-colors hover:text-chalk"
          >
            What the file holds
          </a>
          <Link
            href={`/machines/${encodeURIComponent(machine.name)}/lifecycle`}
            className="rounded-md border border-line px-3 py-1.5 text-mist transition-colors hover:text-chalk"
          >
            The lifecycle record
          </Link>
          <a href="/api/machines" className="rounded-md border border-line px-3 py-1.5 text-mist transition-colors hover:text-chalk">
            The roster JSON
          </a>
          <Link href="/machines" className="rounded-md border border-line px-3 py-1.5 text-mist transition-colors hover:text-chalk">
            All machines
          </Link>
        </div>
      </section>
    </main>
  );
}
