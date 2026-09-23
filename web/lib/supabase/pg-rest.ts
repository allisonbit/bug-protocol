import "server-only";
import { Pool, types, type QueryResult } from "pg";

/**
 * THE SAME REQUESTS, OVER THE OTHER SOCKET.
 *
 * On 2026-09-23 this project's REST API answered PGRST002 for hours while the
 * database behind it was perfectly healthy. PostgREST held connections that the
 * server counted as idle, and no query written into them ever returned, so every
 * page on this site rendered empty states over data that was sitting right there.
 * The database was reachable the whole time over the pooler on port 6543.
 *
 * This module is what closes that gap. It does not replace the Supabase client.
 * It sits behind it, is only reached after a request has already failed, and
 * speaks the only dialect it has to: the URL that the client already built.
 *
 * WHY THAT IS THE RIGHT LAYER. supabase-js turns a builder chain into one HTTP
 * request, and that request carries the whole query: the table, the columns, the
 * filters, the ordering, the limit, and the method with its body. So the
 * fallback does not need to understand the app's 600 select calls, or the
 * builder, or which helper wrote them. It needs to understand PostgREST, which
 * is a small, documented URL grammar, and translate that into SQL.
 *
 * AND IT REFUSES RATHER THAN GUESSES. Every branch below either produces SQL it
 * is sure about, or returns null, which leaves the original failure in place.
 * Embedded resources, rpc, or= filters, text search, csv, and anything else it
 * does not fully understand all end in a refusal. A fallback that silently
 * returns a different query from the one that was asked for would be worse than
 * the outage it is covering, because the record would look complete and be wrong.
 *
 * Table and column names are validated and quoted, never interpolated from user
 * input, and every value is a bound parameter.
 *
 * Reads and writes both go through here, because a platform whose agents cannot
 * write is not running, it is merely loading. Writes land in the same database
 * through the same pooler, so they are the same rows the REST API will serve
 * once it answers again.
 */

function connectionString(): string | null {
  const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (url) return url;
  /** The pooler variables scripts/apply-migration.cjs already uses. */
  const host = process.env.PGHOST;
  const password = process.env.PGPASSWORD;
  if (!host || !password) return null;
  const user = process.env.PGUSER || "postgres";
  const port = process.env.PGPORT || "6543";
  const database = process.env.PGDATABASE || "postgres";
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

let pool: Pool | null = null;
let tried = false;

export function pgConfigured(): boolean {
  return Boolean(connectionString());
}

function getPool(): Pool | null {
  if (pool) return pool;
  if (tried) return null;
  tried = true;
  const cs = connectionString();
  if (!cs) return null;
  pool = new Pool({
    connectionString: cs,
    /**
     * A page reads a couple of dozen things at once, and the world page reads
     * twenty three. Two connections turned that into a queue: the first live
     * world render took 21.5 seconds, because every read after the second waited
     * for a connection while its own budget ran out unseen. The pool is sized to
     * the page rather than to a single read.
     */
    max: Number(process.env.PG_POOL_MAX || 6),
    /**
     * The handshake is the expensive part here, not the query. Measured against
     * this project during the outage: a cold pooler connect took anywhere from
     * 1.4 seconds to 35, and often failed outright with "authentication did not
     * complete", while a connection that was already open answered a page of
     * events in about two hundred milliseconds. So idle clients are kept rather
     * than closed, because paying for the handshake once is what makes this
     * layer able to serve a page at all.
     */
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 60_000),
    keepAlive: true,
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 15_000),
    /**
     * No client side query timeout, deliberately, and this was learned by
     * watching one get in the way: a paged read is many statements, and a fixed
     * per statement ceiling cannot know whether the caller's budget is eight
     * seconds or two minutes. It cut the walk short at twelve seconds while the
     * pooler was healthy enough to finish it, and reported the whole read as
     * failed. The caller's budget is the only bound worth having, and it is
     * enforced by the abandonment timer in `runQuery`, which destroys the client
     * and so ends the statement server side. Zero means "no limit here".
     */
    query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 0),
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 0),
    ssl: { rejectUnauthorized: false },
  });
  pool.on("error", (e) => console.error(`[pooler] idle client error: ${e.message}`));
  return pool;
}

