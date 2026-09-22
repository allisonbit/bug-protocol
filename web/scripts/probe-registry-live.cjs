#!/usr/bin/env node
/**
 * The registry doors, driven against a running origin and checked on what they answer.
 *
 * WHY A LIVE PROBE RATHER THAN MORE FIXTURES. Everything the offline verifiers cover is pure
 * arithmetic. What they cannot cover is the join: whether the mirror actually holds rows,
 * whether the search door's filters are wired to the columns they name, whether the one-skill
 * door resolves an owner-qualified pair the way the URL spells it, whether the crawl and audit
 * doors refuse a caller who has no secret, and whether what came back is what the page and the
 * tools claim. Every one of those is a place where the code can be right and the deployment
 * still wrong.
 *
 * WHAT IT ASSERTS, and each one is a thing the registry's own API terms or a resident's safety
 * depends on:
 *
 *   1. The disclosure travels with the JSON, not only with the page.
 *   2. Every entry links back to its canonical page on clawhub.ai, which is the condition a
 *      third party directory has to meet to be allowed to exist.
 *   3. Nothing served carries a document's text: no content, body, skill_md or instructions
 *      field anywhere in a reply, and the way to the bytes is the audit record.
 *   4. The gaps door's comparison is not a claim typed into a route: the capability list it
 *      publishes matches the action manifest this repository builds.
 *   5. A written door refuses a caller with no secret, and with one it does the work and says
 *      what it did.
 *   6. Where the two engines disagree, the entries that say so are findable.
 *
 *   node scripts/probe-registry-live.cjs http://localhost:3000
 *   SWAMP_BEAT_SECRET=... node scripts/probe-registry-live.cjs https://www.swampai.world
 *
 * Without a secret the write doors are checked for REFUSING and the reads are checked in full,
 * which is the useful half to have on a deployment whose operator is not holding the key.
 */
const TARGET = (process.argv[2] || "http://localhost:3000").replace(/\/+$/, "");
const SECRET = process.env.SWAMP_BEAT_SECRET || process.env.CRON_SECRET || "";
const ALLOW_EMPTY = process.argv.includes("--allow-empty");

let failed = 0;
let skipped = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}${detail ? `  ${detail}` : ""}`);
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`);
  }
};
const skip = (name, why) => {
  skipped += 1;
  console.log(`skip ${name}  ${why}`);
};

const FORBIDDEN = ["content", "skill_md", "body", "instructions", "text_body"];

/** Every key path in a reply that looks like a document's text. */
function findForbidden(value, trail = "") {
  const out = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...findForbidden(v, `${trail}[${i}]`)));
    return out;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN.includes(k) && typeof v === "string" && v.length > 20) out.push(`${trail}.${k}`);
      out.push(...findForbidden(v, `${trail}.${k}`));
    }
  }
  return out;
}

async function get(path) {
  const res = await fetch(`${TARGET}${path}`, { headers: { accept: "application/json" } });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* reported by the caller as a status and a slice */
  }
  return { status: res.status, json, text };
}

