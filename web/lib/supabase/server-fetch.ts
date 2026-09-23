import "server-only";
import { supabaseCircuitOpen, supabaseFetch, supabaseTimeoutMs, SupabaseUnavailableError } from "./deadline";
import { pgConfigured, pgRequest, type FallbackRequest } from "./pg-rest";

/**
 * THE SERVER'S WAY TO REACH SUPABASE, WHEN THE REST API WILL NOT CARRY IT.
 *
 * Order is the point of this file. The official path is tried first, always,
 * because that is the path with row level security and the path Supabase
 * maintains. This is a fallback, not a replacement, and it is reached only after
 * a request has already failed.
 *
 * Then the same request goes to the database over the pooler, for whatever is
 * left of the caller's budget. That detail matters more than it looks: the
 * fallback shares one deadline with the attempt that just failed, so a page can
 * never take longer because a fallback existed. The first attempt is therefore
 * capped below the deadline whenever a fallback is configured, because a
 * fallback with no time left is not a fallback. If the budget does run out
 * anyway, this returns null and leaves the original honest failure in place.
 *
 * And the breaker is reused rather than reinvented. Once the REST API has been
 * abandoned, the next half minute goes straight to the pooler instead of
 * spending another deadline to learn the same thing. The moment the REST API
 * answers again it takes over, because the breaker closes on the first success,
 * and nothing has to be switched back by hand.
 */

/** The pieces of a fetch request the translation needs. */
function fallbackRequest(input: RequestInfo | URL, init: RequestInit | undefined, budgetMs: number): FallbackRequest | null {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    /** Only the data API is translated. Auth has its own service and its own keys. */
    if (!raw.includes("/rest/v1/")) return null;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const body = typeof init?.body === "string" ? init.body : null;
    return { url: raw, method, headers, body, budgetMs };
  } catch {
    return null;
  }
}

/** One line per outage rather than one per request that notices it. */
let announced = false;

async function serveFromPooler(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  startedAt: number,
  why: string,
): Promise<Response | null> {
  if (!pgConfigured()) return null;
  const request = fallbackRequest(input, init, supabaseTimeoutMs() - (Date.now() - startedAt));
  if (!request) return null;
  const response = await pgRequest(request);
  if (response && !announced) {
    announced = true;
    const path = request.url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    console.log(`[supabase] ${why}; ${path} was served from the pooler instead`);
  }
  return response;
}

/**
 * How long the official path is given before the pooler takes over.
 *
 * This is the number that makes the fallback reachable at all, and it was
 * learned the hard way: with the full eight second deadline spent on the REST
 * attempt, the first request of every window had nothing left to fall back with,
 * so it failed, and the pages it fed stayed empty even though the database was
 * answering in two hundred milliseconds. The two attempts share one budget, so
 * the first one has to leave room for the second.
 */
const PRIMARY_BUDGET_MS = Number(process.env.SUPABASE_PRIMARY_BUDGET_MS || 3_000);

/**
 * THE PART THAT MAKES THE FALLBACK USEFUL RATHER THAN MERELY PRESENT.
 *
 * With the official path tried first on every single request, each read spent
 * three seconds learning again that the REST API was down and then had only five
 * of its eight seconds left for the pooler. Measured on this project: of a whole
 * page render, two reads were served and the rest were abandoned. The fallback was
 * working and the page was still empty.
 *
 * So a failed attempt now opens a window, and inside that window reads go straight
 * to the pooler with their entire budget. The window closes on its own, which is
 * what keeps this from being a permanent choice: after it lapses, the next read
 * tries the official path first again, and one success keeps it there. The cost is
 * bounded by the window, and the honest reason for it is that the fallback needs
 * the time more than the attempt does while the attempt is known to be failing.
 */
let preferPoolerUntil = 0;
const PREFER_MS = Number(process.env.SUPABASE_POOLER_PREFER_MS || 60_000);

export const supabaseServerFetch: typeof fetch = async (input, init) => {
  const startedAt = Date.now();
  const callerSignal = init?.signal ?? undefined;

  const cooling = supabaseCircuitOpen();
  if (pgConfigured() && (cooling || Date.now() < preferPoolerUntil)) {
    const viaPooler = await serveFromPooler(input, init, startedAt, "the REST API is being skipped while it is down");
    if (viaPooler) return viaPooler;
    /**
     * The pooler could not carry it either. With no fallback left and the official
     * path in its cool-down, the honest answer is the original failure, not a second
     * attempt at the path that just refused.
     */
    if (cooling) throw new SupabaseUnavailableError(supabaseTimeoutMs());
  }

  /**
   * Only a deployment that has somewhere to fall back to cuts the first attempt
   * short. Without a pooler configured there is nothing to leave room for, so
   * the request gets the whole deadline it always had.
   */
  const primarySignal = pgConfigured()
    ? AbortSignal.any([...(callerSignal ? [callerSignal] : []), AbortSignal.timeout(PRIMARY_BUDGET_MS)])
    : callerSignal;

  try {
    const response = await supabaseFetch(input, primarySignal === callerSignal ? init : { ...init, signal: primarySignal });
    announced = false;
    /** A working REST API closes the window immediately. */
    preferPoolerUntil = 0;
    return response;
  } catch (error) {
    /**
     * The caller's own signal is not our business, and neither is a request the
     * caller cancelled: that path has no response to give and never had one.
     */
    if (callerSignal?.aborted) throw error;
    if (pgConfigured()) preferPoolerUntil = Date.now() + PREFER_MS;
    const viaPooler = await serveFromPooler(
      input,
      init,
      startedAt,
      pgConfigured() ? "the REST API did not answer in time" : "the REST API did not answer",
    );
    if (viaPooler) return viaPooler;
    throw error;
  }
};
