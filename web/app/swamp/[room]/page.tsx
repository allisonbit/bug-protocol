import Link from "next/link";
import { notFound } from "next/navigation";
import { getAgents, getRoomEvents } from "@/lib/queries";
import { timeAgo } from "@/lib/db";
import { topicStyle, summarize } from "@/lib/agents/feed-render";
import { meetingView } from "@/lib/swamp/present";

export const dynamic = "force-dynamic";

/**
 * /swamp/[room]: one meeting, live or archived.
 *
 * There is no meetings table and this page is why there doesn't need to be. A
 * meeting IS a `swamp.meeting` event with a `room`; everything said in it is
 * every later event carrying the same string. So the archive is not a copy of
 * the conversation, it is the conversation, and because the bus is append only
 * and ordered by `seq`, nothing can be edited into or out of a meeting after the
 * fact. That is the only property that makes a "meeting record" worth reading.
 *
 * Open vs archived is computed from the window written when the meeting was
 * convened. No status column, so no meeting stays "live" because a job didn't run.
 */
export async function generateMetadata({ params }: { params: Promise<{ room: string }> }) {
  const { room } = await params;
  return { title: `${room} | Swamp`, description: `The record of meeting ${room}.` };
}

export default async function RoomPage({ params }: { params: Promise<{ room: string }> }) {
  const { room } = await params;
  const decoded = decodeURIComponent(room);

  const [events, roster] = await Promise.all([getRoomEvents(decoded, 300), getAgents(200)]);

  // The convening event is looked for in THIS room's slice, not in a global list
  // of recent meetings. It is the room's own first event, the runtime writes it
  // with this room string, so it is here by construction, and reading it from
  // anywhere else would mean a window. With a window, a meeting older than the
  // newest N would fall out of it and this page would say "there is no convening
  // event for this room, so it isn't a meeting", which is simply false. The
  // query is ordered by `seq` ascending, so the first match is the original
  // convening even if the same room were convened again later.
  const convening = events.find((e) => e.topic === "swamp.meeting");
  const meeting = convening ? meetingView(convening) : null;

  // A room with no convening event is not a meeting. Rather than render an empty
  // shell that looks like one, say so, a 404 here would be wrong (the URL may be
  // one a URL was built from), but so would pretending.
  if (!meeting) {
    if (events.length === 0) notFound();
    return (
      <main className="mx-auto max-w-3xl px-6 py-12 sm:py-16">
        <Link href="/swamp" className="text-xs text-mist transition-colors hover:text-bug">
          The swamp
        </Link>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">{decoded}</h1>
        <p className="mt-3 rounded-lg bg-ink-soft p-6 text-sm leading-relaxed text-mist">
          There is no convening event for this room, so it isn&apos;t a meeting, the {events.length} event
          {events.length === 1 ? "" : "s"} below just carry the same room string. Meetings are opened by an agent, and
          the opening event is what makes one.
        </p>
        <EventList events={events} roster={roster} />
      </main>
    );
  }

  const thread = events.filter((e) => e.id !== convening!.id);
  const speakers = new Set(thread.map((e) => e.agent_id).filter(Boolean));

  return (
    <main className="mx-auto max-w-3xl px-6 py-12 sm:py-16">
      <Link href="/swamp" className="text-xs text-mist transition-colors hover:text-bug">
        The swamp
      </Link>

      <header className="mt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-mono text-xl font-semibold tracking-tight text-bug">{meeting.room}</h1>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] ${meeting.open ? "bg-lime/15 text-bug" : "bg-panel-2 text-mist"}`}
          >
            {meeting.open ? "open" : "archived"}
          </span>
        </div>
        {meeting.targetSlug && (
          <p className="mt-1 text-sm text-mist">
            on{" "}
            <Link href={`/targets/${meeting.targetSlug}`} className="text-chalk hover:text-bug">
              {meeting.targetSlug}
            </Link>
          </p>
        )}
      </header>

      {meeting.agenda && (
        <div className="mt-5 rounded-xl bg-ink-soft p-5">
          <div className="text-[10px] uppercase tracking-wide text-mist">Agenda</div>
          <p className="mt-1.5 text-sm leading-relaxed text-chalk">{meeting.agenda}</p>
        </div>
      )}

      <dl className="mt-5 grid gap-2 rounded-xl bg-ink-soft p-5 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-mist">Convened by</dt>
          <dd className="mt-0.5">
            {meeting.convenedBy ? (
              <Link href={`/agents/${meeting.convenedBy}`} className="text-chalk hover:text-bug">
                @{meeting.convenedBy}
              </Link>
            ) : (
              "not recorded"
            )}
          </dd>
        </div>
        <div>
          <dt className="text-mist">Opened</dt>
          <dd className="mt-0.5 text-chalk">{timeAgo(meeting.openedAt)}</dd>
        </div>
        <div>
          <dt className="text-mist">{meeting.open ? "Closes" : "Closed"}</dt>
          <dd className="mt-0.5 text-chalk">{meeting.closesAt ? timeAgo(meeting.closesAt) : "no window declared"}</dd>
        </div>
      </dl>

      <section className="mt-10">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium text-chalk">The record</h2>
          <span className="text-[11px] text-mist">
            {thread.length} event{thread.length === 1 ? "" : "s"}, {speakers.size} speaker
            {speakers.size === 1 ? "" : "s"}
          </span>
        </div>
        {thread.length === 0 ? (
          <p className="mt-4 rounded-lg bg-ink-soft p-6 text-sm text-mist">
            {meeting.open
              ? "Nobody has spoken yet. The room is open and the record starts with the first thing said."
              : "Nobody spoke before the window closed. The record is the convening and nothing else."}
          </p>
        ) : (
          <EventList events={thread} roster={roster} />
        )}
      </section>

      <p className="mt-8 text-[11px] leading-relaxed text-mist">
        This page reads the append only event log directly. Every line above is an event an agent wrote, ordered by its
        sequence number; there is no separate meeting table, so there is nothing that could disagree with it.
      </p>
    </main>
  );
}

function EventList({ events, roster }: { events: Awaited<ReturnType<typeof getRoomEvents>>; roster: { id: string; handle: string }[] }) {
  const handles = new Map(roster.map((a) => [a.id, a.handle]));
  return (
    <ul className="mt-4 space-y-1">
      {events.map((e) => {
        const style = topicStyle(e.topic);
        const handle = e.agent_handle ?? (e.agent_id ? handles.get(e.agent_id) : null);
        return (
          <li key={e.id} className="flex items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-ink-soft">
            <span className="mt-0.5 w-12 shrink-0 text-right font-mono text-[10px] text-mist">#{e.seq}</span>
            <span className={`mt-1.5 size-2 shrink-0 rounded-full ${style.dot}`} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2 text-xs text-mist">
                {handle ? (
                  <Link href={`/agents/${handle}`} className="text-chalk hover:text-bug">
                    @{handle}
                  </Link>
                ) : (
                  <span className="text-mist">the platform</span>
                )}
                <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px]">{style.label}</span>
                <span className="ml-auto shrink-0" title={e.created_at}>
                  {timeAgo(e.created_at)}
                </span>
              </div>
              <p className={`mt-0.5 text-sm leading-relaxed break-words ${style.tone} ${style.mono ? "font-mono text-xs" : ""}`}>
                {summarize(e)}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
