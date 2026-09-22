import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appendSystemEvent } from "@/lib/agents/ingest";
import {
  MAX_PAGE,
  catalogueUrl,
  projectCataloguePage,
  retryAfterMs,
  type CatalogueSort,
  type RegistryRow,
} from "./clawhub";

/**
 * THE SWEEP OF SOMEBODY ELSE'S REGISTRY, IN BOUNDED PASSES.
 *
 * WHY THIS IS NOT ONE REQUEST. Measured against the live registry, a page of 200 skills
 * takes about ten seconds to answer. A corpus in the tens of thousands is therefore
 * roughly a hundred and fifty pages and about half an hour of wall time, which no server
 * function will survive and no host should be asked to serve in one burst. So the sweep is
 * a cursor in a row, advanced a few pages per pass, and every pass is a complete small
 * job: fetch, project, write, move the cursor, say what happened.
 *
 * TWO MODES, AND THE SECOND ONE IS WHY THIS IS AFFORDABLE FOREVER.
 *
 *   - `sweep` walks the whole catalogue once from the newest skill backwards, because the
 *     default sort here (`createdAt`) is stable and descending. It is resumed until the
 *     cursor runs out, and that first complete walk is what makes the mirror a mirror.
 *   - `refresh` is every pass afterwards, and it costs one page in the ordinary case. The
 *     registry sorts newest first, so a new skill appears at the front; a page whose every
 *     row is already older than the newest row the mirror holds contains nothing new, and
 *     the pass stops there. Only when something has actually been published does a pass
 *     walk further.
 *
 * A full re-walk is available and deliberately not automatic: `force` drops the cursor and
 * starts the walk again, which is what catches a skill that was edited or delisted since
 * the last walk. The reset happens on the first pass of the new walk only — see
 * `sweepPlan` below for why that distinction is load-bearing. Running a re-walk on a timer
 * would put half an hour of somebody else's load on a schedule for a benefit nobody asked
 * for.
 *
 * WHAT IT NEVER DOES. It never reads a skill's instructions. The catalogue endpoint
 * carries metadata, and metadata is all this writes. The bytes are fetched by the auditor
 * and only by the auditor, whose verdict is bound to their digest.
 *
 * AND IT HONOURS BEING TOLD TO STOP. A 429 is not an error to retry through: the delay the
 * registry asks for is recorded and the pass ends, so a deployment that has been throttled
 * waits rather than hammering a host it depends on.
 */

/** One row, one sweep. See the migration for why this is a table and not a shared note. */
export const REGISTRY_STATE_ID = "crawl";

/** Pages per pass. Three is about thirty seconds of registry time plus the writes. */
const DEFAULT_PAGES = 3;

/**
 * The wall-clock budget for one pass.
 *
 * Below the route's own limit on purpose: a pass that is killed mid-flight loses the work
 * it had not written and cannot say what it did, so it stops itself first and reports.
 */
const DEFAULT_BUDGET_MS = 45_000;

/** Identifies this deployment to a host it is reading. */
const USER_AGENT = "swampai-registry/1 (+https://www.swampai.world/skills/registry)";

export type RegistryState = {
  id: string;
  sort: string;
  cursor: string | null;
  pages_seen: number;
  skills_seen: number;
  sweeps: number;
  complete: boolean;
  newest_created_at: string | null;
  started_at: string;
  last_run_at: string | null;
  last_error: string | null;
  updated_at: string;
};

/**
 * The crawl's own state, or `null` when the row does not exist yet.
 *
 * WHY THIS REFUSES RATHER THAN SEEDING. This was a write on a read path, and the failure
 * mode was silent and expensive: a transient read error and a genuinely absent row both
 * arrive as "no data", so one flaky request would upsert a seed with `cursor: null` and
 * restart a half-hour walk of the catalogue from the top, while the mirror kept the rows it
 * had already collected and nothing said the cursor had moved backwards. A second opinion
 * on the same read is cheap; guessing is not, so an error is retried once and then raised.
 *
 * Creating the row belongs to the writer. `crawlRegistry` calls `ensureRegistryState`
 * below, which is the only place a seed is written and the only place allowed to be.
 */
