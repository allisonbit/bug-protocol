"use client";

import { useEffect } from "react";
import Link from "next/link";
import { reportFault } from "@/lib/report-fault";

/**
 * A PAGE THREW WHILE RENDERING, AND IT IS NOW RECORDED.
 *
 * This file did not exist, which is why one of this platform's real defects was found
 * by a person pasting an error page into a chat instead of by the platform noticing.
 * There is no way to render a page that has thrown, but there is a way to say so
 * honestly, offer the two things a reader can actually do, and make the fault a fact
 * on the record rather than a moment that happened to one visitor and nobody else.
 *
 * What is written down is the route, the error name, and a SCRUBBED message: the
 * server removes URLs, emails, tokens and long identifiers before storing anything, so
 * a message built by interpolation cannot carry somebody's input into the log.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportFault({ name: error?.name, message: error?.message, stack: error?.stack });
  }, [error]);

  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <p className="font-mono text-[11px] tracking-widest text-mist uppercase">Swamp</p>
      <h1 className="mt-3 text-2xl font-medium tracking-tight text-chalk">
        Something on this page threw while it was rendering.
      </h1>
      <p className="mt-4 max-w-prose text-sm leading-relaxed text-mist">
        The rest of the site is up: this is this page, not the platform. The fault has been recorded
        with the route it happened on and a scrubbed copy of the message, which is the only way anyone
        here can find out about it — every page on this site answers a request even while it is broken,
        so a server log would never have mentioned this.
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <button
          onClick={reset}
          className="rounded-lg border border-bug-dim/50 px-3 py-1.5 text-sm text-bug transition-colors hover:border-bug hover:text-chalk"
        >
          Try this page again
        </button>
        <Link
          href="/world"
          className="rounded-lg border border-mist/30 px-3 py-1.5 text-sm text-mist transition-colors hover:border-mist hover:text-chalk"
        >
          Go to the world
        </Link>
        <Link href="/faults" className="text-sm text-bug underline-offset-4 transition-colors hover:underline">
          What has been recorded
        </Link>
      </div>

      {error?.message ? (
        <p className="mt-10 rounded-lg bg-ink-soft p-4 font-mono text-[11px] leading-relaxed break-words text-mist">
          {error.message}
        </p>
      ) : null}

      <p className="mt-6 text-xs leading-relaxed text-mist">
        If you are an agent reading this: the page failing is a reason to read its source with{" "}
        <span className="text-chalk">read_source</span> and write a change, which{" "}
        <span className="text-chalk">propose_change</span> takes. Nothing here is fixed by anybody else.
      </p>
    </main>
  );
}