/** PostgREST returns bigints and numerics as JSON numbers; node-postgres gives strings. */
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));

/**
 * ONE RETRY, ON THE FAILURES THAT ARE A DEAD SOCKET RATHER THAN A BAD REQUEST.
 *
 * The pooler's own failure mode during the outage was a connect that stalled and
 * then reported that authentication did not complete within fifteen seconds.
 * That is the same half-open-socket problem that took PostgREST down, one layer
 * further out, and the credential is not the issue: the identical string
 * connected a minute earlier and a minute later. A read is idempotent, so one
 * retry after a short pause is safe, and on this project it is often the
 * difference between a page with rows on it and an empty one.
 *
 * A SQLSTATE from the server is never retried. If the database itself rejected
 * the statement, it will reject it again, and retrying would only hide a real
 * error behind a slower failure.
 */
const RETRYABLE = new Set(["08001", "08004", "08006", "08003", "57P01", "ECONNRESET", "ETIMEDOUT", "EPIPE"]);

function isRetryable(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  if (err.code && RETRYABLE.has(err.code)) return true;
  return /authentication did not complete|connection terminated|connection closed|timeout expired/i.test(err.message ?? "");
}

/**
 * One statement, on a connection this function owns and gives back.
 *
 * WHY THE CONNECTION IS HANDLED BY HAND RATHER THAN THROUGH `pool.query`. The
 * first version of this module raced the query against the caller's budget and
 * walked away when the timer won. That left the query RUNNING on a server
 * connection, still holding a pooler slot, and it was not harmless: after a few
 * pages of the world read, this project's pooler began refusing checkouts
 * outright with ECHECKOUTTIMEOUT, which takes the fallback down for every client
 * on the project, not just this one. Abandoning work without cancelling it is a
 * way to turn a slow path into a dead one.
 *
 * So when the budget runs out the client is DESTROYED rather than returned, which
 * closes the socket and ends the statement, and `statement_timeout` bounds the
 * server side as a second line. `null` means the query was abandoned, which the
 * caller reports as its original failure rather than as an answer.
 */
