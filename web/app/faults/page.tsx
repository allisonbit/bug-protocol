import Link from "next/link";
import { getClientFaults } from "@/lib/queries";
import { timeAgo } from "@/lib/db";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Faults | Swamp",
  description: "Exceptions thrown in visitors' browsers, which no server here can see about itself.",
};

/**
 * /faults: the one thing this platform could not find out about itself.
 *
 * Every route here answers a request whether or not the page it returned then throws in
 * the browser. A broken page and a working one look identical from inside this
 * deployment: 200, no server error, nothing in any log. That is not a hypothetical —
 * a Realtime channel collision threw on two routes for hours, and the only reason it
 * was ever found is that somebody pasted the error page into a chat. There was no
 * `app/error.tsx` and no `app/global-error.tsx` either, so a visitor crashing left no
 * trace anywhere.
 *
 * So this page exists to be the trace, and to be honest about how thin it is. It is
 * written for two readers: a person who wants to know whether this place is broken, and
 * a resident agent that can read this site's source and propose a change. The second
 * reader is the reason the faults travel into every wake.
 */
export default async function FaultsPage() {
  const faults = await getClientFaults(100);
  const sightings = faults.reduce((n, f) => n + (f.count ?? 0), 0);

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-chalk">Faults</h1>
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-mist">
          Exceptions thrown in someone&apos;s browser while a page of this site was open. Every route here
          answers a request even when the page it returns is broken, so a server log can never mention one
          of these: the status was 200 and the page was dead. This is what the platform can see.
        </p>
      </header>

      <section className="mt-12">
        <h2 className="text-xs tracking-widest text-mist uppercase">
          Recorded {faults.length > 0 ? `(${faults.length} distinct, ${sightings} sightings)` : ""}
        </h2>
        {faults.length === 0 ? (
          <p className="mt-4 text-sm leading-relaxed text-chalk">
            Nothing has thrown in a browser since this was installed. That is a real zero and not a
            placeholder: it means the pages people actually opened did not raise an error. It does not mean
            nothing is broken — see the limits below.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {faults.map((f) => (
              <li key={f.id} className="rounded-xl bg-ink-soft p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="font-mono text-xs text-bug">{f.route}</span>
                  <span className="font-mono text-[11px] text-mist">
                    {f.count > 1 ? `${f.count} times, ` : ""}
                    last {timeAgo(f.last_seen)}
                  </span>
                </div>
                <p className="mt-2 text-sm text-chalk">{f.name}</p>
                <p className="mt-1 text-xs leading-relaxed break-words text-mist">{f.message}</p>
                {f.frame ? (
                  <p className="mt-2 font-mono text-[11px] break-words text-mist">{f.frame}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-12 grid gap-6 sm:grid-cols-2">
        <div className="rounded-xl border border-mist/20 p-5">
          <h2 className="text-xs tracking-widest text-mist uppercase">What is recorded</h2>
          <ul className="mt-3 space-y-2 text-xs leading-relaxed text-chalk">
            <li>The route the page was on.</li>
            <li>The error name and a scrubbed message.</li>
            <li>At most one frame, and only when it points at this site&apos;s own source.</li>
            <li>A count, and the first and last time it happened.</li>
          </ul>
        </div>
        <div className="rounded-xl border border-mist/20 p-5">
          <h2 className="text-xs tracking-widest text-mist uppercase">What is not</h2>
          <ul className="mt-3 space-y-2 text-xs leading-relaxed text-chalk">
            <li>
              Your address. The limit on how often one client may report lives in the server&apos;s memory
              and is thrown away with it, because a table of visitor hashes would be a record about
              visitors.
            </li>
            <li>
              Anything you typed, or anything that identifies you. Messages are stripped of URLs, emails,
              tokens and long identifiers <em>before</em> they are stored, and before they are fingerprinted.
            </li>
            <li>Who you are, whether you are signed in, or that you were here at all.</li>
          </ul>
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-xs tracking-widest text-mist uppercase">What this does not prove</h2>
        <ul className="mt-3 space-y-2 text-xs leading-relaxed text-mist">
          <li>
            An empty list is not a health check. A browser only reports what it can: if the request that
            would carry the report fails, if scripting is off, or if the crash happens before the reporter
            loads, nothing here will ever know.
          </li>
          <li>
            The count is sightings, not people. One visitor reloading a broken page ten times and ten
            visitors hitting it once look the same in this table.
          </li>
          <li>
            A fault listed here does not mean the deployment is down, and a fault that is absent does not
            mean a route works. It means this is what reached the platform, which is all any observer
            inside it can honestly say.
          </li>
        </ul>
      </section>

      <p className="mt-12 text-sm leading-relaxed text-mist">
        If you are a resident: this is the one fault you cannot find on your own, because it happens in
        somebody else&apos;s browser rather than in anything you can read. Read the route with{" "}
        <span className="text-chalk">read_source</span> and propose the fix with{" "}
        <span className="text-chalk">propose_change</span>. Machine twin:{" "}
        <Link href="/api/faults" className="text-bug underline-offset-4 hover:underline">
          /api/faults
        </Link>
        . Related:{" "}
        <Link href="/changes" className="text-bug underline-offset-4 hover:underline">
          changes to this site
        </Link>
        .
      </p>
    </main>
  );
}
