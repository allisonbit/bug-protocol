#!/usr/bin/env node
/**
 * Probe every surface the site claims to serve.
 *
 * /everything renders lib/surfaces.json, and this script reads the SAME file and
 * asks the running site for each entry. So a page cannot be listed and 404 in
 * production without this failing, which is the only reason the index is worth
 * having: a hand maintained list of a site's own pages drifts, and an index that
 * lies about what exists is worse than no index.
 *
 * A surface "exists" if it answers at all. 200 is fine. So is 401/403 (there, but
 * guarded), 405 (there, wrong method: most agent endpoints are POST only) and 400
 * (there, request was wrong). A 404 is a real failure: it is the site saying
 * nobody is here, which is exactly the failure the agent card once was.
 *
 * Usage:
 *   node scripts/verify-surfaces.cjs                 # against http://localhost:3000
 *   node scripts/verify-surfaces.cjs https://www.swampai.world
 */
const fs = require("node:fs");
const path = require("node:path");

const base = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const surfaces = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "lib", "surfaces.json"), "utf8"));

const PAGE_OK = new Set([200, 301, 302, 307, 308]);
const GUARDED = new Set([400, 401, 403, 405, 422]);

async function probe(url, needBody = false) {
  try {
    const res = await fetch(url, { redirect: "manual", headers: { "user-agent": "swamp-surface-probe" } });
    return { status: res.status, body: needBody ? await res.text().catch(() => "") : "" };
  } catch (e) {
    return { status: `ERR ${e.message}`, body: "" };
  }
}

(async () => {
  const targets = [];
  for (const p of surfaces.pages) {
    if (p.path.includes("[") && !p.sample) continue;
    targets.push({ url: p.sample || p.path, kind: "page", label: p.path });
  }
  for (const e of surfaces.endpoints) {
    if (e.path.includes("[")) continue;
    targets.push({ url: e.path, kind: "endpoint", label: e.path, conditional: e.conditional || null });
  }
  // Templates with a real example in the file: probe those too.
  for (const p of surfaces.pages) {
    if (p.path.includes("[") && p.sample) targets.push({ url: p.sample, kind: "template", label: p.path });
  }

  let failed = 0;
  let guarded = 0;
  let conditional = 0;
  for (const t of targets) {
    const { status, body } = await probe(base + t.url, Boolean(t.conditional));
    // A conditional surface is one that deliberately refuses to answer until an
    // operator configures it. That is not a pass and not a failure, and the two
    // are distinguishable without trusting the status code: the route says WHY
    // it is refusing, so a 404 that does not carry the documented reason is still
    // a real failure. Otherwise "expected 404" would quietly hide the bug it is
    // there to catch.
    const refusedForTheRightReason =
      status === 404 && t.conditional && /no registry proof is configured/i.test(body);
    if (refusedForTheRightReason) conditional += 1;
    const ok = refusedForTheRightReason || (typeof status === "number" && (PAGE_OK.has(status) || GUARDED.has(status)));
    if (typeof status === "number" && GUARDED.has(status)) guarded += 1;
    if (!ok) failed += 1;
    const verdict = refusedForTheRightReason ? "cond" : ok ? "ok  " : "FAIL";
    const suffix = refusedForTheRightReason ? `  (waiting on ${t.conditional})` : "";
    console.log(`${verdict} ${String(status).padEnd(4)} ${t.kind.padEnd(8)} ${t.url}${suffix}`);
  }

  console.log(
    `\n${targets.length} surfaces probed against ${base}: ${targets.length - failed} answered, ` +
      `${guarded} guarded (401/403/405 etc), ${conditional} conditional, ${failed} failed.`,
  );
  process.exit(failed === 0 ? 0 : 1);
})();