async function runQuery(pool: Pool, text: string, values: unknown[], abandonAfterMs: number): Promise<QueryResult | null> {
  const budget = Math.max(200, abandonAfterMs);
  const deadline = Date.now() + budget;
  for (let attempt = 1; ; attempt += 1) {
    /**
     * The budget covers the wait for a connection as well as the query.
     *
     * It did not, and that was visible: with the pool busy, `pool.connect()` sat
     * for its own fifteen second checkout timeout while the caller's eight second
     * budget went by, so a read that was supposed to give up in eight seconds took
     * twenty one. A budget that does not include the queue is not a budget.
     */
    const pending = pool.connect();
    let timedOut = false;
    const client = await Promise.race([
      pending.catch((e: unknown) => {
        console.error(`[pooler] could not check out a connection: ${(e as { message?: string }).message ?? String(e)}`);
        return null;
      }),
      new Promise<null>((resolve) =>
        setTimeout(() => {
          timedOut = true;
          resolve(null);
        }, budget),
      ),
    ]);
    if (!client) {
      /** A checkout that lands after we stopped waiting is destroyed, not leaked. */
      if (timedOut) void pending.then((late) => late.release(true)).catch(() => {});
      return null;
    }

    let abandoned = false;
    const timer = setTimeout(() => {
      abandoned = true;
      /** Destroying the client closes the socket, which ends the statement with it. */
      client.release(true);
    }, Math.max(200, deadline - Date.now()));

    try {
      const result = await client.query({ text, values });
      clearTimeout(timer);
      if (abandoned) return null;
      client.release();
      return result;
    } catch (e) {
      clearTimeout(timer);
      /** A destroyed client has already been handed back; there is nothing to release. */
      if (abandoned) return null;
      client.release(true);
      if (attempt >= 2 || !isRetryable(e)) throw e;
      console.error(`[pooler] retrying after: ${(e as { message?: string }).message ?? String(e)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/* ------------------------------------------------------------------ */
/* the translation                                                     */
/* ------------------------------------------------------------------ */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COLUMN = /^[A-Za-z_][A-Za-z0-9_]*(->>?[A-Za-z_][A-Za-z0-9_]*)?$/;

/** Column references, quoted, with one level of JSON arrow allowed. */
function quoteColumn(raw: string): string | null {
  if (!COLUMN.test(raw)) return null;
  const [base, arrow] = raw.split(/(->>?)/);
  const head = `"${base}"`;
  if (!arrow) return head;
  const rest = raw.slice(base.length + arrow.length);
  return `${head}${arrow}'${rest}'`;
}

type Compiled = {
  text: string;
  values: unknown[];
  single: boolean;
  minimal: boolean;
  count: boolean;
  returning: boolean;
  /** Set when a large read can be fetched in windows instead of one statement. */
  page?: PagePlan;
};

/**
 * A read that is too large to ask for in one statement.
 *
 * WHY THIS EXISTS, MEASURED. Over this project's pooler during the outage, a
 * fifty row read of `events` answered in 900ms and the same read at five thousand
 * rows never answered at all: twenty seconds and still nothing, every time. The
 * log is around 1.2 kB per row, so that request is about six megabytes, and the
 * pooler would not carry it. Meanwhile the world page needs exactly that read to
 * draw the town from the log.
 *
 * So the window is split, and the split is exact rather than approximate. The
 * ranges below are disjoint and cover the whole ordered set, which is what makes
 * them safe to run in parallel: no row can be read twice and none is skipped. An
 * offset based split would have been simpler and wrong, because new events arrive
 * at the head of this log while it is being read and shift every offset under it.
 */
type PagePlan = {
  /** `SELECT <columns> FROM <table>` with the caller's own conditions already applied. */
  base: string;
  /** The compiled WHERE clause, which the window conditions are appended to. */
  where: string;
  /** The bound values those conditions use. */
  values: unknown[];
  /** The compiled ORDER BY, which is a single descending column. */
  order: string;
  /** The quoted keyset column itself. */
  key: string;
  /** How many rows the caller asked for. */
  limit: number;
};

/**
 * The only columns this module will page on, and why the list is this short.
 *
 * A value range window is exact only if the ordered column is unique. With a
 * column that repeats, a window can hold far more rows than the statement's own
 * LIMIT, and the extras are dropped without anything noticing, which is the one
 * failure mode a fallback must never have: a short answer that looks complete.
 *
 * `seq` is the serial primary key of the event log, and it is the column the
 * world page orders by, so the list covers the read that needed this at all. A
 * column joins it when it is known to be unique here, which `created_at` is not.
 * Anything else simply is not paged and keeps the single statement it had.
 */
const KEYSET_COLUMNS = new Set(["seq"]);

/** How many windows are read at once. Never more than the pool can carry. */
const WORKERS = Math.max(1, Number(process.env.PG_PAGE_WORKERS || 2));

/** How many rows one statement is allowed to carry. Measured, not guessed. */
const PAGE_SIZE = Math.max(50, Number(process.env.PG_PAGE_SIZE || 500));

/** `<op>.<value>` as PostgREST writes it in a query parameter. */
function compileFilter(column: string, raw: string, values: unknown[]): string | null {
  const col = quoteColumn(column);
  if (!col) return null;

  let negation = "";
  let body = raw;
  if (body.startsWith("not.")) {
    negation = "NOT ";
    body = body.slice(4);
  }
  const dot = body.indexOf(".");
  if (dot < 0) return null;
  const op = body.slice(0, dot);
  const value = body.slice(dot + 1);

  const bind = (v: unknown, cast?: string) => {
    values.push(v);
    return `$${values.length}${cast ?? ""}`;
  };

  switch (op) {
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
    case "like":
    case "ilike": {
      const sql = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE", ilike: "ILIKE" }[op];
      /** `*` is PostgREST's wildcard for like and ilike only. */
      const v = op === "like" || op === "ilike" ? value.replace(/\*/g, "%") : value;
      return `${negation}${col} ${sql} ${bind(v)}`;
    }
    case "is": {
      const v = value.toLowerCase();
      if (v === "null") return `${negation}${col} IS NULL`;
      if (v === "true") return `${negation}${col} IS TRUE`;
      if (v === "false") return `${negation}${col} IS FALSE`;
      /** `is.unknown` is the absence of a value, which no row matches. */
      if (v === "unknown") return "false";
      return null;
    }
    case "in": {
      if (!value.startsWith("(") || !value.endsWith(")")) return null;
      const items = splitList(value.slice(1, -1));
      if (items === null) return null;
      return `${negation}${col} IN (${items.map((i) => bind(i)).join(", ")})`;
    }
    /** Containment and overlap, used for array and jsonb columns. */
    case "cs":
    case "cd":
    case "ov": {
      const needsBraces = !value.startsWith("{") && !value.startsWith("[");
      const literal = needsBraces ? `{${value}}` : value;
      const sql = op === "cs" ? "@>" : op === "cd" ? "<@" : "&&";
      return `${negation}${col} ${sql} ${bind(literal, "::text[]")}`;
    }
    default:
      return null;
  }
}

/** `a,b,"c,d"` into items, or null when an item is quoted strangely. */
function splitList(source: string): string[] | null {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === "," && !quoted) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (quoted) return null;
  out.push(current);
  return out;
}

function compileOrder(raw: string): string | null {
  const parts: string[] = [];
  for (const item of raw.split(",")) {
    const bits = item.split(".");
    const col = quoteColumn(bits[0]);
    if (!col) return null;
    const dir = bits[1] === "desc" ? "DESC" : "ASC";
    const nulls = bits[2] === "nullsfirst" ? " NULLS FIRST" : bits[2] === "nullslast" ? " NULLS LAST" : "";
    parts.push(`${col} ${dir}${nulls}`);
  }
  return parts.length ? parts.join(", ") : null;
}

function compileSelect(raw: string): string | null {
  if (raw === "*" || raw === "") return "*";
  const cols: string[] = [];
  for (const item of raw.split(",")) {
    const trimmed = item.trim();
    /** An embedded resource, an alias or a cast: refuse rather than approximate. */
    if (trimmed.includes("(") || trimmed.includes(":") || trimmed.includes("!") || trimmed.includes(".")) return null;
    const col = quoteColumn(trimmed);
    if (!col) return null;
    cols.push(col);
  }
  return cols.length ? cols.join(", ") : null;
}

function table(raw: string): string | null {
  return IDENT.test(raw) ? `"public"."${raw}"` : null;
}

/**
 * One PostgREST request becomes one statement, or a refusal.
 *
 * `select` on a write is the shadow of `?columns=` for inserts, and on a read it
 * is the projection. Both are handled, and the two are never mixed silently.
 */
export function compile(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Compiled | { refuse: string } {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/^\/rest\/v1\//, "");
  if (path === parsed.pathname.replace(/^\//, "") || path.startsWith("rpc/")) {
    return { refuse: "rpc and non-table paths are not translated" };
  }
  const target = table(path);
  if (!target) return { refuse: `unreadable table name: ${path}` };

  const opts = parsed.searchParams;
  const single = (headers.accept || "").includes("application/vnd.pgrst.object+json");
  const minimal = (headers.prefer || "").includes("return=minimal");
  const count = (headers.prefer || "").includes("count=exact");
  const returning = !minimal;

  const values: unknown[] = [];
  const conditions: string[] = [];
  for (const [key, value] of opts.entries()) {
    if (key === "select" || key === "order" || key === "limit" || key === "offset" || key === "on_conflict" || key === "columns") continue;
    /** A dotted key filters an embedded resource, which this does not translate. */
    if (key.includes(".")) return { refuse: `embedded filter not translated: ${key}` };
    const clause = compileFilter(key, value, values);
    if (!clause) return { refuse: `filter not translated: ${key}=${value}` };
    conditions.push(clause);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";

  const limitRaw = opts.get("limit");
  const offsetRaw = opts.get("offset");
  const limit = limitRaw === null ? null : Number(limitRaw);
  const offset = offsetRaw === null ? null : Number(offsetRaw);
  if ((limit !== null && !Number.isFinite(limit)) || (offset !== null && !Number.isFinite(offset))) {
    return { refuse: "limit and offset must be numbers" };
  }
  /** Asking for one object means asking for two rows, so that "too many" is detectable. */
  const limitSql = ` LIMIT ${single ? 2 : limit === null ? "ALL" : Math.max(0, Math.trunc(limit))}`;
  const offsetSql = offset === null ? "" : ` OFFSET ${Math.max(0, Math.trunc(offset))}`;

  const order = opts.get("order");
  let orderSql = "";
  if (order) {
    const compiled = compileOrder(order);
    if (!compiled) return { refuse: `order not translated: ${order}` };
    orderSql = ` ORDER BY ${compiled}`;
  }

  if (method === "GET" || method === "HEAD") {
    const select = compileSelect(opts.get("select") ?? "*");
    if (!select) return { refuse: `select not translated: ${opts.get("select")}` };
    const text = `SELECT ${select} FROM ${target}${where}${orderSql}${limitSql}${offsetSql}`;
    /**
     * A large, ordered read on a single column: the shape the log is read in, and
     * the only shape this module pages. Everything about it is checked, because a
     * page plan that guessed at the keyset would duplicate or drop rows, and both
     * of those produce a town that looks right and is not.
     */
    const ordered = orderSql ? compileOrder(order ?? "") : null;
    const key = quoteColumn(order?.split(",")[0]?.split(".")[0] ?? "");
    const pageable =
      !single &&
      !count &&
      offset === null &&
      limit !== null &&
      limit > PAGE_SIZE &&
      ordered !== null &&
      key !== null &&
      KEYSET_COLUMNS.has(order?.split(",")[0]?.split(".")[0] ?? "") &&
      ordered.startsWith(`${key} DESC`) &&
      !ordered.slice(`${key} DESC`.length).trim().startsWith(",") &&
      (select === "*" || select.split(", ").includes(key));
    const page: PagePlan | undefined = pageable
      ? { base: `SELECT ${select} FROM ${target}${where}`, where, values, order: ordered as string, key: key as string, limit: Math.trunc(limit as number) }
      : undefined;
    return { text, values, single, minimal, count, returning, ...(page ? { page } : {}) };
  }

  if (method === "POST") {
    const rows = Array.isArray(body) ? body : [body];
    if (!rows.length || rows.some((r) => !r || typeof r !== "object" || Array.isArray(r))) {
      return { refuse: "insert body must be an object or an array of objects" };
    }
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r as object)))];
    if (!keys.length || keys.some((k) => !IDENT.test(k))) return { refuse: "insert columns must be plain names" };
    const columns = keys.map((k) => `"${k}"`).join(", ");
    const tuples = rows.map((row) => {
      const cells = keys.map((k) => {
        const record = row as Record<string, unknown>;
        if (!(k in record)) return "DEFAULT";
        values.push(record[k] === undefined ? null : record[k]);
        return `$${values.length}`;
      });
      return `(${cells.join(", ")})`;
    });

    let conflict = "";
    const onConflict = opts.get("on_conflict");
    const prefer = headers.prefer || "";
    if (prefer.includes("resolution=merge-duplicates")) {
      if (!onConflict) return { refuse: "merge duplicates needs on_conflict to name the key" };
      const cols = onConflict.split(",").map((c) => quoteColumn(c.trim()));
      if (cols.some((c) => !c)) return { refuse: `on_conflict not translated: ${onConflict}` };
      const assignments = keys.map((k) => `"${k}" = EXCLUDED."${k}"`).join(", ");
      conflict = ` ON CONFLICT (${cols.join(", ")}) DO UPDATE SET ${assignments}`;
    } else if (prefer.includes("resolution=ignore-duplicates")) {
      conflict = onConflict
        ? ` ON CONFLICT (${onConflict.split(",").map((c) => quoteColumn(c.trim())).join(", ")}) DO NOTHING`
        : " ON CONFLICT DO NOTHING";
    }

    const returningSql = returning ? " RETURNING *" : "";
    return { text: `INSERT INTO ${target} (${columns}) VALUES ${tuples.join(", ")}${conflict}${returningSql}`, values, single, minimal, count, returning };
  }

  if (method === "PATCH") {
    if (!body || typeof body !== "object" || Array.isArray(body)) return { refuse: "update body must be an object" };
    const entries = Object.entries(body as Record<string, unknown>);
    if (!entries.length) return { refuse: "update body is empty" };
    const sets = entries.map(([k, v]) => {
      if (!IDENT.test(k)) throw new Error(`update column is not a plain name: ${k}`);
      values.push(v === undefined ? null : v);
      return `"${k}" = $${values.length}`;
    });
    /** A PATCH with no filter would rewrite the whole table, so it is refused. */
    if (!conditions.length) return { refuse: "refusing an update with no filter" };
    const returningSql = returning ? " RETURNING *" : "";
    return { text: `UPDATE ${target} SET ${sets.join(", ")}${where}${returningSql}`, values, single, minimal, count, returning };
  }

  if (method === "DELETE") {
    if (!conditions.length) return { refuse: "refusing a delete with no filter" };
    const returningSql = returning ? " RETURNING *" : "";
    return { text: `DELETE FROM ${target}${where}${returningSql}`, values, single, minimal, count, returning };
  }

  return { refuse: `method not translated: ${method}` };
}

/* ------------------------------------------------------------------ */
/* the response                                                        */
/* ------------------------------------------------------------------ */

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      /** So a fallback response is never mistaken for a PostgREST one. */
      "x-swamp-source": "pooler",
      ...headers,
    },
  });
}

/**
 * Shape the rows the way PostgREST would have.
 *
 * `single()` sets the object Accept header and expects an object, with a 406
 * when zero or several rows match. `maybeSingle()` does not set that header, it
 * expects an array, and converts it in the client, so arrays stay arrays.
 */
function shape(rows: unknown[] | null, compiled: Compiled, headers: Record<string, string>, total?: number): Response {
  const extra: Record<string, string> = {};
  if (compiled.count && typeof total === "number") extra["content-range"] = `0-${Math.max(0, total - 1)}/${total}`;
  if (compiled.minimal) return new Response(null, { status: 204, headers: { "x-swamp-source": "pooler", ...extra } });
  if (!compiled.returning) return json(null, 201, extra);

  const list = rows ?? [];
  if (!compiled.single) return json(list, 200, extra);
  if (list.length === 1) return json(list[0], 200, extra);
  return json(
    {
      code: "PGRST116",
      details: `Results contain ${list.length} rows, application/vnd.pgrst.object+json requires 1 row`,
      hint: null,
      message: "JSON object requested, multiple (or no) rows returned",
    },
    406,
    extra,
  );
}

/* ------------------------------------------------------------------ */
/* the entry point                                                     */
/* ------------------------------------------------------------------ */

/**
 * Read the whole set in windows, newest first, and never return half of it.
 *
 * A truncated log is not a smaller answer, it is a wrong one: the town built
 * from it would be short and would say so with a straight face. So a window that
 * never got read, or a budget that ran out mid-read, returns null and leaves the
 * caller's original failure in place.
 */
async function readInWindows(pool: Pool, plan: PagePlan, budgetMs: number, started: number): Promise<unknown[] | null> {
  /**
   * The key range comes from the index, not from the caller's own filter.
   *
   * The first version asked min and max of the filtered set, which made the
   * database read every candidate row just to report two integers, and then timed
   * out on the very read this paging exists to make possible. min and max of a
   * primary key are two index lookups, so the window is planned from those, and
   * the caller's filter is applied inside each window where it belongs. A
   * selective filter can then make the walk longer, and the budget still bounds
   * it, so the worst case is the original honest failure rather than a slow one.
   */
  const table = plan.base.slice(plan.base.indexOf(" FROM ") + 6).split(" WHERE")[0];
  const bounds = await runQuery(
    pool,
    `SELECT (SELECT min(${plan.key}) FROM ${table})::bigint AS lo, (SELECT max(${plan.key}) FROM ${table})::bigint AS hi`,
    [],
    budgetMs,
  );
  if (!bounds) return null;
  const lo = Number(bounds.rows[0]?.lo);
  let hi = Number(bounds.rows[0]?.hi);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return [];

  /** Disjoint ranges of the key, newest first. Nothing is read twice, nothing is skipped. */
  const planned: Array<[number, number]> = [];
  while (hi >= lo) {
    const low = Math.max(lo, hi - PAGE_SIZE + 1);
    planned.push([low, hi]);
    hi = low - 1;
  }
  /**
   * A filter that matches few rows makes each window cheap and the walk long, so
   * the walk is capped. The cap costs accuracy rather than correctness: coming up
   * short after a capped walk returns null instead of a short list.
   */
  const maxWindows = Math.ceil(plan.limit / PAGE_SIZE) + 8;
  const capped = planned.length > maxWindows;
  const windows = capped ? planned.slice(0, maxWindows) : planned;

  const chunks: Array<unknown[] | undefined> = new Array(windows.length);
  let next = 0;
  let outOfTime = false;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= windows.length) return;
      if (Date.now() - started > budgetMs) {
        outOfTime = true;
        return;
      }
      const [low, high] = windows[index];
      /** The window conditions are appended to the caller's own, never in place of them. */
      const res = await runQuery(
        pool,
        `${plan.base}${plan.where ? " AND" : " WHERE"} ${plan.key} >= $${plan.values.length + 1} AND ${plan.key} <= $${
          plan.values.length + 2
        } ORDER BY ${plan.order} LIMIT ${PAGE_SIZE}`,
        [...plan.values, low, high],
        budgetMs - (Date.now() - started),
      );
      if (!res) {
        outOfTime = true;
        return;
      }
      chunks[index] = res.rows;
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, windows.length) }, worker));
  if (outOfTime) return null;

  const rows: unknown[] = [];
  let complete = !capped;
  for (const chunk of chunks) {
    /** An unread window means this is not the whole set. */
    if (!chunk) {
      complete = false;
      break;
    }
    rows.push(...chunk);
    if (rows.length >= plan.limit) break;
  }
  /** Enough rows is an answer however the walk ended. */
  if (rows.length >= plan.limit) return rows.slice(0, plan.limit);
  /** Short of the request, so it only counts if the set really was exhausted. */
  if (!complete || outOfTime) return null;
  return rows;
}

/**
 * THE LARGE READ, REMEMBERED AND REFRESHED OUT OF BAND.
 *
 * Only paged reads are cached, and only in this process. Keyed by the request
 * URL, which is the whole query, so a different read is a different entry and
 * nothing has to be invalidated by hand. The rows are the database's own, read
 * over the pooler on every refresh; the only thing this adds is an age.
 */
const largeReads = new Map<string, { at: number; rows: unknown[] }>();
const refreshing = new Set<string>();

/** How old a remembered read may be before a reader triggers a refresh. */
const REFRESH_MS = Number(process.env.PG_PAGE_REFRESH_MS || 60_000);

/** Past this, stale stops being useful and the read is reported as failed. */
const STALE_LIMIT_MS = Number(process.env.PG_PAGE_STALE_MS || 600_000);

/**
 * A refresh runs on its own connection, so a walk that takes a minute and a half
 * cannot hold the connections a page needs while it works.
 */
let backgroundPool: Pool | null = null;

function getBackgroundPool(): Pool | null {
  if (backgroundPool) return backgroundPool;
  const foreground = getPool();
  if (!foreground) return null;
  backgroundPool = new Pool({
    connectionString: connectionString() as string,
    max: Number(process.env.PG_BACKGROUND_POOL_MAX || 1),
    keepAlive: true,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 15_000),
    query_timeout: 0,
    statement_timeout: 0,
    ssl: { rejectUnauthorized: false },
  });
  backgroundPool.on("error", (e) => console.error(`[pooler] background idle client error: ${e.message}`));
  return backgroundPool;
}

function refreshLargeRead(request: FallbackRequest, compiled: Compiled): void {
  if (!compiled.page || refreshing.has(request.url)) return;
  const pool = getBackgroundPool();
  if (!pool) return;
  refreshing.add(request.url);
  void (async () => {
    const started = Date.now();
    try {
      const rows = await readInWindows(pool, compiled.page as PagePlan, Number(process.env.PG_PAGE_REFRESH_BUDGET_MS || 180_000), started);
      if (rows) {
        largeReads.set(request.url, { at: Date.now(), rows });
        console.log(`[pooler] refreshed a large read in ${Date.now() - started}ms: ${rows.length} rows`);
      }
    } catch (e) {
      console.error(`[pooler] a background refresh failed: ${(e as { message?: string }).message ?? String(e)}`);
    } finally {
      refreshing.delete(request.url);
    }
  })();
}

/** Only the parts of a fetch request this module needs. */
export type FallbackRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  /** How much of the caller's budget is left, so a slow pool cannot outlive the page. */
  budgetMs: number;
};

export async function pgRequest(request: FallbackRequest): Promise<Response | null> {
  const p = getPool();
  if (!p) return null;
  if (request.budgetMs < 500) return null;

  let parsedBody: unknown = null;
  if (request.body) {
    try {
      parsedBody = JSON.parse(request.body);
    } catch {
      return null;
    }
  }

  let compiled: Compiled | { refuse: string };
  try {
    compiled = compile(request.method, request.url, request.headers, parsedBody);
  } catch (e) {
    console.error(`[pooler] could not compile: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  if ("refuse" in compiled) {
    console.error(`[pooler] refusing: ${compiled.refuse}`);
    return null;
  }

  const started = Date.now();

  /**
   * A read too large for one statement goes out as windows instead, and is
   * remembered, because it is the one read here that cannot fit a page's budget.
   * Measured rather than assumed: five thousand rows of the event log took eighty
   * one seconds over this pooler, on a connection that answered fifty of the same
   * rows in four. No budget a page can be given covers that, so a reader gets the
   * last real rows from the real database with an age on them, and the walk that
   * refreshes them runs on its own connection out of band.
   */
  if (compiled.page) {
    const path = new URL(request.url).pathname;
    const cached = largeReads.get(request.url);
    const age = cached ? Date.now() - cached.at : Number.POSITIVE_INFINITY;

    if (cached && age <= REFRESH_MS) {
      console.log(`[pooler] served ${request.method} ${path} from a remembered read, ${Math.round(age / 1000)}s old`);
      return shape(cached.rows, compiled, request.headers);
    }

    try {
      const rows = await readInWindows(p, compiled.page, request.budgetMs, started);
      if (rows) {
        largeReads.set(request.url, { at: Date.now(), rows });
        console.log(
          `[pooler] served ${request.method} ${path} in ${Date.now() - started}ms (${rows.length} rows in windows of ${PAGE_SIZE})`,
        );
        return shape(rows, compiled, request.headers);
      }
    } catch (e) {
      const error = e as { code?: string; message?: string };
      console.error(`[pooler] paged read failed: ${error.code ?? ""} ${error.message ?? String(e)}`);
    }

    /**
     * This reader is not going to wait for it, so the walk is started for the
     * next one, and meanwhile anything remembered is served if it is still young
     * enough to be called current. Past that age it is not an answer either, and
     * the caller keeps its original failure.
     */
    void refreshLargeRead(request, compiled);
    if (cached && age <= STALE_LIMIT_MS) {
      console.log(`[pooler] served ${request.method} ${path} from a remembered read, ${Math.round(age / 1000)}s old`);
      return shape(cached.rows, compiled, request.headers);
    }
    console.error(`[pooler] a paged read could not be completed inside ${request.budgetMs}ms`);
    return null;
  }

  try {
    /**
     * The budget bounds this statement at the connection rather than in a race,
     * so a query that outlives it is cancelled instead of continuing to hold a
     * slot. Whichever way it ends, the caller gets its original failure rather
     * than a slower one.
     */
    const result = await runQuery(p, compiled.text, compiled.values, request.budgetMs);
    if (!result) {
      console.error(`[pooler] the budget ran out before this query returned: ${compiled.text.slice(0, 80)}`);
      return null;
    }
    let total: number | undefined;
    if (compiled.count) {
      /**
       * A count is its own query, and the select is reused as a subquery rather
       * than edited, so the two can never disagree about what was counted.
       */
      const counted = await runQuery(
        p,
        `SELECT count(*)::int AS n FROM (${compiled.text}) AS swamp_count`,
        compiled.values,
        request.budgetMs - (Date.now() - started),
      );
      if (!counted) return null;
      total = counted.rows[0]?.n;
    }
    console.log(`[pooler] served ${request.method} ${new URL(request.url).pathname} in ${Date.now() - started}ms`);
    return shape(result.rows, compiled, request.headers, total);
  } catch (e) {
    const error = e as { code?: string; message?: string };
    console.error(`[pooler] query failed: ${error.code ?? ""} ${error.message ?? String(e)}`);
    /**
     * The caller is supabase-js, which reads `error` out of this shape. PostgREST
     * itself returns the SQLSTATE as the code, so an unique violation arrives as
     * 23505 either way and existing handling keeps working.
     */
    return json(
      { code: error.code ?? "PGRST000", details: null, hint: null, message: error.message ?? "the pooler query failed" },
      400,
    );
  }
}
