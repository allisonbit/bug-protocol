#!/usr/bin/env node
/**
 * The mirror of somebody else's registry: what it writes, what it refuses, and where it says
 * the two engines disagree.
 *
 * WHY THIS FILE EXISTS. Every branch here is quiet when it is wrong, and four of them are
 * expensive. A projection that turns an absent install count into zero invents a fact about
 * somebody else's registry. A page that loses its cursor silently stops the sweep at a
 * boundary nobody notices, so the mirror looks smaller than the registry and nothing says so.
 * An agreement mapping that ranks the two vocabularies by position compares a five point
 * scale to a three point one and reports disagreement where there is none. And a ref that
 * parses when it should not becomes a path segment in a URL this deployment then fetches.
 *
 * WHAT IT PINS, in the order the crawl walks them:
 *
 *   1. The addresses. Owner qualification (because slugs are not unique), the file route with
 *      its preview flag, the canonical page a reader is sent to, and a traversal attempt.
 *   2. The projection. Absent values stay absent, a zero timestamp is not 1970, topics are
 *      deduped case-insensitively and bounded, and an item with no address is refused and
 *      counted rather than forced into a row.
 *   3. The page. The cursor survives, an oversized cursor is dropped rather than stored, and
 *      refusals are counted.
 *   4. The verdicts. ClawHub's moderation block, absent for an ordinary clean skill and
 *      therefore reported as null rather than as clean, and the agreement mapping between two
 *      differently shaped scales.
 *   5. The rate limit. Both header families, both readings of Retry-After, and the cap.
 *   6. The plan a pass makes. Which of the two modes it runs, and the one distinction that
 *      cost a live sweep its progress: a forced re-walk drops the cursor on its FIRST pass
 *      and resumes after that. Dropping it on every pass made each pass re-read the same
 *      first pages, so the mirror stopped growing while every pass reported rows written.
 *
 * PURE. No network, no database: fixtures in, answers out.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-registry-mirror.cjs
 */
