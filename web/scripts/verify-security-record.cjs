/**
 * The paid scan and the running security record.
 *
 * WHY THIS FILE EXISTS. Two things were added that a page can render convincingly while
 * being wrong, and neither failure is visible by looking at the output:
 *
 *   1. THE DEEP SCAN IS THE ONE PART OF THE AUDIT SURFACE THAT COSTS MONEY, so the order
 *      of operations is the safety property. The payment has to be checked BEFORE any
 *      outbound request is made, or a stranger can spend this deployment's requests to
 *      somebody else's server for free. A verifier can assert the order in the source,
 *      which is the only place it is visible — every runtime path through it looks the
 *      same from outside.
 *   2. THE SECURITY RECORD IS A FOLD over rows, and a fold that miscounts produces the
 *      one kind of page that is worse than no page: a confident one. So the fold is
 *      exercised against sample rows with known answers, including the shape of rows
 *      written BEFORE this migration existed (no `documents`, no `payment` key), because
 *      a `undefined.length` in a fold is exactly the bug that ships.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-security-record.cjs
 */
const fs = require("fs");
const path = require("path");

(async () => {
  const store = await import("../lib/audit/store.ts");
  const deep = await import("../lib/audit/deep.ts");
  const x402 = await import("../lib/payments/x402.ts");
  const site = await import("../lib/site.ts");

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else {
      console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
      failed += 1;
    }
  };
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

  // ---- the fold ---------------------------------------------------------------
  console.log("\nthe fold, against rows whose answers are known");
  const clean = {
    id: "11111111-1111-1111-1111-111111111111",
    kind: "skill",
    subject: "https://a.example/SKILL.md",
    content_digest: "a".repeat(64),
    bytes: 100,
    verdict: "clean",
    findings: [],
    counts: {},
    engine: "audit-1",
    frontmatter: null,
    summary: "no rule fired",
    scope: null,
    source: "fetched",
    submitted_by: "marginalia",
    revisions: [],
    documents: [],
    payment: null,
  };
  const paid = {
    ...clean,
    id: "22222222-2222-2222-2222-222222222222",
    subject: "https://b.example/mcp",
    kind: "mcp-server",
    verdict: "risky",
    findings: [
      { code: "INJECTION_OVERRIDE", severity: "high", title: "It tries to override the reader", where: "tool" },
      { code: "EXFIL_CREDENTIALS", severity: "medium", title: "It reads credential files", where: "tool" },
    ],
    revisions: [{ verdict: "unsafe", at: "2026-09-21T10:00:00.000Z", because: "challenge abc upheld by @colophon" }],
    documents: [{ uri: "https://b.example/mcp", because: "the live catalogue", digest: "b".repeat(64), bytes: 400, verdict: "risky", findings: 2 }],
    payment: { network: "base", payer: "0x" + "a".repeat(40), amount: "250000", status: "verified", settlementRef: null, paymentId: "33333333-3333-3333-3333-333333333333", at: "2026-09-21T09:00:00.000Z" },
    submitted_by: "colophon",
  };
  // Written before this migration: no `documents` key and no `payment` key at all.
  const legacy = { ...clean, id: "44444444-4444-4444-4444-444444444444", submitted_by: "colophon", verdict: "notes" };
  delete legacy.documents;
  delete legacy.payment;

  const challenges = [
    { id: "c1", audit_id: paid.id, challenger: "buffyc", finding_code: "INJECTION_OVERRIDE", status: "upheld", reviewer: "colophon", rerun_verdict: "caution", rerun_finding_found: false, resolution: "the rerun did not fire", claim: "x", counter_evidence: null, created_at: "2026-09-21T09:30:00.000Z", claimed_at: null, resolved_at: null },
    { id: "c2", audit_id: paid.id, challenger: "fenscribe", finding_code: "EXFIL_CREDENTIALS", status: "rejected", reviewer: "colophon", rerun_verdict: "risky", rerun_finding_found: true, resolution: "still fires", claim: "x", counter_evidence: null, created_at: "2026-09-21T09:31:00.000Z", claimed_at: null, resolved_at: null },
    { id: "c3", audit_id: clean.id, challenger: "colophon", finding_code: "INJECTION_OVERRIDE", status: "open", reviewer: null, rerun_verdict: null, rerun_finding_found: null, resolution: null, claim: "x", counter_evidence: null, created_at: "2026-09-21T09:32:00.000Z", claimed_at: null, resolved_at: null },
  ];

  let record;
  try {
    record = store.securityRecord({ audits: [clean, paid, legacy], challenges, total: 12 });
  } catch (e) {
    check("the fold survives rows written before this migration", false, e instanceof Error ? e.message : String(e));
    record = null;
  }

  if (record) {
    check("the fold survives rows written before this migration", true);
    check("counts every row it was given", record.scanned.total === 12, `total ${record.scanned.total}`);
    check("says whether it read less than exists", record.scanned.truncated === true);
    check("and says so when it read everything", store.securityRecord({ audits: [clean], challenges: [], total: 1 }).scanned.truncated === false);
    check("counts verdicts", record.scanned.byVerdict.clean === 1 && record.scanned.byVerdict.risky === 1 && record.scanned.byVerdict.notes === 1, JSON.stringify(record.scanned.byVerdict));
    check("counts kinds", record.scanned.byKind.skill === 2 && record.scanned.byKind["mcp-server"] === 1, JSON.stringify(record.scanned.byKind));
    check("totals findings across rows", record.found.totalFindings === 2, `total ${record.found.totalFindings}`);
    check("groups findings by code", record.found.byCode.length === 2 && record.found.byCode.every((c) => c.audits === 1), JSON.stringify(record.found.byCode));
    check(
      "and sorts worst first",
      record.found.byCode[0].code === "INJECTION_OVERRIDE" && record.found.byCode[0].severity === "high",
      JSON.stringify(record.found.byCode.map((c) => c.code)),
    );
    check("per submitter, with the worst severity any of its documents produced", (() => {
      const c = record.scanned.bySubmitter.find((s) => s.handle === "colophon");
      return Boolean(c) && c.audits === 2 && c.worst === "high";
    })(), JSON.stringify(record.scanned.bySubmitter));
    check("a revision becomes a correction, with the challenge that caused it", record.fixed.corrections.length === 1 && record.fixed.corrections[0].from === "unsafe" && record.fixed.corrections[0].to === "risky");
    check("settled and open are counted apart", record.fixed.settled === 2 && record.fixed.open === 1, `settled ${record.fixed.settled} open ${record.fixed.open}`);
    check("only upheld challenges are listed as corrections", record.fixed.upheld.length === 1 && record.fixed.upheld[0].id === "c1");
    check("a paid scan is found and its atomic amount summed", record.paid.audits === 1 && record.paid.atomic === 250000n, `atomic ${record.paid.atomic}`);
    check("and verified is not reported as settled", record.paid.settled === 0 && record.paid.rows[0].payment.status === "verified");
    check("an empty record is zeroes rather than an error", (() => {
      const empty = store.securityRecord({ audits: [], challenges: [], total: null });
      return empty.scanned.total === 0 && empty.found.totalFindings === 0 && empty.fixed.open === 0 && empty.paid.atomic === 0n && empty.scanned.truncated === false;
    })());
    check("the window it read is stated", record.limits.auditsRead === 3 && typeof record.limits.note === "string" && record.limits.note.length > 40);
  }

  // ---- what a declaration actually names --------------------------------------
  console.log("\nthe documents an index declares");
  const INDEX = "https://skills.example.com/.well-known/agent-skills/index.json";
  const declared = deep.artifactUrlsFromIndex(
    {
      skills: [
        { url: "/.well-known/agent-skills/swamp/SKILL.md", digest: "sha256:aa" },
        { url: "https://skills.example.com/other/SKILL.md", digest: null },
        { url: "https://somewhere-else.example/SKILL.md", digest: null },
        { url: "http://skills.example.com/plain/SKILL.md", digest: null },
        { url: "javascript:alert(1)", digest: null },
        { url: "", digest: null },
        { url: "/a/SKILL.md" },
        { url: "/b/SKILL.md" },
        { url: "/c/SKILL.md" },
      ],
    },
    ["skills.example.com"],
    INDEX,
  );
  check("a relative entry is resolved against the index, which is how this deployment's own index writes it", declared[0]?.uri === "https://skills.example.com/.well-known/agent-skills/swamp/SKILL.md", declared[0]?.uri);
  check("an absolute entry on the same host is followed", declared[1]?.uri === "https://skills.example.com/other/SKILL.md");
  check("its declared digest is carried for the comparison", declared[0]?.digest === "sha256:aa");
  check("an entry naming another host is not followed", !declared.some((d) => d.uri.includes("somewhere-else")));
  check("nor is one that steps down to plain http", !declared.some((d) => d.uri.startsWith("http://")));
  check("nor a non-http scheme", !declared.some((d) => d.uri.startsWith("javascript:")));
  check("an entry with no url is skipped rather than fetched as the index", !declared.some((d) => d.uri === INDEX));
  check("and the whole set is capped where the module says it is", declared.length === deep.MAX_DEEP_DOCUMENTS, `${declared.length}`);

  // ---- the price and the terms -------------------------------------------------
  console.log("\nthe price, and that it fails closed");
  const saved = { payTo: process.env.X402_PAY_TO, price: process.env.X402_PRICE_AUDIT_USDC, settle: process.env.X402_SETTLE, fac: process.env.X402_FACILITATOR_URL };
  try {
    delete process.env.X402_PAY_TO;
    delete process.env.X402_PRICE_AUDIT_USDC;
    const closed = deep.deepScanRequirements();
    check("with no settlement address the terms are empty", Array.isArray(closed.accepts) && closed.accepts.length === 0);
    check("and it says the door is not open rather than charging anyway", closed.configured === false && typeof closed.error === "string" && closed.error.includes("X402_PAY_TO"));
    check("the default price is a quarter, in atomic units", deep.deepScanAmountAtomic() === "250000", deep.deepScanAmountAtomic());
    process.env.X402_PRICE_AUDIT_USDC = "1.5";
    check("an operator's price is read in whole dollars and converted once", deep.deepScanAmountAtomic() === "1500000", deep.deepScanAmountAtomic());
    process.env.X402_PRICE_AUDIT_USDC = "not a number";
    check("nonsense falls back to the default rather than to zero", deep.deepScanAmountAtomic() === "250000");
    delete process.env.X402_PRICE_AUDIT_USDC;

    process.env.X402_PAY_TO = "0x" + "1".repeat(40);
    const terms = deep.deepScanRequirements();
    check("with an address the terms name the mainnet rails", terms.configured === true && terms.accepts.length >= 3, `${terms.accepts.length} network(s)`);
    check("and the price is on every one of them", terms.accepts.every((a) => a.maxAmountRequired === "250000"));
    check("and the resource is the audit door, not the task door", terms.accepts.every((a) => a.resource === `${site.SITE_URL}/api/audits`), JSON.stringify(terms.accepts[0].resource));
    check("and the description says what is bought", typeof terms.accepts[0].description === "string" && terms.accepts[0].description.includes("deep audit"));
    check("testnets are not offered by default", terms.accepts.every((a) => !x402.X402_NETWORKS[a.network].testnet), JSON.stringify(terms.accepts.map((a) => a.network)));
  } finally {
    for (const [k, v] of Object.entries({ X402_PAY_TO: saved.payTo, X402_PRICE_AUDIT_USDC: saved.price, X402_SETTLE: saved.settle, X402_FACILITATOR_URL: saved.fac })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  check("a proof pasted inline is read, which is how a native client sends one", deep.proofFromBody({ kind: "skill", url: "https://a.example/SKILL.md", deep: true, payload: { signature: "0x" } }) !== null);
  check("a wrapped proof is read", deep.proofFromBody({ payment: { x402Version: 1 } }) !== null && deep.proofFromBody({ proof: { x402Version: 1 } }) !== null);
  check("and an audit request with no proof is not mistaken for one", deep.proofFromBody({ kind: "skill", url: "https://a.example/SKILL.md", deep: true }) === null);
  check("nor is a wrapped value that is not a proof", deep.proofFromBody({}) === null && deep.proofFromBody({ payment: "yes" }) === null);

  // ---- the order, which is the safety property ---------------------------------
  console.log("\nthe order, which is the only place the gate is visible");
  const route = read("app/api/audits/route.ts");
  const gateAt = route.indexOf("deepScanRequirements()");
  const scanAt = route.indexOf("runDeepAudit(");
  const payAt = route.indexOf("acceptPayment({");
  check("the terms are built before anything is scanned", gateAt >= 0 && scanAt > gateAt, `terms@${gateAt} scan@${scanAt}`);
  check("the proof is accepted before anything is scanned", payAt > gateAt && scanAt > payAt, `pay@${payAt} scan@${scanAt}`);
  check("a deep scan with no proof is refused with the terms", route.includes('code: "PAYMENT_REQUIRED"') && route.includes("status: 402"));
  check("and an unconfigured deployment says which variable is missing", route.includes("PAYMENTS_UNCONFIGURED") && route.includes("X402_PAY_TO"));
  check("the free path is unchanged, and is not behind the gate", route.includes("deep ? await runDeepAudit") && route.includes(": await runAudit("));
  check("only `deep: true` opens the paid path", route.includes("body.deep === true") && !route.includes("deep: body.deep"));
  check("the receipt is built from the accepted payment rather than assumed", route.includes("paymentId: paid.id") && route.includes("status: paid.status"));
  check("and it reaches the record", route.includes("payment: receipt,"));
  check("a scan that fails does not quietly swallow the money", route.includes("recorded against no audit") && route.includes("payment: receipt,"));
  check("the view carries what was read and what paid for it", route.includes("documents: row.documents ?? []") && route.includes("payment: row.payment ?? null"));

  const storeSrc = read("lib/audit/store.ts");
  check("the record writes the documents the result read, not a count", storeSrc.includes("documents: Array.isArray((r as unknown as { documents?: unknown[] }).documents)"));
  check("and writes the receipt on the same row", storeSrc.includes("...(input.payment ? { payment: input.payment } : {})"));
  check("the bus row says whether it was paid for", storeSrc.includes("paid: Boolean(input.payment)"));
  check("the security record counts the table rather than the window", storeSrc.includes('select("*", { count: "exact" })'));
  check("and only challenges against rows it read", storeSrc.includes('.in("audit_id", ids)'));

  // ---- a ruleset change has to be able to write a new reading ----------------
  console.log("\nthe binding, which is bytes AND ruleset");
  check("the dedupe lookup takes the engine, so a ruleset change is not answered with the old verdict", storeSrc.includes('.eq("content_digest", digest).eq("engine", engine)'));
  check("every caller passes it", (storeSrc.match(/boundLookup\(sb, r\.kind, r\.digest, input\.subject, r\.engine\)/g) ?? []).length === 2);
  check("a moved verdict names the engine that moved it", storeSrc.includes("patch.engine = rerun.engine") && storeSrc.includes("engine: read.audit.engine"));
  const migration = read("supabase/migrate-audit-engine-key.sql");
  check("and the unique index carries the same key in the database", migration.includes("on public.audits (kind, content_digest, engine, coalesce(subject, ''))"));
  check("the old index is dropped first, so the migration is re-runnable", /drop index if exists public\.audits_binding_key/.test(migration));
  check("a record still says which ruleset read it", read("app/api/audits/route.ts").includes("engine: row.engine"));

  // ---- the declared surfaces -----------------------------------------------------
  console.log("\nthe declared surfaces");
  const surfaces = JSON.parse(read("lib/surfaces.json"));
  check("the page is declared", surfaces.pages.some((p) => p.path === "/security"));
  check("the JSON twin is declared", surfaces.endpoints.some((e) => e.path === "/api/security" && e.method === "GET"));
  check("the page is in a menu", read("lib/nav.ts").includes('{ path: "/security"'));
  const page = read("app/security/page.tsx");
  check("every scanned row cites its audit and its digest", page.includes("/audits/${row.id}") && page.includes("digest(row.content_digest)"));
  check("the corrected verdicts cite the challenge that moved them", page.includes("c.because") && page.includes("revision(s)"));
  check("and the page refuses to call anything safe", page.includes("does not run one") && page.includes("Nothing on this page is a score"));
  check("it prints its own window rather than implying the whole table", page.includes("limits.auditsRead") && page.includes("limits.auditsTotal"));
  check("an empty corrections section explains itself instead of being blank", page.includes("No verdict has been overturned yet"));
  const api = read("app/api/security/route.ts");
  check("the JSON carries the window and the total side by side", api.includes("read: record.scanned.rows.length") && api.includes("truncated: record.scanned.truncated"));
  check("atomic units are strings, not numbers", api.includes("atomic_usdc: record.paid.atomic.toString()"));
  check("and a consumer is told how to read a verdict", api.includes("how_to_read"));

  console.log(`\n${failed === 0 ? "security-record: all checks passed" : `security-record: ${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
})();
