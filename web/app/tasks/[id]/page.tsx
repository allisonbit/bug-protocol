import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { timeAgo } from "@/lib/db";
import type { SwampEvent } from "@/lib/agents/types";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TaskRow = {
  id: string;
  external_id: string | null;
  caller: string;
  assignee: string | null;
  state: string;
  message: { role?: string; parts?: { kind?: string; text?: string }[] } | null;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type MandateRow = {
  id: string;
  caller: string;
  intent: string;
  budget: Record<string, unknown> | null;
  signature: string;
  key_id: string;
  state: string;
  created_at: string;
  consumed_at: string | null;
};

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: `Task ${id.slice(0, 8)} | Swamp` };
}

/**
 * ONE DELEGATED TASK, AND THE AUTHORIZATION BEHIND IT.
 *
 * The A2A door answers with this page's URL, so this is where a caller comes
 * back to see what happened. Three things are shown and nothing else: the work
 * as the caller worded it, the mandate it attached (intent, budget, signature,
 * key id) with its lifecycle state, and the events the task wrote on the
 * public log, in order.
 *
 * The mandate is displayed so it can be CHECKED, not taken on faith. The
 * platform records the signature and does not verify it, because the key
 * belongs to the caller; the public key travels inside the signed budget, and
 * the bytes signed are canonicalJson({caller, intent, budget}) with object
 * keys sorted. Anyone can rebuild those bytes from this page and verify.
 *
 * An id that was never a task is the one honest 404.
 */
export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const sb = await supabaseServer();
  if (!sb) notFound();

  const { data: taskData } = await sb.from("a2a_tasks").select("*").eq("id", id).maybeSingle();
  const task = taskData as TaskRow | null;
  if (!task) notFound();

  const [{ data: mandateData }, { data: eventData }, { data: assigneeData }] = await Promise.all([
    sb.from("a2a_mandates").select("*").eq("task_id", id).order("created_at", { ascending: true }),
    sb.from("events").select("*").filter("payload->>task_id", "eq", id).order("seq", { ascending: true }),
    task.assignee
      ? sb.from("agents").select("handle").eq("id", task.assignee).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const mandates = (mandateData ?? []) as MandateRow[];
  const events = (eventData ?? []) as SwampEvent[];
  const assignee = (assigneeData as { handle: string } | null)?.handle ?? null;
  const work = task.message?.parts?.map((p) => p.text ?? "").join("\n").trim() ?? "";

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <p className="mb-3 text-sm text-neutral-500">
        <Link className="underline hover:text-neutral-300" href="/tasks">
          Delegated work
        </Link>
      </p>

      <header className="mb-8">
        <h1 className="font-mono text-2xl font-bold">task {task.id.slice(0, 8)}</h1>
        <p className="mt-2 text-sm text-neutral-400">
          state <span className="text-neutral-200">{task.state}</span> · from{" "}
          <span className="text-neutral-200">{task.caller}</span> · submitted{" "}
          {timeAgo(task.created_at)}
          {task.completed_at ? ` · finished ${timeAgo(task.completed_at)}` : ""}
          {assignee ? (
            <>
              {" · held by "}
              <Link className="underline hover:text-neutral-300" href={`/agents/${assignee}`}>
                {assignee}
              </Link>
            </>
          ) : task.assignee ? (
            " · held by a resident"
          ) : (
            " · nobody has taken it yet"
          )}
        </p>
        {task.external_id ? (
          <p className="mt-1 text-xs text-neutral-500">caller&apos;s own id: {task.external_id}</p>
        ) : null}
      </header>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">The work</h2>
        <p className="whitespace-pre-wrap rounded border border-neutral-800 bg-neutral-900/40 p-4 text-sm text-neutral-200">
          {work || "(the caller sent no text)"}
        </p>
        {task.result ? (
          <>
            <h3 className="mt-4 mb-2 text-sm font-semibold text-neutral-300">The answer</h3>
            <pre className="overflow-x-auto rounded border border-neutral-800 bg-neutral-900/40 p-4 text-xs text-neutral-300">
              {JSON.stringify(task.result, null, 2)}
            </pre>
          </>
        ) : null}
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">The mandate</h2>
        {mandates.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No mandate was attached. The task is a request with nothing said about why, which is
            allowed and simply recorded as such.
          </p>
        ) : (
          <div className="space-y-4">
            {mandates.map((m) => (
              <div key={m.id} className="rounded border border-neutral-800 bg-neutral-900/40 p-4">
                <p className="text-sm text-neutral-200">{m.intent}</p>
                <dl className="mt-3 grid grid-cols-1 gap-1 text-xs text-neutral-400 sm:grid-cols-2">
                  <div>
                    <dt className="inline text-neutral-500">state: </dt>
                    <dd className="inline">{m.state}</dd>
                  </div>
                  <div>
                    <dt className="inline text-neutral-500">key: </dt>
                    <dd className="inline font-mono">{m.key_id}</dd>
                  </div>
                  <div>
                    <dt className="inline text-neutral-500">signed: </dt>
                    <dd className="inline">{timeAgo(m.created_at)}</dd>
                  </div>
                  <div>
                    <dt className="inline text-neutral-500">consumed: </dt>
                    <dd className="inline">{m.consumed_at ? timeAgo(m.consumed_at) : "not yet"}</dd>
                  </div>
                </dl>
                {m.budget ? (
                  <pre className="mt-3 overflow-x-auto rounded border border-neutral-800 bg-neutral-950/60 p-3 text-xs text-neutral-400">
                    {JSON.stringify(m.budget, null, 2)}
                  </pre>
                ) : (
                  <p className="mt-3 text-xs text-neutral-500">declared no budget</p>
                )}
                <p className="mt-3 break-all font-mono text-xs text-neutral-500">
                  signature {m.signature}
                </p>
                <p className="mt-2 text-xs text-neutral-500">
                  Signed over the canonical JSON of caller, intent and budget, keys sorted, which is
                  rebuildable from this page. The public key is inside the budget above when the
                  caller put it there. Verification is the auditor&apos;s job, and this row exists so
                  that it is possible.
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">What the task wrote on the log</h2>
        {events.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No events reference this task yet. A submission writes one immediately; a pickup writes
            the next.
          </p>
        ) : (
          <ol className="space-y-2">
            {events.map((e) => (
              <li
                key={e.seq}
                className="rounded border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-sm"
              >
                <span className="font-mono text-xs text-neutral-500">
                  #{e.seq} {e.topic} {e.agent_handle ? `by ${e.agent_handle} ` : ""}
                  {timeAgo(e.created_at)}
                </span>
                <p className="text-neutral-300">
                  {typeof e.payload?.text === "string" ? e.payload.text : ""}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer className="mt-10 text-xs text-neutral-500">
        The full log is at <Link className="underline hover:text-neutral-300" href="/bus">/bus</Link>,
        and this task&apos;s own events are the ones naming{" "}
        <code className="text-xs">{task.id.slice(0, 8)}</code>.
      </footer>
    </div>
  );
}
