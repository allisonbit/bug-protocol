/**
 * EVERY CALL INTO SUPABASE GETS A DEADLINE.
 *
 * On 2026-09-23 this deployment went dark for hours and nothing here had
 * failed. Supabase's EU West 1 stack stopped answering over HTTPS: Cloudflare
 * returned 522 to Vercel's functions on every PostgREST request and GoTrue
 * answered 504, while the database itself stayed reachable over the pooler.
 * Every read in `lib/queries.ts` fails soft by design, so each page should have
 * rendered its honest empty state. None did.
 *
 * The reason is that a soft failure needs the request to FAIL, and nothing in
 * the stack had a deadline. supabase-js hands the request to the platform fetch,
 * which waits, and the page waits on it, and Vercel kills the function after its
 * own limit with no response at all. A reader got an empty browser, not an empty
 * state, and a site whose one dependency was slow looked like a site that was
 * broken.
 *
 * So the client is given a fetch that gives up. What matters is that the request
 * always ends: an unbounded wait turns someone else's outage into ours, and the
 * deadline is what turns it back into an error the code already knows how to
 * render.
 *
 * EIGHT SECONDS, AND WHY NOT MORE. A serverless function has a wall of its own,
 * and on the same day production answered with `504 FUNCTION_INVOCATION_TIMEOUT`
 * — "a function needed by this page took too long to respond" — which is the
 * platform killing the render because the render was still waiting. A deadline
 * that sits on the platform's limit is not a deadline, it is a race, so this one
 * is set well inside it and the whole page is designed to spend it once: see the
 * breaker below. A healthy read on this deployment answers in a few hundred
 * milliseconds, so eight seconds costs a working page nothing, and
 * `SUPABASE_TIMEOUT_MS` moves it without a code change if some door needs more.
 *
 * The abort is logged, once per occurrence, because these reads fail soft and a
 * soft failure with no log line is indistinguishable from an empty table.
 */
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * The second half of the same fix, and the half that was missing at first.
 *
 * A deadline alone is not enough, because a page does not make one read. The
 * home page runs seven in parallel and then five more stages after them, and on
 * 2026-09-23 each stage waited the full ten seconds before giving up: the page
 * that should have failed in ten seconds took sixty-two, which is longer than
 * the function is allowed to live, so the reader still got an empty browser.
 *
 * So a timeout opens a breaker. Once one request to Supabase has been abandoned,
 * the following ones are not attempted at all for the next half minute and fail
 * immediately, which turns six stages of outage into one wait plus change. The
 * breaker is per process, so on a serverless instance it is per warm instance —
 * it is there to stop a page costing six deadlines, not to be a global health
 * record, and `/api/health` is the door that answers that question.
 */
const DEFAULT_BREAKER_MS = 30_000;

/** When the breaker closes again, or 0 when it is closed. */
let openUntil = 0;

/** One log line per opening, not one per request that finds it open. */
let announcedAt = 0;

/** Raised without a request when the breaker is open. */
export class SupabaseUnavailableError extends Error {
  constructor(openForMs: number) {
    super(`Supabase has not answered within the last ${Math.round(openForMs / 1000)}s, so this request was not attempted.`);
    this.name = "SupabaseUnavailableError";
  }
}

/** How long the breaker stays open. Clamped like the deadline, for the same reason. */
export function supabaseBreakerMs(): number {
  const raw = Number(process.env.SUPABASE_BREAKER_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_BREAKER_MS;
  return Math.min(Math.max(raw, 0), 300_000);
}

/** True while requests are being refused without being attempted. */
export function supabaseCircuitOpen(now = Date.now()): boolean {
  return now < openUntil;
}

/** Close the breaker. Exported so a test can start from a known state. */
export function resetSupabaseCircuit(): void {
  openUntil = 0;
  announcedAt = 0;
}

/** The deadline, in milliseconds, for one request to Supabase. */
export function supabaseTimeoutMs(): number {
  const raw = Number(process.env.SUPABASE_TIMEOUT_MS ?? process.env.NEXT_PUBLIC_SUPABASE_TIMEOUT_MS);
  /** A deadline of zero, or of an hour, both defeat the point, so it is clamped. */
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(raw, 1_000), 60_000);
}

/** What the caller asked for, so a log line can name the door that was waiting. */
function describe(input: RequestInfo | URL): string {
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    return path || "/";
  } catch {
    return "unknown";
  }
}

/**
 * Drop-in replacement for fetch that aborts after the deadline. A caller's own
 * signal is honoured too: whichever fires first ends the request.
 */
export const supabaseFetch: typeof fetch = async (input, init) => {
  const breakerMs = supabaseBreakerMs();
  const now = Date.now();
  if (now < openUntil) {
    /**
     * The refusal is logged once per opening rather than once per request. A
     * page folds seven reads into this path and would otherwise write seven
     * identical lines per render.
     */
    if (announcedAt !== openUntil) {
      announcedAt = openUntil;
      console.error(
        `[supabase] refusing requests for another ${Math.ceil((openUntil - now) / 1000)}s: the last one was abandoned`,
      );
    }
    throw new SupabaseUnavailableError(openUntil - now);
  }

  const ms = supabaseTimeoutMs();
  const deadline = AbortSignal.timeout(ms);
  const caller = init?.signal ?? undefined;
  const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;

  try {
    const response = await fetch(input, { ...init, signal });
    /** Something answered, so the breaker closes: a slow patch is not an outage. */
    openUntil = 0;
    return response;
  } catch (error) {
    /**
     * A caller's abort is its own business — a component unmounting should not
     * read as a database failure. Only our deadline is reported, and only our
     * deadline opens the breaker.
     */
    if (deadline.aborted && !(caller?.aborted ?? false)) {
      openUntil = Date.now() + breakerMs;
      console.error(
        `[supabase] ${describe(input)} exceeded ${ms}ms and was abandoned; requests are refused for ${Math.round(
          breakerMs / 1000,
        )}s`,
      );
    }
    throw error;
  }
};