export async function readRegistryState(sb: SupabaseClient): Promise<RegistryState | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data, error } = await sb.from("skill_registry_state").select("*").eq("id", REGISTRY_STATE_ID).maybeSingle();
    if (data) return data as RegistryState;
    // A missing row is not an error in PostgREST; it is `data: null, error: null`. An
    // absent row is answered with null below, and a failed read is raised so a caller can
    // tell the two apart rather than being handed a fabricated zero state.
    if (!error) return null;
    if (attempt === 1) {
      throw new Error(`the crawl state could not be read: ${error.message}`);
    }
  }
  return null;
}

/** The seed a writer may write: a fresh deployment starts a first walk and nothing else. */
function seedState(): RegistryState {
  const now = new Date().toISOString();
  return {
    id: REGISTRY_STATE_ID,
    sort: "createdAt",
    cursor: null,
    pages_seen: 0,
    skills_seen: 0,
    sweeps: 0,
    complete: false,
    newest_created_at: null,
    started_at: now,
    last_run_at: null,
    last_error: null,
    updated_at: now,
  };
}

/**
 * The state a pass should act on, seeding the row if this deployment has never walked.
 *
 * The upsert is `ignoreDuplicates`, so two passes starting at the same moment do not race
 * each other into a half-written state: the first writer wins and the second reads it back.
 * This is on the write path, reached only from `crawlRegistry`.
 */
export async function ensureRegistryState(sb: SupabaseClient): Promise<RegistryState> {
  const existing = await readRegistryState(sb);
  if (existing) return existing;
  const seed = seedState();
  await sb.from("skill_registry_state").upsert(
    { id: seed.id, sort: seed.sort, cursor: seed.cursor, complete: seed.complete },
    { onConflict: "id", ignoreDuplicates: true },
  );
  return (await readRegistryState(sb)) ?? seed;
}

type PageResult =
  | { ok: true; payload: unknown }
  | { ok: false; code: "THROTTLED" | "UNREACHABLE" | "BAD_STATUS"; reason: string; waitMs: number | null };

/** One page of the catalogue, or a stated refusal with the wait the registry asked for. */
async function fetchPage(url: string): Promise<PageResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      // No cache: the cursor is the cache, and a stale page would be written as current.
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return { ok: false, code: "UNREACHABLE", reason: e instanceof Error ? e.message : "the request failed", waitMs: null };
  }

  if (res.status === 429) {
    return {
      ok: false,
      code: "THROTTLED",
      reason: "the registry asked this deployment to slow down",
      waitMs: retryAfterMs(res.headers),
    };
  }
  if (!res.ok) {
    return { ok: false, code: "BAD_STATUS", reason: `the registry answered ${res.status}`, waitMs: null };
  }
  try {
    return { ok: true, payload: await res.json() };
  } catch (e) {
    return { ok: false, code: "BAD_STATUS", reason: `the registry answered with something that is not JSON: ${e instanceof Error ? e.message : "unparseable"}`, waitMs: null };
  }
}

/** The newest of a set of registry timestamps, or null when the page carried none. */
function newestOf(rows: RegistryRow[]): string | null {
  let newest: string | null = null;
  for (const r of rows) {
    if (r.registry_created_at && (!newest || r.registry_created_at > newest)) newest = r.registry_created_at;
  }
  return newest;
}

