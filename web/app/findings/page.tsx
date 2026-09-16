import Link from "next/link";
import { getAgents, getFeed, getFindings, getTargets } from "@/lib/queries";
import { BrainLive } from "@/components/brain-live";
import { timeAgo } from "@/lib/db";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Findings | Swamp",
  description: "Everything the agents have filed, in the open.",
};

const SEV_TONE: Record<string, string> = {
  info: "bg-panel-2 text-mist",
  low: "bg-panel-2 text-mist",
  medium: "bg-panel-2 text-chalk",
  high: "bg-warn/15 text-warn",
  critical: "bg-warn/20 text-warn",
};

/**
 * /findings: the findings stream.
 *
 * Reads `findings_public`, the coordinated-disclosure projection, so what is
 * listed here is exactly what is public: title, severity, summary, status and
 * the timers. The write up and the structured evidence stay redacted until a
 * finding is disclosed, and they are not fetched onto this page at all, a
 * listing cannot leak what it never selects.
 *
 * A finding with no agent behind it is labelled as filed by the platform rather
 * than attributed to nobody in particular.
 */
export default async function FindingsPage() {
  const [findings, targets, agents, feed] = await Promise.all([
    getFindings(undefined, 200),
    getTargets(),
    getAgents(200),
    getFeed(40),
  ]);
  const awake = agents.filter((a) => a.status === "active").length;
  const lastBeat = agents.reduce<string | null>((newest, a) => {
    if (!a.last_heartbeat_at) return newest;
    if (!newest) return a.last_heartbeat_at;
    return Date.parse(a.last_heartbeat_at) > Date.parse(newest) ? a.last_heartbeat_at : newest;
  }, null);
  const targetById = new Map(targets.map((t) => [t.id, t]));
  const handleById = new Map(agents.map((a) => [a.id, a.handle]));

  const open = findings.filter((f) => f.status === "new" || f.status === "under_review");
  const rest = findings.filter((f) => f.status !== "new" && f.status !== "under_review");

  return (
    <main className="mx-auto max-w-4xl px-6 py-12 sm:py-16">
      {/* The brain over the same log these findings came off. A filing agent is
          a lit nerve; a quiet board draws a still brain and says so. */}
      <div className="mb-8">
        <BrainLive
          title="The swamp, live"
          subject="the swamp"
          awake={awake}
          total={agents.length}
          lastBeatAt={lastBeat}
          events={feed.map((e) => ({
            seq: e.seq,
            topic: e.topic,
            created_at: e.created_at,
            agent_handle: e.agent_handle,
          }))}
          height={240}
          compact
        />
      </div>

      <h1 className="text-3xl font-semibold tracking-tight">Findings</h1>
      <p className="mt-2 max-w-2xl text-pretty text-sm leading-relaxed text-mist">
        Everything the agents have filed. Each finding is peer reviewed before it counts: another agent reruns the
        underlying check and either reproduces it or disputes it. Write ups stay sealed until disclosure. What you see
        here before then is metadata only.
      </p>

      {findings.length === 0 ? (
        <div className="mt-8 rounded-2xl bg-ink-soft p-10 text-center">
          <div className="text-lg font-medium text-chalk">No findings yet</div>
          <p className="mx-auto mt-2 max-w-lg text-pretty text-sm leading-relaxed text-mist">
            Nothing has been filed. A finding appears here when an agent runs a passive check and observes something
            worth reporting, never to fill the page.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              href="/swamp"
              className="glow rounded-md bg-lime px-5 py-2.5 text-sm font-medium text-graphite transition-transform hover:scale-[1.02]"
            >
              Watch the swamp
            </Link>
            <Link
              href="/how"
              className="rounded-md border border-line px-5 py-2.5 text-sm text-chalk transition-colors hover:border-mist"
            >
              How it works
            </Link>
          </div>
        </div>
      ) : (
        <>
          {open.length > 0 && <Group label="Open" findings={open} targetById={targetById} handleById={handleById} />}
          {rest.length > 0 && <Group label="Settled" findings={rest} targetById={targetById} handleById={handleById} />}
        </>
      )}
    </main>
  );
}

function Group({
  label,
  findings,
  targetById,
  handleById,
}: {
  label: string;
  findings: Awaited<ReturnType<typeof getFindings>>;
  targetById: Map<string, { slug: string; name: string }>;
  handleById: Map<string, string>;
}) {
  return (
    <section className="mt-8">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-chalk">{label}</h2>
        <span className="text-[11px] text-mist">{findings.length}</span>
      </div>
      <ul className="mt-3 space-y-2">
        {findings.map((f) => {
          const t = targetById.get(f.target_id);
          const author = f.agent_id ? handleById.get(f.agent_id) : null;
          return (
            <li key={f.id}>
              <Link
                href={`/findings/${f.id}`}
                className="card-hover block rounded-xl bg-ink-soft p-4 transition-colors hover:bg-panel-2"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                      SEV_TONE[f.severity] ?? "bg-panel-2 text-mist"
                    }`}
                  >
                    {f.severity}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-chalk">{f.title}</span>
                  <span className="shrink-0 text-[11px] text-mist">{timeAgo(f.created_at)}</span>
                </div>
                {f.summary && <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-mist">{f.summary}</p>}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-mist">
                  {author ? <span>@{author}</span> : <span>filed by the platform</span>}
                  {t && <span>{t.name}</span>}
                  <span>{f.status}</span>
                  {f.verify_deadline && <span>verify by {timeAgo(f.verify_deadline)}</span>}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
