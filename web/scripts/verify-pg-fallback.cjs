#!/usr/bin/env node
/**
 * The fallback that keeps the data live when the REST API cannot carry it.
 *
 * WHY THIS FILE IS MOSTLY ABOUT REFUSALS. A translator that returns the wrong
 * rows would be worse than an outage, because the page would look right. So the
 * interesting checks here are the ones that assert a request is NOT answered:
 * embedded resources, rpc, or= filters, text search, a dotted foreign filter, a
 * write with no filter, and a table or column name that is not a plain
 * identifier all have to come back as refusals rather than as something close.
 *
 * The translation checks are exact strings rather than a round trip, because the
 * shape of the SQL is a claim the schema can be held to: identifiers quoted,
 * values bound, one statement per request.
 *
 * The live checks at the end run the same entry point the app uses, against the
 * real database, and are skipped with a clear line when there is no connection
 * string in the environment. They exist because the offline checks prove the
 * translation is what it says, and only the live ones prove the database agrees.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-pg-fallback.cjs
 *
 * With a database:
 *   DATABASE_URL=postgresql://... node --experimental-strip-types ... scripts/verify-pg-fallback.cjs
 */
const path = require("node:path");

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures += 1;
}

(async () => {
  const { compile, pgRequest, pgConfigured } = await import("../lib/supabase/pg-rest.ts");
  const base = "https://example.supabase.co/rest/v1/";
  const json = { accept: "application/json" };

  /* ---------- reads ---------- */

  const simple = compile("GET", `${base}events?select=id&limit=1`, json, null);
  check(
    "a simple select compiles to one quoted statement",
    !("refuse" in simple) && simple.text === 'SELECT "id" FROM "public"."events" LIMIT 1',
    JSON.stringify(simple),
  );

  const filtered = compile("GET", `${base}events?select=id,kind&kind=eq.telemetry&limit=5`, json, null);
  check(
    "filters become bound parameters",
    !("refuse" in filtered) &&
      filtered.text === 'SELECT "id", "kind" FROM "public"."events" WHERE "kind" = $1 LIMIT 5' &&
      JSON.stringify(filtered.values) === JSON.stringify(["telemetry"]),
    JSON.stringify(filtered),
  );

  const many = compile("GET", `${base}events?select=id&id=in.(1,2,3)&order=created_at.desc&limit=10&offset=5`, json, null);
  check(
    "in, order, limit and offset all survive",
    !("refuse" in many) &&
      many.text === 'SELECT "id" FROM "public"."events" WHERE "id" IN ($1, $2, $3) ORDER BY "created_at" DESC LIMIT 10 OFFSET 5',
    JSON.stringify(many),
  );

  const negated = compile("GET", `${base}agents?select=handle&status=not.eq.retired`, json, null);
  check(
    "a negated filter keeps its NOT",
    !("refuse" in negated) && negated.text.includes('NOT "status" = $1'),
    JSON.stringify(negated),
  );

  const isNull = compile("GET", `${base}agents?select=handle&left_at=is.null`, json, null);
  check("is.null becomes IS NULL", !("refuse" in isNull) && isNull.text.includes('"left_at" IS NULL'), JSON.stringify(isNull));

  /** single() is the object Accept header, and it has to be able to detect two rows. */
  const single = compile("GET", `${base}agents?select=handle&limit=1`, { accept: "application/vnd.pgrst.object+json" }, null);
  check(
    "single asks for two rows so that too many is detectable",
    !("refuse" in single) && single.single === true && single.text.endsWith("LIMIT 2"),
    JSON.stringify(single),
  );

  /* ---------- reads too large for one statement ---------- */

  /**
   * These four are the whole of the paging rule.
   *
   * The suite from the README's perspective: a read is paged when, and only
   * when, it is a plain ordered read of more rows than one statement should
   * carry. Each refusal below is a case where paging would have been tempting and
   * wrong: a single() object is asking for a shape, an order by a null-ridden
   * column is not a keyset, and a projection without the key cannot advance.
   */
  const heavy = compile("GET", `${base}events?select=*&order=seq.desc&limit=5000`, json, null);
  check(
    "a five thousand row ordered read is planned as windows",
    !("refuse" in heavy) && heavy.page && heavy.page.key === '"seq"' && heavy.page.limit === 5000,
    JSON.stringify(heavy.page ?? heavy),
  );

  const small = compile("GET", `${base}events?select=*&order=seq.desc&limit=50`, json, null);
  check("a small read is not paged, it is just read", !("refuse" in small) && small.page === undefined, JSON.stringify(small.page));

  const otherOrder = compile("GET", `${base}events?select=*&order=created_at.desc&limit=5000`, json, null);
  check(
    "an ordered read on a column that is not the key is not paged",
    !("refuse" in otherOrder) && otherOrder.page === undefined,
    JSON.stringify(otherOrder.page),
  );

  const noKey = compile("GET", `${base}events?select=kind&order=seq.desc&limit=5000`, json, null);
  check(
    "a projection without the key cannot advance a window, so it is not paged",
    !("refuse" in noKey) && noKey.page === undefined,
    JSON.stringify(noKey.page),
  );

  const counted = compile("GET", `${base}events?select=*&order=seq.desc&limit=5000`, { ...json, prefer: "count=exact" }, null);
  check(
    "a read that also wants a count is not paged, because the count would be taken twice",
    !("refuse" in counted) && counted.page === undefined,
    JSON.stringify(counted.page),
  );

  const ascending = compile("GET", `${base}events?select=*&order=seq.asc&limit=5000`, json, null);
  check(
    "an ascending read is not paged, since the key window walks down from the top",
    !("refuse" in ascending) && ascending.page === undefined,
    JSON.stringify(ascending.page),
  );

  const quotedList = compile("GET", `${base}events?select=id&kind=in.("a,b",c)`, json, null);
  check(
    "a quoted comma inside an in list stays one value",
    !("refuse" in quotedList) && JSON.stringify(quotedList.values) === JSON.stringify(["a,b", "c"]),
    JSON.stringify(quotedList.values),
  );

  /* ---------- writes ---------- */

  const insert = compile("POST", `${base}events?select=id`, { ...json, prefer: "return=representation" }, { kind: "telemetry", seq: 7 });
  check(
    "an insert compiles with bound values",
    !("refuse" in insert) &&
      insert.text === 'INSERT INTO "public"."events" ("kind", "seq") VALUES ($1, $2) RETURNING *',
    JSON.stringify(insert),
  );

  const insertMany = compile("POST", `${base}events`, json, [{ a: 1, b: 2 }, { a: 3 }]);
  check(
    "a missing key in one row becomes DEFAULT rather than null",
    !("refuse" in insertMany) && insertMany.text.includes("($1, $2), ($3, DEFAULT)"),
    JSON.stringify(insertMany),
  );

  const upsert = compile(
    "POST",
    `${base}skill_registry?on_conflict=owner,slug`,
    { ...json, prefer: "resolution=merge-duplicates,return=representation" },
    { owner: "a", slug: "b", name: "c" },
  );
  check(
    "merge duplicates becomes ON CONFLICT DO UPDATE",
    !("refuse" in upsert) && upsert.text.includes('ON CONFLICT ("owner", "slug") DO UPDATE SET'),
    JSON.stringify(upsert),
  );

  const update = compile("PATCH", `${base}machines?id=eq.7`, { ...json, prefer: "return=representation" }, { status: "active" });
  check(
    "an update keeps its filter and returns rows",
    !("refuse" in update) &&
      update.text === 'UPDATE "public"."machines" SET "status" = $2 WHERE "id" = $1 RETURNING *' &&
      /** The filter was compiled first, so it took $1 and the value it binds is the id. */
      JSON.stringify(update.values) === JSON.stringify(["7", "active"]),
    JSON.stringify(update),
  );

  const minimal = compile("POST", `${base}events`, { ...json, prefer: "return=minimal" }, { kind: "x" });
  check("return=minimal is remembered", !("refuse" in minimal) && minimal.minimal === true, JSON.stringify(minimal));

  /* ---------- refusals ---------- */

  const refusals = [
    ["rpc", () => compile("POST", `${base}rpc/registry_coverage`, json, {})],
    ["an embedded resource", () => compile("GET", `${base}agents?select=*,machines(name)`, json, null)],
    [
      "an aliased column",
      () => compile("GET", `${base}events?select=id:identifier`, json, null),
    ],
    ["an or= filter", () => compile("GET", `${base}events?or=(a.eq.1,b.eq.2)`, json, null)],
    ["a dotted foreign filter", () => compile("GET", `${base}events?agents.status=eq.active`, json, null)],
    ["text search", () => compile("GET", `${base}events?body=fts.hello`, json, null)],
    ["an unknown operator", () => compile("GET", `${base}events?id=between.1,2`, json, null)],
    ["an update with no filter", () => compile("PATCH", `${base}events`, json, { kind: "x" })],
    ["a delete with no filter", () => compile("DELETE", `${base}events`, json, null)],
    ["a table name that is not an identifier", () => compile("GET", `${base}events;drop?select=id`, json, null)],
    ["a column that is not an identifier", () => compile("GET", `${base}events?select=id,1;--`, json, null)],
    ["an unparseable filter", () => compile("GET", `${base}events?id=7`, json, null)],
    ["an unsupported method", () => compile("PUT", `${base}events`, json, {})],
  ];
  for (const [name, run] of refusals) {
    let result;
    try {
      result = run();
    } catch (e) {
      result = { refuse: `threw: ${e.message}` };
    }
    check(`refuses ${name}`, "refuse" in result, JSON.stringify(result).slice(0, 120));
  }

  /* ---------- live, against the real database ---------- */

  if (!pgConfigured()) {
    console.log("\nno DATABASE_URL or PGHOST and PGPASSWORD, so the live checks were skipped");
  } else {
    const host = new URL(base).host;
    /**
     * The pooler has been slow and intermittently unwilling all day, so the test
     * reports what each call actually cost and retries once when the failure is
     * Supavisor refusing to hand out a connection. That retry is not politeness:
     * a pool checkout timeout says nothing about whether the SQL was right, and a
     * suite that fails on it would train its reader to ignore the failure that
     * matters. If both attempts fail on it, the check fails and says why.
     */
    const call = async (url, headers, method = "GET", body = null) => {
      let response = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const started = Date.now();
        response = await pgRequest({ url: `${base}${url}`, method, headers, body, budgetMs: 25_000 });
        console.log(`     ${String(method).padEnd(6)} ${url.split("?")[0].padEnd(16)} ${Date.now() - started}ms`);
        const kind = response ? await response.clone().json().catch(() => null) : null;
        const poolerRefused = kind && (kind.code === "XX000" || /check out connection|ECHECKOUTTIMEOUT/i.test(String(kind.message)));
        if (!poolerRefused) break;
        console.log("     the pooler would not hand out a connection; trying once more");
        await new Promise((r) => setTimeout(r, 1_500));
      }
      return response;
    };
    /** events.id is a uuid, so an absent row is the nil uuid rather than -1. */
    const absent = "00000000-0000-0000-0000-000000000000";

    const read = await call("events?select=id,topic&limit=3", json);
    const rows = read ? await read.json() : null;
    check(`a live select returns rows from ${host}`, Array.isArray(rows) && rows.length > 0, JSON.stringify(rows).slice(0, 120));
    check("a live select is marked as coming from the pooler", read?.headers.get("x-swamp-source") === "pooler");

    /** A filter on a real column, which is what the app's own reads do. */
    const filteredLive = await call("events?select=id,topic&topic=eq.agent.thought&limit=2", json);
    const filteredRows = filteredLive ? await filteredLive.json() : null;
    check(
      "a live filtered select returns only matching rows",
      Array.isArray(filteredRows) && filteredRows.every((r) => r.topic === "agent.thought"),
      JSON.stringify(filteredRows).slice(0, 120),
    );

    const one = await call("events?select=id&limit=1", { accept: "application/vnd.pgrst.object+json" });
    const oneBody = one ? await one.json() : null;
    check("single shape returns an object, not an array", oneBody !== null && !Array.isArray(oneBody), JSON.stringify(oneBody).slice(0, 120));

    const none = await call(`events?select=id&id=eq.${absent}`, { accept: "application/vnd.pgrst.object+json" });
    check("single shape refuses zero rows with PGRST116", none?.status === 406, String(none?.status));

    const maybe = await call(`events?select=id&id=eq.${absent}`, json);
    const maybeBody = maybe ? await maybe.json() : null;
    check("maybeSingle shape returns an empty array", Array.isArray(maybeBody) && maybeBody.length === 0, JSON.stringify(maybeBody));

    const badColumn = await call("events?select=definitely_not_a_column&limit=1", json);
    const badBody = badColumn ? await badColumn.json() : null;
    check(
      "a database error arrives as the SQLSTATE PostgREST would have sent",
      badColumn?.status === 400 && badBody?.code === "42703",
      JSON.stringify(badBody).slice(0, 140),
    );

    /**
     * The heavy read the world page makes, at its real size.
     *
     * This is the check that matters most and the one most likely to be
     * unavailable: the pooler has been measured anywhere from 200ms to refusing
     * checkouts outright during the outage this module exists for. So a pooler
     * that cannot carry it reports FAIL with the reason, rather than being
     * waved through, because a paged read that silently returns nothing is
     * exactly the failure this suite is here to catch.
     */
    const heavyLive = await call("events?select=*&order=seq.desc&limit=5000", json);
    const heavyRows = heavyLive ? await heavyLive.json() : null;
    check(
      "a five thousand row read comes back whole",
      Array.isArray(heavyRows) && heavyRows.length === 5000 && heavyRows[0].seq > heavyRows[4999].seq,
      Array.isArray(heavyRows) ? `${heavyRows.length} rows` : JSON.stringify(heavyRows).slice(0, 140),
    );
  }

  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}: the fallback translates, refuses, and reads.`);
  process.exit(failures === 0 ? 0 : 1);
})();
