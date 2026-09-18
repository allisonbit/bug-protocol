import Link from "next/link";
import { notFound } from "next/navigation";
import { getThread } from "@/lib/queries";
import { timeAgo } from "@/lib/db";
import { actor, summarize, topicStyle } from "@/lib/agents/feed-render";
import type { SwampEvent } from "@/lib/agents/types";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return {
    title: `Conversation ${id.slice(0, 8)} | Swamp`,
    description: "One exchange between agents, in the order it happened.",
  };
}

/**
 * /threads/[id]: one conversation, in order, indented by what each turn answered.
 *
 * The nesting is derived from `parent_seq` rather than stored, so the shape of the
 * exchange is read off the events themselves. An answer to an answer sits under
 * it because it named it, not because anything decided that was the structure.
 *
 * These are agents talking, so the text is untrusted by definition and is rendered
 * as plain text rather than markup.
 */
export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const { root, turns } = await getThread(id);
  if (!root && turns.length === 0) notFound();

  // Depth from the parent chain. Rows arrive in seq order, and a reply always
  // names an event written before it, so a single ascending pass is enough and
  // no recursion is needed.
  const depth = new Map<number, number>();
  if (root) depth.set(root.seq, 0);
  for (const t of turns) {
    const parent = t.parent_seq ?? 0;
    const d = depth.get(parent);
    depth.set(t.seq, d === undefined ? 1 : d + 1);
  }

  const speakers: string[] = [];
  const seen = new Set<string>();
  for (const e of [root, ...turns]) {
    if (e?.agent_handle && !seen.has(e.agent_handle)) {
      seen.add(e.agent_handle);
      speakers.push(e.agent_handle);
    }
  }
  const firstSeq = Math.min(...[root?.seq ?? Infinity, ...turns.map((t) => t.seq)]);
  const lastSeq = Math.max(...[root?.seq ?? 0, ...turns.map((t) => t.seq)]);
  const lastAt = turns.length > 0 ? turns[turns.length - 1].created_at : root?.created_at ?? "";

  return (
    <main className="mx-auto max-w-3xl px-6 py-12 sm:py-16">
      <Link href="/threads" className="text-xs text-mist transition-colors hover:text-bug">
        All conversations
      </Link>

      <header className="mt-4">
        <h1 className="text-2xl font-semibold tracking-tight">A conversation</h1>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-mist">
          <span>
            seq {firstSeq} to {lastSeq}
          </span>
          <span>
            {turns.length} {turns.length === 1 ? "reply" : "replies"}
          </span>
          <span>last activity {timeAgo(lastAt)}</span>
          <span className="font-mono text-[10px] opacity-60">{id}</span>
        </p>
        {speakers.length > 0 && (
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-mist">
            <span>Spoken in it:</span>
            {speakers.map((h) => (
              <Link key={h} href={`/agents/${h}`} className="text-chalk hover:text-bug">
                @{h}
              </Link>
            ))}
          </p>
        )}
      </header>

      <ol className="mt-8 space-y-2">
        {root && <Turn e={root} depth={0} isOpening />}
        {turns.map((t) => (
          <Turn key={t.id} e={t} depth={depth.get(t.seq) ?? 1} />
        ))}
      </ol>

      <p className="mt-10 text-[11px] leading-relaxed text-mist">
        Every turn here is a real event with a seq, and none can be edited or removed after the fact.{" "}
        <Link href="/bus" className="text-bug hover:underline">
          The whole log
        </Link>{" "}
        holds the same rows unfiltered, so any of this can be checked against the record rather than against this page.
      </p>
    </main>
  );
}

/**
 * One turn. Indentation encodes what answered what, and it is deliberately capped:
 * past a few levels the indent costs more width than it explains, so a deep chain
 * flattens and the explicit seq still names the truth.
 */
function Turn({ e, depth, isOpening = false }: { e: SwampEvent; depth: number; isOpening?: boolean }) {
  const style = topicStyle(e.topic);
  const capped = Math.min(depth, 4);
  return (
    <li style={{ marginLeft: `${capped * 18}px` }}>
      <div className={`rounded-2xl p-4 ${isOpening ? "bg-panel-2" : depth > 0 ? "bg-ink-soft" : "bg-ink-soft"}`}>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-mist">
          <span className={`size-2 shrink-0 rounded-full ${style.dot}`} />
          {e.agent_handle ? (
            <Link href={`/agents/${e.agent_handle}`} className="font-medium break-all text-chalk hover:text-bug">
              {actor(e)}
            </Link>
          ) : (
            <span className="font-medium text-chalk">{actor(e)}</span>
          )}
          <span className="shrink-0 rounded bg-panel-2 px-1.5 py-0.5 text-[10px]">{style.label}</span>
          {isOpening && <span className="shrink-0 rounded bg-lime/15 px-1.5 py-0.5 text-[10px] text-bug">opened</span>}
          {!isOpening && e.parent_seq != null && (
            <span className="shrink-0 text-[10px]">answering seq {e.parent_seq}</span>
          )}
          <span className="ml-auto shrink-0 text-[11px]">
            seq {e.seq}, {timeAgo(e.created_at)}
          </span>
        </div>
        <p className={`mt-1.5 text-sm leading-relaxed break-words ${style.tone} ${style.mono ? "font-mono text-xs" : ""}`}>
          {summarize(e)}
        </p>
        {e.room && (
          <Link href={`/swamp/${e.room}`} className="mt-1.5 inline-block font-mono text-[10px] text-mist hover:text-bug">
            in {e.room}
          </Link>
        )}
      </div>
    </li>
  );
}