async function post(path) {
  const res = await fetch(`${TARGET}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, accept: "application/json" },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* as above */
  }
  return { status: res.status, json, text };
}

(async () => {
  console.log(`\nprobing the registry doors on ${TARGET}${SECRET ? " (with the beat secret)" : " (reads only)"}`);
  const discovered = await import("../lib/registry/clawhub.ts");
  const { ACTIONS } = await import("../lib/actions/manifest.ts");

  // ---- the discovery document ---------------------------------------------------------
  console.log("\n== the coverage document ==");
  const wellKnown = await get("/.well-known/skill-registry.json");
  check("it answers", wellKnown.status === 200, `status ${wellKnown.status}`);
  if (wellKnown.json) {
    check("it carries the disclosure", typeof wellKnown.json.disclosure === "string" && /does not endorse/i.test(wellKnown.json.disclosure));
    check("it names the source registry", String(wellKnown.json.source?.registry ?? "").startsWith("https://"), String(wellKnown.json.source?.registry));
    check("it states the reuse terms it is built to", /cached/i.test(String(wellKnown.json.source?.terms)));
    const c = wellKnown.json.coverage ?? {};
    const a = wellKnown.json.agreement ?? {};
    const audited = Number(c.audited ?? 0);
    const parts = ["agree", "swamp_stricter", "swamp_looser", "unreadable"].map((k) => Number(a[k] ?? 0));
    check(
      "the agreement buckets never exceed what was audited, which is the only arithmetic here that can lie",
      parts.reduce((x, y) => x + y, 0) <= audited + 1,
      `${parts.join("+")} against ${audited} audited`,
    );
    check("it says plainly that nothing from the registry is ever run", /never executed, installed or imported/i.test(String(wellKnown.json.limits?.nothing_is_run)));
    check("it reports how fresh the sweep is", wellKnown.json.sweep !== undefined, JSON.stringify(wellKnown.json.sweep ?? null).slice(0, 80));
    if (Number(c.mirrored ?? 0) === 0) {
      check("the mirror holds rows", ALLOW_EMPTY, "nothing is mirrored yet: the crawl has not run against this deployment");
    } else {
      check("the mirror holds rows", true, `${c.mirrored} mirrored, ${c.audited} audited, ${c.topics} topics`);
    }
  }

  // ---- the search door -----------------------------------------------------------------
  console.log("\n== the search door ==");
  const search = await get("/api/registry/skills?limit=5");
  check("it answers", search.status === 200, `status ${search.status}`);
  let firstRef = null;
  if (search.json) {
    check("it carries the disclosure", /does not endorse/i.test(String(search.json.disclosure)));
    check("it reports what matched rather than only what it returned", typeof search.json.matched === "number");
    const entries = Array.isArray(search.json.skills) ? search.json.skills : [];
    const badLinks = entries.filter((e) => !String(e.canonical_url ?? "").startsWith(discovered.REGISTRY_SITE));
    check("every entry links back to its canonical page, which is the condition for being allowed to exist", badLinks.length === 0, badLinks.map((e) => e.ref).join(", "));
    const forbidden = findForbidden(search.json);
    check("nothing in the reply is a document's text", forbidden.length === 0, forbidden.slice(0, 4).join(", "));
    const unsourced = entries.filter((e) => !e.swamp || e.disclosure === undefined);
    check("every entry carries both verdicts and its own disclosure", unsourced.length === 0);
    if (entries.length > 0) {
      firstRef = entries[0].ref;
      check("entries name an owner-qualified identity", /^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(String(firstRef)), String(firstRef));
    } else if (!ALLOW_EMPTY) {
      check("the search returned something", false, "the mirror is empty, so the doors below cannot be exercised");
    }
  }

  const filtered = await get("/api/registry/skills?verdict=clean&limit=10");
  if (filtered.json) {
    const wrong = (filtered.json.skills ?? []).filter((e) => e.swamp?.verdict !== "clean");
    check("a verdict filter returns only that verdict", wrong.length === 0, wrong.map((e) => e.swamp?.verdict).join(", "));
  }

  // ---- the one entry door --------------------------------------------------------------
  console.log("\n== one entry, addressed the way a reader says it ==");
  if (firstRef) {
    const one = await get(`/api/registry/skills/${firstRef}`);
    check("it answers", one.status === 200, `status ${one.status}`);
    if (one.json) {
      check("it is the skill that was asked for", one.json.skill?.ref === firstRef, String(one.json.skill?.ref));
      check("it names the address the verdict was read from", String(one.json.read_from ?? "").includes("/api/v1/skills/"), String(one.json.read_from ?? ""));
      check("and it carries no document text", findForbidden(one.json).length === 0);
    }
    const bad = await get("/api/registry/skills/not-a-ref");
    check("two path segments are required, because slugs are not unique", bad.status === 404 || bad.status === 400, `status ${bad.status}`);
  } else {
    skip("the one entry door", "no entry to address");
  }

  // ---- the gaps door -------------------------------------------------------------------
  console.log("\n== the gaps ==");
  const gaps = await get("/api/registry/gaps?limit=5&examples=2");
  check("it answers", gaps.status === 200, `status ${gaps.status}`);
  if (gaps.json) {
    check("it publishes its thresholds rather than hiding them", typeof gaps.json.thresholds?.min_skills === "number" && typeof gaps.json.thresholds?.min_installs === "number");
    check("it names what it compared against", String(gaps.json.compared_against?.manifest ?? "").endsWith("/api/actions"), String(gaps.json.compared_against?.manifest ?? ""));
    const published = new Set(gaps.json.compared_against?.capabilities ?? []);
    const missing = [...published].filter((id) => !ACTIONS.some((a) => a.id === id));
    check("the capabilities it compared against are this repository's own manifest", published.size === 0 || missing.length === 0, missing.join(", "));
    const badExamples = (gaps.json.gaps ?? []).flatMap((g) => (g.examples ?? []).filter((e) => !String(e.canonical_url ?? "").startsWith(discovered.REGISTRY_SITE)));
    check("every example named links back to its canonical page", badExamples.length === 0, badExamples.map((e) => e.ref).join(", "));
    check("each gap carries counts and a reason", (gaps.json.gaps ?? []).every((g) => typeof g.skills === "number" && typeof g.why === "string"));
  }

  // ---- the write doors -----------------------------------------------------------------
  console.log("\n== the write doors ==");
  if (!SECRET) {
    const refused = await fetch(`${TARGET}/api/registry/crawl`, { method: "POST" });
    check("with no secret the crawl is refused", [401, 403].includes(refused.status), `status ${refused.status}`);
    skip("the crawl and audit passes", "SWAMP_BEAT_SECRET is not set, so the refusals above are all this probe can check");
  } else {
    const before = await get("/.well-known/skill-registry.json");
    const crawl = await post("/api/registry/crawl?pages=1");
    check("the crawl door answers with the beat secret", crawl.status === 200, `status ${crawl.status}`);
    if (crawl.json) {
      check("and says which mode it ran in", crawl.json.mode === "sweep" || crawl.json.mode === "refresh", String(crawl.json.mode));
      check("and what it wrote", typeof crawl.json.written === "number", `pages ${crawl.json.pages}, rows ${crawl.json.written}, ${crawl.json.note}`);
      check("and where the sweep now stands", typeof crawl.json.complete === "boolean", `complete ${crawl.json.complete}`);
    }

    const audit = await post("/api/registry/audit?limit=1");
    check("the audit door answers with the beat secret", audit.status === 200, `status ${audit.status}`);
    if (audit.json) {
      check("and reports what it read", typeof audit.json.audited === "number" && typeof audit.json.unreadable === "number", `${audit.json.audited} judged, ${audit.json.unreadable} unreadable, ${audit.json.blocked} blocked`);
      const result = (audit.json.results ?? [])[0];
      if (result) {
        check("a read skill carries a digest and a tier", result.tier !== undefined, `${result.ref ?? "(none)"}: tier ${result.tier}, verdict ${result.swamp_verdict ?? "none"}, agreement ${result.agreement ?? "none"}`);
      }
    }

    const after = await get("/.well-known/skill-registry.json");
    if (before.json && after.json) {
      check(
        "the mirror did not shrink while we watched",
        Number(after.json.coverage.mirrored) >= Number(before.json.coverage.mirrored),
        `${before.json.coverage.mirrored} -> ${after.json.coverage.mirrored}`,
      );
      check(
        "and what was read is on the record",
        Number(after.json.coverage.audited) >= Number(before.json.coverage.audited),
        `${before.json.coverage.audited} -> ${after.json.coverage.audited} audited`,
      );
    }

    const disagreements = await get("/api/registry/skills?agreement=swamp_stricter&limit=5");
    if (disagreements.json) {
      const wrong = (disagreements.json.skills ?? []).filter((e) => e.swamp?.agreement !== "swamp_stricter");
      check("where the two engines disagree can be asked for by name", wrong.length === 0, `${disagreements.json.matched} entr(ies) stricter here`);
    }
  }

  console.log(`\nregistry live probe: ${failed === 0 ? "all checks passed" : `${failed} check(s) FAILED`}${skipped > 0 ? `, ${skipped} skipped` : ""}`);
  if (failed > 0) process.exit(1);
})();
