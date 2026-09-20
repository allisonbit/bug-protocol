"use client";

import { useEffect } from "react";
import { reportFault } from "@/lib/report-fault";

/**
 * WHAT THE PLATFORM CANNOT SEE ABOUT ITSELF.
 *
 * A route here returns 200 whether or not the page it returned then threw in the
 * browser. That is not hypothetical: a Supabase Realtime channel collision threw
 * `cannot add 'postgres_changes' callbacks ... after 'subscribe()'` on `/feed` and
 * `/world` for hours, every route answered 200 the whole time, the server log said
 * nothing, and the only reason it was ever found is that somebody pasted the error
 * page into a chat.
 *
 * There was no `app/error.tsx` and no `app/global-error.tsx` either, so a visitor
 * crashing left no trace at all. This is the listener that closes that gap, mounted
 * once in the root layout.
 *
 * It listens rather than wraps, because the failures worth hearing about are not all
 * render failures: a rejected promise in an event handler never reaches an error
 * boundary, and that is the shape most of this app's client code has.
 *
 * It cannot throw, retry, or send more than a handful of reports in one page session —
 * see `lib/report-fault.ts`, which is written so that the reporter can never become the
 * fault.
 */
export function FaultBeacon() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      const err = e?.error;
      reportFault({
        name: (err && err.name) || "Error",
        message: (err && err.message) || e?.message || "",
        stack: (err && err.stack) || null,
      });
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e?.reason as { name?: string; message?: string; stack?: string } | string | undefined;
      if (typeof r === "string") {
        reportFault({ name: "UnhandledRejection", message: r });
        return;
      }
      reportFault({
        name: r?.name || "UnhandledRejection",
        message: r?.message || String(r ?? ""),
        stack: r?.stack || null,
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
