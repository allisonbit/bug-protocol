/**
 * Run one orchestrator tick.
 *
 * The deployed tick is reachable only through /api/orchestrator/tick, guarded by
 * CRON_SECRET, which lives in Vercel as a Secret and cannot be read back. Vercel
 * Cron drives it daily; this exists so an operator can run one now and see what
 * it does, the same reason scripts/run-pulse.cjs exists.
 *
 * It imports the ROUTE and calls its handler, so this is the deployed code path
 * rather than a reimplementation that could drift from it.
 *
 *   PGPASSWORD=... node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/run-tick.cjs
 */
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("node:url");

// Load .env.local into process.env BEFORE the route is imported. Next does this
// for you; plain Node does not, and the route reads process.env directly, so
// without it the handler answers "backend not configured" and runs nothing.
for (const line of fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

(async () => {
  const routePath = path.join(process.cwd(), "app", "api", "orchestrator", "tick", "route.ts");
  const mod = await import(pathToFileURL(routePath).href);

  const req = new Request("http://localhost/api/orchestrator/tick", {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` },
  });

  const res = await mod.GET(req);
  const body = await res.json();
  console.log("status:", res.status);
  console.log(JSON.stringify(body, null, 2).slice(0, 1200));
})().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