/**
 * WHAT A PASS SHOULD DO, DECIDED FROM THE STORED STATE AND WHAT THE CALLER ASKED FOR.
 *
 * The subtlety this exists for: `force` asks for a fresh walk of the whole catalogue, and a
 * walk of this catalogue takes dozens of passes. Resetting the cursor on every pass would
 * make each pass re-fetch the same first few pages forever — the mirror would stop growing
 * while every pass cheerfully reported rows written, because those rows exist and are
 * updated rather than inserted. So a forced walk resets the cursor exactly once, on the
 * pass that is not already walking, and every pass after it continues where it left off.
 *
 *   stored complete + force   -> start a new walk: cursor dropped, this is pass one
 *   stored complete, no force -> `refresh`: one page, stop as soon as it holds nothing new
 *   stored incomplete         -> continue the walk that is already in progress
 *
 * Pure and exported so the verifier can walk every branch without a database, a network
 * or a registry: the three lines above are the whole rule and it is worth holding them.
 */
export function sweepPlan(
  state: { complete: boolean; cursor: string | null },
  options: { force?: boolean } = {},
): { mode: "sweep" | "refresh"; restart: boolean; cursor: string | null } {
  const restart = Boolean(options.force) && state.complete;
  const mode: "sweep" | "refresh" = state.complete && !restart ? "refresh" : "sweep";
  return { mode, restart, cursor: mode === "refresh" || restart ? null : state.cursor };
}

export type CrawlOutcome = {
  ok: boolean;
  mode: "sweep" | "refresh";
  pages: number;
  written: number;
  refused: number;
  complete: boolean;
  caughtUp: boolean;
  /** How many skills the mirror holds, or null when this pass could not count them. */
  mirrored: number | null;
  topics: number;
  cursor: string | null;
  throttled: boolean;
  waitMs: number | null;
  note: string;
};

/**
 * Advance the sweep by up to `pages` pages, or stop early on a budget, a throttle or the
 * end of the catalogue. Everything it did is written before it returns, so a pass that is
 * interrupted loses at most the page it was in the middle of.
 */
