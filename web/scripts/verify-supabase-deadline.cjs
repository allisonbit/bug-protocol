/**
 * THE DEADLINE THAT WAS MISSING ON 2026-09-23.
 *
 * That morning Supabase's EU West 1 stack stopped answering over HTTPS while the
 * database itself stayed reachable. Every page on this site needs a read, every
 * read failed soft, and the site served an empty browser for hours instead of an
 * empty state — because nothing in the stack had a deadline. The request went to
 * the platform fetch, the platform fetch waited, the page waited on it, and
 * Vercel killed the function with no response at all.
 *
 * So there are two claims to hold here, and this file checks both.
 *
 * WIRING. A correct fetch that nobody passes to the client is worth nothing, and
 * the four clients that talk to Supabase are exactly where it can be dropped
 * again by a later edit. Each one is read from disk and required to pass the
 * deadline fetch, so a new client cannot be added without this failing.
 *
 * BEHAVIOUR. The fetch gives up at the deadline rather than at the platform's
 * convenience; a caller's own abort is not reported as a database failure,
 * because a component unmounting is not an outage; and the deadline itself is
 * clamped, so a stray env value cannot disable the thing that just saved this
 * deployment.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-supabase-deadline.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures += 1;
}

(async () => {
  const root = path.join(__dirname, "..");
  const deadlineSrc = path.join(root, "lib", "supabase", "deadline.ts");

  /* ---------- behaviour ---------- */

  /**
   * A slow origin. It answers on a timer rather than refusing, which is the
   * shape of the real failure: the connection is accepted and then nothing
   * arrives, so only a deadline can end the request.
   */
  const server = http.createServer((req, res) => {
    if (req.url === "/slow") return setTimeout(() => res.end("late"), 4_000);
    if (req.url === "/fast") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("now");
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  /**
   * Low enough to keep this file quick, and above the one-second floor so the
   * number the log names is the number this test set: at 800 the guard would
   * raise it to 1,000, and the log line would correctly disagree with the test.
   */
  process.env.SUPABASE_TIMEOUT_MS = "1200";
  process.env.SUPABASE_BREAKER_MS = "4000";
  const { supabaseFetch, supabaseTimeoutMs, supabaseBreakerMs, supabaseCircuitOpen, resetSupabaseCircuit } =
    await import("../lib/supabase/deadline.ts");

  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(" "));

  /** Counts attempts that actually reached the origin. */
  let attempts = 0;
  const counting = http.createServer((req, res) => {
    attempts += 1;
    if (req.url === "/slow") return setTimeout(() => res.end("late"), 4_000);
    res.writeHead(200, { "content-type": "text/plain" }).end("now");
  });
  await new Promise((resolve) => counting.listen(0, "127.0.0.1", resolve));
  const probe = `http://127.0.0.1:${counting.address().port}`;

  /** Order matters here: a closed breaker is the prerequisite for testing one that opens. */
  resetSupabaseCircuit();
  const fast = await supabaseFetch(`${probe}/fast`);
  check("a request inside the deadline passes through", (await fast.text()) === "now");
  check("a healthy request logs nothing", errors.length === 0, JSON.stringify(errors));

  /**
   * A caller's abort. This is the branch that must NOT be reported: a user
   * navigating away cancels reads constantly, and logging those would bury the
   * real failures under a flood of their own. It must not open the breaker
   * either, or one visitor closing a tab would shut the database for everyone.
   */
  const controller = new AbortController();
  const pending = supabaseFetch(`${probe}/slow`, { signal: controller.signal }).catch((e) => e);
  controller.abort();
  await pending;
  check("a caller's own abort raises no database error", errors.length === 0, JSON.stringify(errors));
  check("a caller's own abort leaves the breaker closed", !supabaseCircuitOpen());

  const started = Date.now();
  let aborted = null;
  try {
    await supabaseFetch(`${probe}/slow`);
  } catch (error) {
    aborted = error;
  }
  const took = Date.now() - started;

  check("a request that never answers is abandoned", Boolean(aborted), "no error was thrown");
  check(`it is abandoned at the deadline, not later (${took}ms)`, took < 3_000, `waited ${took}ms`);
  check(
    "the abandonment is logged, because these reads fail soft",
    errors.some((line) => line.includes("[supabase]") && line.includes("/slow") && line.includes("1200ms")),
    JSON.stringify(errors),
  );
  check("the log line names the path, never the query string or the key", !errors.join(" ").includes("apikey"));

  /* ---------- the breaker ---------- */

  check("the abandonment opened the breaker", supabaseCircuitOpen());

  /**
   * The measurement that matters, and the reason this exists: a page makes six
   * more reads after the first one fails, and none of them may spend a deadline.
   */
  const refusedFrom = attempts;
  errors.length = 0;
  const refusals = [];
  for (let i = 0; i < 6; i += 1) {
    const t = Date.now();
    await supabaseFetch(`${probe}/slow`).catch((e) => refusals.push(e));
    refusals[refusals.length - 1].ms = Date.now() - t;
  }
  check("the following reads are refused, not attempted", attempts === refusedFrom, `${attempts - refusedFrom} reached the origin`);
  check(
    `and they fail without waiting (slowest ${Math.max(...refusals.map((r) => r.ms))}ms)`,
    refusals.every((r) => r.ms < 100),
  );
  check(
    "the refusal names the mechanism, so a reader can tell it from a timeout",
    refusals.every((r) => r.name === "SupabaseUnavailableError"),
    refusals.map((r) => r.name).join(","),
  );
  check("six refusals write one log line, not six", errors.length === 1, JSON.stringify(errors));

  /** The breaker closes on its own, or one bad minute would take the site down for the rest of the instance's life. */
  await new Promise((resolve) => setTimeout(resolve, supabaseBreakerMs() + 150));
  check("the breaker closes after its cooldown", !supabaseCircuitOpen());
  const after = attempts;
  const recovered = await supabaseFetch(`${probe}/fast`);
  check("and a request is attempted again", attempts === after + 1 && (await recovered.text()) === "now");

  console.error = realError;
  server.close();
  counting.close();

  /* ---------- one attempt, not four ---------- */

  /**
   * The measurement that made this rule necessary. supabase-js retries a failed
   * GET three times with exponential backoff, so the first version of this
   * deadline was honoured four times over: a live read against the outage on
   * 2026-09-23 that should have failed in ten seconds failed in forty-seven.
   * This client is pointed at the same slow origin as the tests above, with the
   * options the four real clients now set, and the whole call must end inside
   * twice the deadline.
   */
  const { createClient } = require("@supabase/supabase-js");

  const slowServer = http.createServer((_req, res) => setTimeout(() => res.end("late"), 8_000));
  await new Promise((resolve) => slowServer.listen(0, "127.0.0.1", resolve));
  process.env.SUPABASE_TIMEOUT_MS = "1200";
  const sb = createClient(`http://127.0.0.1:${slowServer.address().port}`, "anon", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: supabaseFetch },
    db: { retry: false },
  });
  const quiet = console.error;
  console.error = () => {};
  const t = Date.now();
  const { error } = await sb.from("events").select("id").limit(1);
  console.error = quiet;
  const elapsed = Date.now() - t;
  slowServer.close();
  check("one aborted read is one attempt, not four", elapsed < 2_400, `took ${elapsed}ms`);
  check("the read reports the failure to its caller", Boolean(error));

  /* ---------- the deadline's own bounds ---------- */

  check("an open breaker is reported as open", typeof supabaseCircuitOpen() === "boolean");
  const breakerCases = [
    [undefined, 30_000, "with no env value, the breaker default stands"],
    ["5000", 5_000, "a shorter cooldown is honoured"],
    ["-1", 30_000, "a negative cooldown is not a cooldown"],
  ];
  for (const [value, expected, name] of breakerCases) {
    if (value === undefined) delete process.env.SUPABASE_BREAKER_MS;
    else process.env.SUPABASE_BREAKER_MS = value;
    check(`${name} (${value ?? "unset"} -> ${supabaseBreakerMs()})`, supabaseBreakerMs() === expected);
  }
  delete process.env.SUPABASE_BREAKER_MS;

  const cases = [
    [undefined, 8_000, "with no env value, the default stands"],
    ["10000", 10_000, "the old ten second default is still inside the maximum"],
    ["25000", 25_000, "a sane override is used as given"],
    ["1", 1_000, "a deadline below a second is raised to one, not honoured"],
    ["0", 8_000, "zero is not a deadline, so the default stands"],
    ["-5", 8_000, "a negative deadline is not a deadline either"],
    ["not-a-number", 8_000, "nonsense falls back to the default"],
    ["999999", 60_000, "an hour-long deadline is cut to the maximum"],
  ];
  for (const [value, expected, name] of cases) {
    if (value === undefined) delete process.env.SUPABASE_TIMEOUT_MS;
    else process.env.SUPABASE_TIMEOUT_MS = value;
    check(`${name} (${value ?? "unset"} -> ${supabaseTimeoutMs()})`, supabaseTimeoutMs() === expected);
  }
  delete process.env.SUPABASE_TIMEOUT_MS;

  /**
   * The budget rule the 504 taught. A page spends its deadline once and then
   * renders, and the render has to finish before the platform kills the
   * function — ten seconds is the shortest wall this project could plausibly be
   * on, so the deadline plus a couple of seconds of rendering must fit inside it.
   */
  const renderAllowance = 2_000;
  check(
    `the page budget (${supabaseTimeoutMs()}ms + ${renderAllowance}ms) fits a ten second function wall`,
    supabaseTimeoutMs() + renderAllowance <= 10_000,
  );
  check("the breaker cooldown is longer than one page render", supabaseBreakerMs() >= supabaseTimeoutMs());

  /* ---------- wiring ---------- */

  const clients = [
    "lib/supabase/index.ts",
    "lib/supabase/server.ts",
    "lib/supabase/client.ts",
    "lib/supabase/bearer.ts",
  ];
  for (const rel of clients) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    check(`${rel} imports the deadline fetch`, /from "\.\/deadline"/.test(src));
    check(`${rel} passes it to the client`, /fetch:\s*supabaseFetch/.test(src));
    check(`${rel} turns the client's own retries off`, /retry:\s*false/.test(src));
  }

  /**
   * The health route has to report the deadline that is actually enforced, so it
   * reads the same function rather than naming a number of its own.
   */
  const health = fs.readFileSync(path.join(root, "app", "api", "health", "route.ts"), "utf8");
  check("the health route reports the enforced deadline", /supabaseTimeoutMs\(\)/.test(health));
  check(
    "the health route cannot claim health while the database is gone",
    /database: "unreachable"/.test(health) && /status: 503/.test(health),
  );

  /* ---------- the surface it added ---------- */

  const surfaces = JSON.parse(fs.readFileSync(path.join(root, "lib", "surfaces.json"), "utf8"));
  check(
    "/api/health is a listed surface, so the probe covers it",
    surfaces.endpoints.some((e) => e.path === "/api/health"),
  );

  console.log(
    `\n${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}: the deadline is wired and enforced.`,
  );
  process.exit(failures === 0 ? 0 : 1);
})();
