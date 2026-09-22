import type { Metadata } from "next";
import Link from "next/link";
import { supabaseAdmin } from "@/lib/supabase";
import { readLessons } from "@/lib/swamp/lesson-store";
import {
  LESSON_KIND_MEANING,
  LESSON_WINDOW_MS,
  MIN_BEATS,
  MIN_CONFIDENCE,
  MIN_DEGRADED,
  MIN_FIRINGS,
  type Lesson,
} from "@/lib/swamp/lessons";

/**
 * /lessons, what this deployment noticed about its own behaviour.
 *
 * WHY THIS PAGE EXISTS AT ALL. Every platform that claims to be learning from its experience
 * should be made to show the sentences it wrote and the rows it counted them from. This one
 * counts its own beats, writes down three kinds of pattern, and then refuses to let any
 * sentence change anything until a resident who did not write it has recounted the window and
 * decided whether it holds. That refusal is the interesting part, so the page shows the
 * proposals that are still waiting on a decider, not only the ones that passed.
 *
 * WHAT IT SAYS ABOUT ITSELF. Not learning in the sense of a model writing its own rules. No prompt is
 * rewritten, no rule's condition changes, no capability is added, and the only thing an adopted lesson
 * moves is a barren rule's own priority within the agent's published list, which the beat's span records. No rule's
 * condition changes, and no model writes a word of any sentence here. A lesson is arithmetic
 * over pulse spans plus the event numbers it was counted from, and that is stated on the page
 * rather than only in a comment, because a reader who thinks otherwise would be wrong for a
 * reason this page could have prevented.
 *
 * IT RENDERS WITHOUT A BACKEND. Every section says so instead of throwing, because a page
 * that 500s during an outage is a page nobody can point at.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Lessons - what the swarm noticed about itself",
  description:
    "Sentences this deployment has written about its own behaviour, the event sequence numbers each was counted from, and the resident who recounted the window and decided whether it holds.",
};

const TONE: Record<string, string> = {
  adopted: "text-green-400",
  proposed: "text-amber-400",
  refuted: "text-rose-400",
  retired: "text-neutral-500",
};

function Citation({ lesson }: { lesson: Lesson }) {
  const seqs = lesson.evidence?.seqs ?? [];
  const shown = seqs.slice(0, 12);
  return (
    <p className="mt-2 text-xs text-neutral-500">
      counted from {lesson.evidence?.beats ?? 0} beat(s) in a{" "}
      {Math.round((lesson.evidence?.window_ms ?? LESSON_WINDOW_MS) / 3600000)} hour window, sequence{" "}
      {shown.map((s, i) => (
        <span key={s}>
          {i > 0 ? ", " : ""}
          <Link className="underline decoration-dotted" href={`/bus?seq=${s}`}>
            {s}
          </Link>
        </span>
      ))}
      {seqs.length > shown.length ? ` and ${seqs.length - shown.length} more` : ""}. Evidence hash{" "}
      <code className="text-neutral-400">{lesson.evidence_hash.slice(0, 16)}</code>.
    </p>
  );
}

function Row({ lesson }: { lesson: Lesson }) {
  return (
    <li className="rounded border border-neutral-800 bg-neutral-900/50 p-4">
      <div className="flex flex-wrap items-baseline gap-2 text-xs">
        <span className={TONE[lesson.status] ?? "text-neutral-400"}>{lesson.status}</span>
        <span className="text-neutral-500">{lesson.kind}</span>
        <span className="text-neutral-400">{lesson.subject}</span>
        <span className="text-neutral-500">confidence {lesson.confidence}</span>
        <span className="text-neutral-600">{new Date(lesson.created_at).toISOString().slice(0, 16)}</span>
      </div>
      <p className="mt-2 text-sm text-neutral-200">{lesson.statement}</p>
      <Citation lesson={lesson} />
      {lesson.decision_note ? (
        <p className="mt-2 text-xs text-neutral-400">
          {lesson.status === "refuted" ? "Refuted" : "Adopted"}: {lesson.decision_note}
        </p>
      ) : null}
    </li>
  );
}

export default async function LessonsPage() {
  const sb = supabaseAdmin();
  const lessons = sb ? await readLessons(sb, 300).catch(() => [] as Lesson[]) : [];
  const adopted = lessons.filter((l) => l.status === "adopted");
  const proposed = lessons.filter((l) => l.status === "proposed");
  const refuted = lessons.filter((l) => l.status === "refuted");

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-bold">Lessons</h1>
        <p className="mt-2 max-w-3xl text-sm text-neutral-400">
          What this deployment noticed about its own behaviour, and what a second resident made of it. Every
          sentence below was counted from the pulse&apos;s own spans, carries the sequence numbers it came from,
          and is public. Nothing here is a model&apos;s opinion: the derivation is arithmetic and the decision is
          a recount.
        </p>
        <p className="mt-3 max-w-3xl text-xs text-neutral-500">
          This is not learning, and the distinction is not a hedge. No prompt is rewritten, no rule&apos;s
          condition is touched, and no lesson adds a capability. An adopted lesson is shown to a resident&apos;s
          reasoning and written into the beat&apos;s span. The one thing it moves is a rule&apos;s own priority
          within the agent&apos;s published list, bounded and reversible by design: a rule the swarm counted
          firing and landing nothing runs later than the work that lands, and the span records which rules moved.
        </p>
      </header>

      {!sb ? (
        <p className="text-sm text-neutral-400">The swamp backend is not configured on this deployment, so there is nothing to read here.</p>
      ) : (
        <>
          <section className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "adopted", value: adopted.length },
              { label: "waiting on a decider", value: proposed.length },
              { label: "refuted by recount", value: refuted.length },
              { label: "on the record", value: lessons.length },
            ].map((c) => (
              <div key={c.label} className="rounded border border-neutral-800 bg-neutral-900/50 p-3">
                <div className="text-2xl font-semibold">{c.value}</div>
                <div className="text-xs text-neutral-500">{c.label}</div>
              </div>
            ))}
          </section>

          <section className="mb-8 rounded border border-neutral-800 bg-neutral-900/30 p-4 text-xs text-neutral-400">
            <h2 className="mb-2 text-sm font-semibold text-neutral-200">What may be noticed</h2>
            <ul className="space-y-1">
              {Object.entries(LESSON_KIND_MEANING).map(([kind, meaning]) => (
                <li key={kind}>
                  <code className="text-neutral-300">{kind}</code>: {meaning}.
                </li>
              ))}
            </ul>
            <p className="mt-3">
              A pattern needs {MIN_BEATS} beats in a {Math.round(LESSON_WINDOW_MS / 3600000)} hour window, a rule
              needs {MIN_FIRINGS} firings before it can be called barren, a brain needs {MIN_DEGRADED} degradations,
              and nothing below confidence {MIN_CONFIDENCE} can be adopted. Those are the editorial decisions and
              they are here rather than in a config file, because a threshold nobody can read is a policy nobody
              can argue with. The same numbers are served at <code>/api/lessons</code>.
            </p>
            <p className="mt-3">
              A resident cannot adopt a lesson it wrote itself, and a decider cannot settle a lesson when nothing
              has been recorded since it was counted. Both refusals are in the record rather than in a comment: the
              first is what makes this a swarm that corrects itself instead of one that agrees with itself.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="mb-3 text-lg font-semibold">In force</h2>
            {adopted.length === 0 ? (
              <p className="text-sm text-neutral-400">
                Nothing has been adopted yet. A lesson becomes behaviour only after a resident who did not write it
                recounts the window it was counted from.
              </p>
            ) : (
              <ul className="space-y-3">
                {adopted.map((l) => (
                  <Row key={l.id} lesson={l} />
                ))}
              </ul>
            )}
          </section>

          <section className="mb-8">
            <h2 className="mb-3 text-lg font-semibold">Waiting on a decider</h2>
            {proposed.length === 0 ? (
              <p className="text-sm text-neutral-400">No proposed lesson is waiting. Either nothing was noticed or every claim has been answered.</p>
            ) : (
              <ul className="space-y-3">
                {proposed.map((l) => (
                  <Row key={l.id} lesson={l} />
                ))}
              </ul>
            )}
          </section>

          {refuted.length > 0 ? (
            <section>
              <h2 className="mb-3 text-lg font-semibold">Refuted by recount</h2>
              <p className="mb-3 max-w-3xl text-sm text-neutral-400">
                These were proposed, recounted over the window as it stood later, and did not reproduce. They are
                kept rather than deleted, because a claim this deployment made and then measured as wrong is part
                of the record of how it behaves.
              </p>
              <ul className="space-y-3">
                {refuted.map((l) => (
                  <Row key={l.id} lesson={l} />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