export async function crawlRegistry(
  sb: SupabaseClient,
  options: { pages?: number; budgetMs?: number; sort?: CatalogueSort; force?: boolean } = {},
): Promise<CrawlOutcome> {
  const maxPages = Math.min(Math.max(Math.floor(options.pages ?? DEFAULT_PAGES), 1), 40);
  const budgetMs = Math.min(Math.max(options.budgetMs ?? DEFAULT_BUDGET_MS, 5_000), 300_000);
  const started = Date.now();

  const state = await ensureRegistryState(sb);
  const sort: CatalogueSort = options.sort ?? ((state.sort as CatalogueSort) || "createdAt");
  // See sweepPlan above: a forced sweep restarts the cursor once, not on every pass.
  const plan = sweepPlan(state, { force: options.force });
  const mode = plan.mode;
  let cursor = plan.cursor;

  let pages = 0;
  let written = 0;
  let refused = 0;
  let seen = 0;
  let complete = state.complete && mode === "refresh";
  let caughtUp = false;
  let newestSeen: string | null = state.newest_created_at;
  let throttled = false;
  let waitMs: number | null = null;
  let failure: string | null = null;

  while (pages < maxPages) {
    if (Date.now() - started > budgetMs) break;

    const result = await fetchPage(catalogueUrl({ sort, limit: MAX_PAGE, cursor }));
    if (!result.ok) {
      if (result.code === "THROTTLED") {
        throttled = true;
        waitMs = result.waitMs;
      }
      failure = `${result.code}: ${result.reason}${result.waitMs !== null ? ` (wait ${Math.round(result.waitMs / 1000)}s)` : ""}`;
      break;
    }

    const page = projectCataloguePage(result.payload);
    pages += 1;
    seen += page.rows.length;
    refused += page.refused;

    if (page.rows.length === 0) {
      // An empty page is the end of the catalogue, and it is also how a refresh ends when
      // the registry has published nothing at all since the last walk.
      if (page.nextCursor === null) complete = true;
      break;
    }

    const { data: writtenCount, error } = await sb.rpc("upsert_skill_registry", { rows: page.rows });
    if (error) {
      // The page is not written and the cursor does not move, so the same page is retried
      // on the next pass rather than skipped. Skipping would leave a hole in the mirror
      // that nothing would ever notice.
      failure = `the page could not be written: ${error.message}`;
      break;
    }
    written += typeof writtenCount === "number" ? writtenCount : page.rows.length;

    const newest = newestOf(page.rows);
    if (newest && (!newestSeen || newest > newestSeen)) newestSeen = newest;

    if (mode === "refresh") {
      // Caught up: everything on this page was already held, so nothing after it can be
      // new either. This is the branch that makes an ordinary pass cost one page.
      if (!newest || (state.newest_created_at && newest <= state.newest_created_at)) {
        caughtUp = true;
        break;
      }
    } else if (page.nextCursor === null) {
      complete = true;
      break;
    }

    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }

  // The rollup is only rebuilt when the mirror changed. It is a full rebuild from the
  // table, so running it for nothing would be the one cost in this pass that buys nothing.
  let topics = 0;
  if (written > 0) {
    const { data: topicCount, error: topicError } = await sb.rpc("refresh_registry_topics");
    if (topicError) failure = failure ?? `the topic rollup could not be rebuilt: ${topicError.message}`;
    else if (typeof topicCount === "number") topics = topicCount;
  }

  // NULL IS NOT ZERO. A count that did not come back is a read this pass could not make,
  // and reporting it as 0 would say the mirror is empty when it holds thousands of rows.
  // A live pass did exactly that: one aborted page fetch was followed by a run of Supabase
  // reads that answered nothing, and the pass cheerfully reported `mirrored: 0`. Zero is a
  // claim about the corpus; null is an admission, and a caller can tell them apart.
  const { count, error: countError } = await sb.from("skill_registry").select("id", { count: "exact", head: true });
  const mirrored = typeof count === "number" ? count : null;
  if (countError || mirrored === null) {
    failure = failure ?? `the mirror could not be counted: ${countError?.message ?? "the count did not come back"}`;
  }

  const justCompleted = complete && !state.complete && mode === "sweep";

  await sb
    .from("skill_registry_state")
    .update({
      sort,
      cursor: complete && mode === "sweep" ? null : cursor,
      pages_seen: (state.pages_seen ?? 0) + pages,
      skills_seen: (state.skills_seen ?? 0) + seen,
      sweeps: (state.sweeps ?? 0) + (justCompleted ? 1 : 0),
      complete: complete && mode === "sweep" ? true : mode === "refresh" ? state.complete : false,
      newest_created_at: newestSeen,
      last_run_at: new Date().toISOString(),
      last_error: failure,
      updated_at: new Date().toISOString(),
    })
    .eq("id", REGISTRY_STATE_ID);

  // The milestone, and the only row this pass puts on the bus. A page fetched is progress
  // rather than news, and a bus full of progress reports is the flood this platform exists
  // not to be. A first complete walk of somebody else's whole registry is news.
  if (justCompleted) {
    await appendSystemEvent(sb, {
      topic: "registry.mirrored",
      payload: {
        text: `mirrored the ClawHub registry: ${mirrored} published skills across ${(state.pages_seen ?? 0) + pages} page(s)`,
        skills: mirrored ?? 0,
        pages: (state.pages_seen ?? 0) + pages,
        sort,
      },
    });
  }

  const note = failure
    ? `stopped at ${pages} page(s): ${failure}`
    : caughtUp
      ? "caught up: nothing published since the last walk"
      : complete && mode === "sweep"
        ? `swept the whole catalogue: ${mirrored === null ? "the mirror could not be counted" : `${mirrored} skills mirrored`}`
        : `${pages} page(s), ${written} row(s) written`;

  return {
    ok: failure === null,
    mode,
    pages,
    written,
    refused,
    complete: complete && mode === "sweep" ? true : state.complete,
    caughtUp,
    mirrored,
    topics,
    cursor,
    throttled,
    waitMs,
    note,
  };
}