(async () => {
  const reg = await import("../lib/registry/clawhub.ts");
  const crawl = await import("../lib/registry/crawl.ts");

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`ok   ${name}`);
    else {
      failed += 1;
      console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`);
    }
  };

  // ---- 1. the addresses ---------------------------------------------------------------
  console.log("\n== the addresses ==");
  check("a ref is owner qualified, because slugs are not unique in this registry", reg.parseRef("steipete/gifgrep") !== null);
  check("and a bare slug is refused rather than guessed", reg.parseRef("gifgrep") === null, "a bare slug would be fetched with no owner and answered 409");
  check("a ref with a traversal in it is refused", reg.parseRef("../../etc/passwd") === null);
  check("an absolute url is not a ref", reg.parseRef("https://clawhub.ai/x/y") === null);
  check("a control character is refused", reg.parseRef("a\nb/c") === null);
  check("case is normalized so one skill is one row", reg.refOf("Steipete", "GifGrep") === "steipete/gifgrep");

  const file = reg.fileUrl("steipete/gifgrep");
  check("the file route is the registry's own", file.startsWith(`${reg.REGISTRY_API}/api/v1/skills/gifgrep/file?`), file);
  check("it asks for the bounded text preview rather than the raw download", file.includes("preview=1"));
  check("and it is owner qualified", file.includes("owner=steipete"));
  check("a ref that does not parse yields no url at all", reg.fileUrl("nope") === "", "an empty string is a refusal a caller can branch on");
  check(
    "the canonical page is the registry's site rather than its api",
    reg.canonicalUrl("steipete/gifgrep") === `${reg.REGISTRY_SITE}/steipete/skills/gifgrep`,
    reg.canonicalUrl("steipete/gifgrep"),
  );
  const catalogue = reg.catalogueUrl({ sort: "createdAt", limit: 500, cursor: "abc" });
  check("a page size above the maximum is clamped rather than sent", catalogue.includes("limit=200") === false ? false : true);
  check("the page asks for a size the api serves", catalogue.includes(`limit=${reg.MAX_PAGE}`), catalogue);
  check("and carries the cursor", catalogue.includes("cursor=abc"));
  check("an unknown sort falls back to the documented crawl order", reg.catalogueUrl({ sort: "nonsense" }).includes("sort=createdAt"));

  // ---- 2. the projection --------------------------------------------------------------
  console.log("\n== the projection ==");
  const full = {
    ownerHandle: "Steipete",
    slug: "GifGrep",
    displayName: "GifGrep",
    summary: "  Find gifs.  ",
    topics: ["Productivity", "productivity", "", "  "],
    tags: { latest: "1.2.3" },
    stats: { downloads: 764, installs: 17, stars: 4 },
    createdAt: 1767632598365,
    updatedAt: 0,
    latestVersion: { version: "1.2.3", createdAt: 1767632598365 },
  };
  const row = reg.projectItem(full);
  check("a full item projects to one row", row !== null && row.ref === "steipete/gifgrep", JSON.stringify(row));
  check("its summary is trimmed", row.summary === "Find gifs.");
  check("topics are deduped case insensitively", row.topics.join(",") === "Productivity", row.topics.join(","));
  check("a zero timestamp is absent rather than 1970", row.registry_updated_at === null, String(row.registry_updated_at));
  check("a real timestamp is kept", row.registry_created_at === new Date(1767632598365).toISOString());
  check("the install count is carried", row.stats.installs === 17);
  check("and absent stats are omitted rather than zeroed", reg.projectItem({ ...full, stats: {} }).stats.installs === undefined);
  check("an item with no owner is refused", reg.projectItem({ slug: "x" }) === null);
  check("an item whose slug breaks the naming grammar is refused", reg.projectItem({ ownerHandle: "a", slug: "has space" }) === null);
  check("a non object is refused", reg.projectItem("nope") === null);
  check("and every projected row carries its canonical page", row.canonical_url === `${reg.REGISTRY_SITE}/steipete/skills/gifgrep`);

  const page = reg.projectCataloguePage({ items: [full, { slug: "bad" }, null], nextCursor: "cur-1" });
  check("a page projects what it can", page.rows.length === 1);
  check("and counts what it refused", page.refused === 2, String(page.refused));
  check("the cursor is carried", page.nextCursor === "cur-1");
  check("a missing items array is an empty page rather than a crash", reg.projectCataloguePage({}).rows.length === 0);
  check("an oversized cursor is dropped rather than stored", reg.projectCataloguePage({ items: [], nextCursor: "x".repeat(5000) }).nextCursor === null);

  // ---- 3. clawhub's own verdict -------------------------------------------------------
  console.log("\n== clawhub's own moderation ==");
  check("an ordinary skill arrives with no moderation block", reg.moderationOf({ skill: {} }).verdict === null);
  check("and that is reported as absent, not as clean", reg.moderationOf({ skill: {} }).verdict !== "clean");
  const flagged = reg.moderationOf({ moderation: { verdict: "suspicious", reasonCodes: ["suspicious.dynamic_code_execution"], isSuspicious: true } });
  check("a flagged skill is read as flagged", flagged.verdict === "suspicious", String(flagged.verdict));
  check("with its reason codes", flagged.reasonCodes.length === 1);
  const blocked = reg.moderationOf({ moderation: { verdict: "clean", isMalwareBlocked: true } });
  check("a malware block wins over whatever the verdict field says", blocked.verdict === "blocked" && blocked.blocked === true);
  check("an unknown verdict string is not invented into a known one", reg.moderationOf({ moderation: { verdict: "who-knows" } }).verdict === null);

  console.log("\n== where the two engines disagree ==");
  check("the same verdict agrees", reg.agreementOf({ clawhub: "clean", swamp: "clean" }) === "agree");
  check("our notes against their clean is stricter here", reg.agreementOf({ clawhub: "clean", swamp: "notes" }) === "swamp_stricter");
  check("our clean against their suspicious is looser here", reg.agreementOf({ clawhub: "suspicious", swamp: "clean" }) === "swamp_looser");
  check("our risky against their suspicious agrees, because they mean the same thing", reg.agreementOf({ clawhub: "suspicious", swamp: "risky" }) === "agree");
  check("our caution against their suspicious is looser", reg.agreementOf({ clawhub: "suspicious", swamp: "caution" }) === "swamp_looser");
  check("an unreadable document answers unreadable rather than agreeing", reg.agreementOf({ clawhub: "clean", swamp: null, readable: false }) === "unreadable");
  check("and unreadable survives even when we have no verdict to compare", reg.agreementOf({ clawhub: null, swamp: null, readable: false }) === "unreadable");
  check("nothing published by the registry leaves our verdict unpaired", reg.agreementOf({ clawhub: null, swamp: "clean" }) === null);
  check("nothing audited here leaves it unpaired too", reg.agreementOf({ clawhub: "clean", swamp: null }) === null);

  // ---- 4. being told to stop ----------------------------------------------------------
  console.log("\n== the rate limit ==");
  const h = (map) => ({ get: (k) => map[k.toLowerCase()] ?? null });
  const now = 1_790_000_000_000;
  check("Retry-After in seconds is read", reg.retryAfterMs(h({ "retry-after": "34" }), now) === 34_000);
  check("Retry-After as an HTTP date is read", reg.retryAfterMs(h({ "retry-after": new Date(now + 5_000).toUTCString() }), now) <= 5_000);
  check("RateLimit-Reset is a delay in seconds", reg.retryAfterMs(h({ "ratelimit-reset": "34" }), now) === 34_000);
  check("X-RateLimit-Reset is an absolute epoch in seconds", reg.retryAfterMs(h({ "x-ratelimit-reset": String(Math.floor(now / 1000) + 34) }), now) <= 34_000);
  check("an absurd wait is capped", reg.retryAfterMs(h({ "retry-after": "999999" }), now) === 15 * 60 * 1000);
  check("and no headers means no answer rather than a guess", reg.retryAfterMs(h({}), now) === null);

  console.log("\n== the plan a pass makes ==");
  const walking = { complete: false, cursor: "cur" };
  const done = { complete: true, cursor: "cur" };
  check("a first walk continues from the stored cursor", crawl.sweepPlan(walking).cursor === "cur" && crawl.sweepPlan(walking).mode === "sweep");
  check("a forced first walk still continues rather than restarting", crawl.sweepPlan(walking, { force: true }).cursor === "cur" && crawl.sweepPlan(walking, { force: true }).restart === false, "resetting here is what froze a live sweep at its first four pages");
  check("a forced walk of a finished catalogue starts over", crawl.sweepPlan(done, { force: true }).cursor === null && crawl.sweepPlan(done, { force: true }).restart === true);
  check("a finished catalogue without force refreshes instead", crawl.sweepPlan(done).mode === "refresh" && crawl.sweepPlan(done).cursor === null);
  check("a refresh never resumes a sweep cursor", crawl.sweepPlan(done, { force: false }).cursor === null);
  check("a queued restart reports itself as a restart", crawl.sweepPlan(done, { force: true }).mode === "sweep");

  // ---- 7. the migration's own statements ----------------------------------------------
  // A live pass found this one: the topic rollup emptied its table with an unqualified
  // `delete from`, which Postgres refuses outright ("DELETE requires a WHERE clause"), so
  // every crawl pass reported a rollup failure after writing its rows. The rule is worth a
  // check rather than a comment: this migration is rebuilt-from-scratch by design, and the
  // next person to write a delete here should have to write `where` deliberately.
  console.log("\n== the migration's statements ==");
  const fs = require("fs");
  const path = require("path");
  const sql = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrate-skill-registry.sql"), "utf8");
  const bareDeletes = sql
    .split("\n")
    .filter((line) => /^\s*delete\s+from\s+[\w."]+\s*;\s*$/i.test(line))
    .map((line) => line.trim());
  check("every delete in the migration states what it deletes", bareDeletes.length === 0, bareDeletes.join(" | "));
  check("the rollup is a rebuild, so it says so explicitly", /delete from public\.skill_registry_topics where true;/i.test(sql));
  check("the upsert never touches a verdict, so a crawl cannot clear an audit", /on conflict \(ref\) do update set/.test(sql) && !/swamp_verdict\s*=\s*excluded/.test(sql));

  // ---- 8. reading the sweep state never writes it ---------------------------------------
  // The defect a live pass exposed, and the reason this section exists: the read path used
  // to seed the state row when it found none, and a failed read is indistinguishable from an
  // absent row through a REST client. One transient error would upsert `cursor: null` and
  // restart the walk from the top while the mirror kept every row it had collected, with
  // nothing anywhere saying the cursor had gone backwards. So: a read reads, and a failed
  // read is raised rather than turned into a fabricated empty state.
  console.log("\n== reading the sweep state ==");
  const stubClient = (answer) => {
    const calls = { upserts: 0, selects: 0 };
    const rows = Array.isArray(answer) ? [...answer] : [answer];
    const client = {
      calls,
      from() {
        return {
          select() {
            calls.selects += 1;
            return {
              eq: () => ({ maybeSingle: async () => rows.shift() ?? { data: null, error: null } }),
            };
          },
          async upsert(row, options) {
            calls.upserts += 1;
            calls.lastUpsert = { row, options };
            return { data: null, error: null };
          },
        };
      },
    };
    return client;
  };

  const stored = {
    id: "crawl",
    sort: "createdAt",
    cursor: "cur-9",
    pages_seen: 65,
    skills_seen: 12748,
    sweeps: 0,
    complete: false,
    newest_created_at: null,
    started_at: "2026-09-22T00:00:00.000Z",
    last_run_at: null,
    last_error: null,
    updated_at: "2026-09-22T00:00:00.000Z",
  };

  const held = stubClient({ data: stored, error: null });
  const read = await crawl.readRegistryState(held);
  check("a stored state is returned as it stands", read.cursor === "cur-9" && read.pages_seen === 65);
  check("and reading it writes nothing", held.calls.upserts === 0, `${held.calls.upserts} write(s) on a read path`);

  const missing = stubClient({ data: null, error: null });
  check("an absent row reads as null rather than as an empty state", (await crawl.readRegistryState(missing)) === null);
  check("and that reads as nothing written too", missing.calls.upserts === 0);

  const broken = stubClient([
    { data: null, error: { message: "connection closed" } },
    { data: null, error: { message: "connection closed" } },
  ]);
  let raised = null;
  try {
    await crawl.readRegistryState(broken);
  } catch (e) {
    raised = e.message;
  }
  check("a failed read is raised rather than reported as an absent row", typeof raised === "string" && /could not be read/.test(raised), String(raised));
  check("a failed read is tried twice before it is raised", broken.calls.selects === 2, `${broken.calls.selects} attempt(s)`);
  check("and a failed read still writes nothing", broken.calls.upserts === 0, "this is the one that restarted a walk");

  const fresh = stubClient([{ data: null, error: null }, { data: null, error: null }]);
  const seeded = await crawl.ensureRegistryState(fresh);
  check("the writer seeds a state a deployment has never had", seeded.cursor === null && seeded.complete === false && seed_written(fresh));
  check("and the seeded row cannot clobber one that already exists", fresh.calls.lastUpsert?.options?.ignoreDuplicates === true);

  function seed_written(client) {
    return client.calls.upserts === 1 && client.calls.lastUpsert?.row?.id === "crawl";
  }

  const existing = stubClient({ data: stored, error: null });
  const kept = await crawl.ensureRegistryState(existing);
  check("the writer leaves an existing state exactly as it is", kept.cursor === "cur-9" && existing.calls.upserts === 0);

  console.log("\n== what travels with every entry ==");
  check("the disclosure names the registry's position", /does not endorse/i.test(reg.REGISTRY_DISCLOSURE), reg.REGISTRY_DISCLOSURE);
  check("and says a listing is not a recommendation", /not a recommendation/i.test(reg.REGISTRY_DISCLOSURE));
  check("an entry is named by its publisher and its slug", reg.attributionOf({ owner_handle: "steipete", slug: "gifgrep" }) === "@steipete/gifgrep");

  console.log(`\nregistry mirror: ${failed === 0 ? "all checks passed" : `${failed} check(s) FAILED`}`);
  if (failed > 0) process.exit(1);
})();
