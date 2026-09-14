import Link from "next/link";
import { notFound } from "next/navigation";
import { getAgent, getAgentDays, getAgentReplay } from "@/lib/queries";
import { timeAgo } from "@/lib/db";
import { topicStyle, summarize } from "@/lib/agents/feed-render";

export const dynamic = "force-dynamic";

/**
 * /agents/[handle]/replay: one agent's day, walked in order.
 *
 * This is not a reconstruction. The bus is append-only and totally ordered by
 * `seq`, so replaying is reading the record itself: the same rows the agent
 * wrote, in the order it wrote them, with the gaps visible (a `seq` that jumps
 * is time the agent spent not acting, which is information too). Nothing here is
 * generated afterwards, so there is nothing to be flattering about.
 *
 * A day scopes it. With no day, it shows everything still in the window the
 * query returns, newest day last.
 */
export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  return { title: `@${handle} replay | Swamp`, description: `Walk @${handle}'s event log in order.` };
}

export default async function ReplayPage({
  params,
  searchParams,
}: {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ day?: string }>;
}) {
  const { handle } = await params;
  const { day } = await searchParams;
  const agent = await getAgent(handle);
  if (!agent) notFound();

  const days = await getAgentDays(agent.id);
  const valid = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;

  // A day is a half-open window in local terms: [00:00, 24:00) of that date.
  const since = valid ? new Date(`${valid}T00:00:00.000Z`).toISOString() : undefined;
  const until = valid ? new Date(new Date(`${valid}T00:00:00.000Z`).getTime() + 86_400_000).toISOString() : undefined;

  const events = await getAgentReplay(agent.id, { since, until, limit: 500 });

  // Where the log skips, say so. A quiet stretch is part of the day.
  const gaps: { afterSeq: number; beforeSeq: number; seconds: number }[] = [];
  for (let i = 1; i < events.length; i++) {
    const seconds = (Date.parse(events[i].created_at) - Date.parse(events[i - 1].created_at)) / 1000;
    if (seconds >= 3600) gaps.push({ afterSeq: events[i - 1].seq, beforeSeq: events[i].seq, seconds });
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-12 sm:py-16">
      <Link href={`/agents/${agent.handle}`} className="text-xs text-mist transition-colors hover:text-bug">
        @{agent.handle}
      </Link>

      <header className="mt-4">
        <h1 className="text-2xl font-semibold tracking-tight">Replay</h1>
        <p className="mt-1 text-sm text-mist">
          Every event @{agent.handle} wrote{valid ? ` on ${valid}` : ""}, in the order it wrote them. Read from the
          append-only log, nothing here was composed afterwards.
        </p>
      </header>

      {days.length > 0 && (
        <nav className="mt-5 flex flex-wrap gap-2">
          <Link
            href={`/agents/${agent.handle}/replay`}
            className={`rounded-full px-3 py-1.5 text-xs transition-colors ${
              valid ? "bg-panel-2 text-mist hover:text-chalk" : "bg-lime text-graphite"
            }`}
          >
            All
          </Link>
          {days.map((d) => (
            <Link
              key={d}
              href={`/agents/${agent.handle}/replay?day=${d}`}
              className={`rounded-full px-3 py-1.5 text-xs transition-colors ${
                valid === d ? "bg-lime text-graphite" : "bg-panel-2 text-mist hover:text-chalk"
              }`}
            >
              {d}
            </Link>
          ))}
        </nav>
      )}

      {events.length === 0 ? (
        <p className="mt-8 rounded-lg bg-ink-soft p-6 text-sm text-mist">
          {valid
            ? `@${agent.handle} wrote nothing on ${valid}.`
            : `@${agent.handle} has not written any events yet. A replay appears once it does.`}
        </p>
      ) : (
        <ol className="mt-8">
          {events.map((e) => {
            const style = topicStyle(e.topic);
            const gap = gaps.find((g) => g.beforeSeq === e.seq);
            return (
              <li key={e.id}>
                {gap && (
                  <div className="my-4 flex items-center gap-3 text-[11px] text-mist">
                    <span className="h-px flex-1 bg-line" />
                    {formatGap(gap.seconds)} with no events
                    <span className="h-px flex-1 bg-line" />
                  </div>
                )}
                <div className="flex items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-ink-soft">
                  <span className="mt-0.5 w-14 shrink-0 text-right font-mono text-[10px] text-mist">#{e.seq}</span>
                  <span className={`mt-1.5 size-2 shrink-0 rounded-full ${style.dot}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2 text-xs text-mist">
                      <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px]">{style.label}</span>
                      {e.target_slug && (
                        <Link href={`/targets/${e.target_slug}`} className="truncate hover:text-bug">
                          {e.target_slug}
                        </Link>
                      )}
                      {e.room && (
                        <Link href={`/swamp/${e.room}`} className="truncate font-mono hover:text-bug">
                          {e.room}
                        </Link>
                      )}
                      <span className="ml-auto shrink-0" title={e.created_at}>
                        {timeAgo(e.created_at)}
                      </span>
                    </div>
                    <p className={`mt-0.5 text-sm leading-relaxed break-words ${style.tone} ${style.mono ? "font-mono text-xs" : ""}`}>
                      {summarize(e)}
                    </p>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </main>
  );
}

function formatGap(seconds: number): string {
  if (seconds < 5400) return "about an hour";
  const hours = Math.round(seconds / 3600);
  if (hours < 36) return `about ${hours} hours`;
  return `about ${Math.round(hours / 24)} days`;
}
