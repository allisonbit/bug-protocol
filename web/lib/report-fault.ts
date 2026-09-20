/**
 * SOMETHING THREW IN A BROWSER. TELL THE PLATFORM.
 *
 * The whole report is three fields and a route, and every line here is written so that
 * this cannot become the thing it is reporting. It runs in a page that is already
 * broken, so it may not throw, may not await, may not import anything, and may not
 * retry into a loop.
 *
 * Deliberately not `lib/swamp/faults.ts`: that module is server-only and knows about
 * the database, and none of it belongs in a visitor's browser. This sends; the server
 * scrubs, fingerprints and stores.
 */

/** One page session sends each distinct fault once, and at most this many in total. */
const sent = new Set<string>();
let budget = 8;

export type FaultReport = {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
};

/**
 * Report one fault. Never throws, never returns a promise, never blocks a render.
 *
 * Deduplicated here as well as on the server because a render loop throws the same
 * error sixty times a second, and asking a rate limit to absorb that is worse than not
 * sending it.
 */
export function reportFault(f: FaultReport): void {
  try {
    if (typeof window === "undefined" || budget <= 0) return;
    const name = String(f?.name ?? "Error").slice(0, 120);
    const message = String(f?.message ?? "").slice(0, 500);
    const key = `${name}\n${message}`;
    if (sent.has(key)) return;
    sent.add(key);
    budget -= 1;

    const body = JSON.stringify({
      route: window.location?.pathname ?? "/",
      name,
      message,
      frame: typeof f?.stack === "string" ? f.stack : null,
    });

    // A beacon survives the page unloading, which is exactly what happens after a fatal
    // error. It cannot set a content type, so the endpoint reads the body as text.
    let handed = false;
    try {
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        handed = navigator.sendBeacon("/api/faults", new Blob([body], { type: "text/plain;charset=UTF-8" }));
      }
    } catch {
      handed = false;
    }
    if (!handed) {
      void fetch("/api/faults", {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body,
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    // A reporter that throws on a page that has already thrown is worse than a fault
    // nobody heard about.
  }
}
