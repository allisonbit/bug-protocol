/**
 * The paid deep scan and the running security record, driven against a real deployment.
 *
 *   node scripts/probe-deep-scan.cjs [base-url]
 *
 * WHY A PROBE RATHER THAN A CHECK IN THE SUITE. The gate has to be shown to work against a
 * door that is actually open, with a real signature, because the failure that matters is
 * not a missing branch — it is the ORDER. A door that scans first and bills afterwards
 * passes every offline assertion about the terms it returns, and it is the one shape of
 * this feature that hands a stranger free outbound requests on this deployment's account.
 * The wallet is generated here and given nothing: an EIP-3009 authorization is a
 * signature and not a transaction, so a proof can be produced by an address with no funds,
 * which is the property that makes this checkable without spending anything.
 */
const { privateKeyToAccount, generatePrivateKey } = require("viem/accounts");
const { randomBytes } = require("node:crypto");

const base = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
/** A real skill over https, and a different host from the one being probed. */
const TARGET = process.argv[3] || "https://www.swampai.world/.well-known/agent-skills/swamp/SKILL.md";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
    failed += 1;
  }
};
const j = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(j);

(async () => {
  console.log(`\nthe terms, before anything is scanned, against ${base}`);
  const terms = await post("/api/audits", { kind: "skill", url: TARGET, deep: true });
  if (terms.status === 503 && terms.body?.error?.code === "PAYMENTS_UNCONFIGURED") {
    console.log(`  SKIP  this deployment has no settlement address: ${terms.body.error.message}`);
    process.exit(0);
  }
  check("a deep scan with no proof is refused with the terms", terms.status === 402 && terms.body?.error?.code === "PAYMENT_REQUIRED", `${terms.status} ${terms.body?.error?.code}`);
  const accept = terms.body?.accepts?.[0];
  check("the terms name a network, an asset, an address and a price", Boolean(accept?.network && accept?.asset && accept?.payTo && accept?.maxAmountRequired));
  // The resource names the deployment's own SITE_URL, which is not necessarily the host
  // this probe connected to: a deployment behind a proxy answers on one name and publishes
  // another. What is asserted is which DOOR it names, because that is the fact a payer
  // needs — the audit surface, not the task one.
  check("the resource is the audit door rather than the task door", /\/api\/audits$/.test(accept?.resource ?? ""), accept?.resource);
  check("and the price is the audit price", accept?.maxAmountRequired === "250000", accept?.maxAmountRequired);

  console.log("\nthe proof, signed by a wallet that holds nothing");
  const account = privateKeyToAccount(generatePrivateKey());
  async function signProof() {
    const validAfter = 0; // the decimal string an x402 client sends, and EIP-3009's "immediately"
    const validBefore = Math.floor(Date.now() / 1000) + 600;
    const nonce = `0x${randomBytes(32).toString("hex")}`;
    const signature = await account.signTypedData({
      domain: { name: accept.extra.name, version: accept.extra.version, chainId: accept.extra.chainId, verifyingContract: accept.asset },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: { from: account.address, to: accept.payTo, value: BigInt(accept.maxAmountRequired), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce },
    });
    return {
      x402Version: 1,
      scheme: "exact",
      network: accept.network,
      payload: { signature, authorization: { from: account.address, to: accept.payTo, value: accept.maxAmountRequired, validAfter: String(validAfter), validBefore: String(validBefore), nonce } },
    };
  }

  console.log("\nthe scan that was paid for");
  const proof = await signProof();
  const scanned = await post("/api/audits", { kind: "skill", url: TARGET, deep: true, payment: proof });
  check("the proof is accepted and the scan runs", scanned.status === 201 || scanned.status === 200, `${scanned.status} ${scanned.body?.error?.code ?? ""}`);
  const audit = scanned.body?.audit ?? {};
  check("the answer says the scan was paid for", scanned.body?.paid?.payer === account.address && scanned.body?.paid?.status === "verified", JSON.stringify(scanned.body?.paid));
  check("the receipt carries the amount and the payment row", scanned.body?.paid?.amount === "250000" && Boolean(scanned.body?.paid?.paymentId));
  check("and it is not called settled when nothing settled", scanned.body?.paid?.status !== "settled" || Boolean(scanned.body?.paid?.settlementRef));
  check("the documents that were read are listed", Array.isArray(audit.documents) && audit.documents.length >= 1, `${audit.documents?.length}`);
  check("each with its own verdict, digest and reason", audit.documents?.every((d) => typeof d.verdict === "string" && typeof d.because === "string" && (d.digest.length > 0 || d.error)));
  check("the verdict is bound to a digest of the set", typeof audit.digest === "string" && audit.digest.length === 64);
  check("and the engine says a deep pass ran", typeof audit.engine === "string" && audit.engine.includes("deep"), audit.engine);

  console.log("\nthe record, which is where the receipt has to be");
  const read = await fetch(`${base}/api/audits/${audit.id}`).then(j);
  const stored = read.body?.audit ?? {};
  check("the receipt is ON the audit record, not only in the response", stored.payment?.payer === account.address, JSON.stringify(stored.payment));
  check("with the same payment row id", stored.payment?.paymentId === scanned.body?.paid?.paymentId);
  check("and the documents it read are on the record too", Array.isArray(stored.documents) && stored.documents.length === audit.documents.length);
  check("the bytes are still there to be hashed", typeof stored.content === "string" && stored.content.length > 0);

  console.log("\nthe same authorization cannot be spent twice");
  const replay = await post("/api/audits", { kind: "skill", url: TARGET, deep: true, payment: proof });
  check("a spent nonce is refused", replay.status === 402 && replay.body?.error?.code === "REPLAY", `${replay.status} ${replay.body?.error?.code}`);
  check("and the refusal names the spend rather than the shape", /nonce/i.test(replay.body?.error?.message ?? ""), replay.body?.error?.message);

  console.log("\nthe same bytes, asked for twice");
  const again = await post("/api/audits", { kind: "skill", url: TARGET, deep: true, payment: await signProof() });
  check("the door answers rather than failing", again.status === 200, `${again.status} ${again.body?.error?.code ?? ""}`);
  check("it says the bytes were already on the record", again.body?.deduped === true || again.body?.audit?.id !== audit.id, JSON.stringify({ deduped: again.body?.deduped, id: again.body?.audit?.id === audit.id }));
  check("and it does not pretend a second record was written", again.body?.deduped !== true || again.body?.audit?.id === audit.id);

  console.log("\na fresh subject, so the record has a second paid row");
  const fresh = await post("/api/audits", { kind: "skill", url: `${TARGET}?probe=${randomBytes(4).toString("hex")}`, deep: true, payment: await signProof() });
  check("the scan runs and is recorded", fresh.status === 201, `${fresh.status} ${fresh.body?.error?.code ?? ""}`);
  const freshId = fresh.body?.audit?.id;
  check("with a receipt on the new record", fresh.body?.audit !== undefined && (await fetch(`${base}/api/audits/${freshId}`).then(j)).body?.audit?.payment?.paymentId === fresh.body?.paid?.paymentId);

  console.log("\nthe free audit is not behind the money");
  const free = await post("/api/audits", { kind: "skill", url: TARGET });
  check("one document still costs nothing", (free.status === 200 || free.status === 201) && free.body?.audit?.payment === null, `${free.status}`);
  check("and it is the same engine over the same rules", typeof free.body?.audit?.engine === "string" && !free.body.audit.engine.includes("deep"), free.body?.audit?.engine);

  console.log("\nthe running security record");
  const rec = await fetch(`${base}/api/security`).then(j);
  check("it answers", rec.status === 200, `${rec.status}`);
  const paid = rec.body?.paid ?? {};
  check("it counts the paid scans and their total", paid.audits >= 1 && BigInt(paid.atomic_usdc ?? "0") > 0n, JSON.stringify({ audits: paid.audits, atomic: paid.atomic_usdc }));
  check("and reports verified and settled apart", paid.verified_only + paid.settled === paid.audits, JSON.stringify(paid));
  check("it says which window it read", typeof rec.body?.limits?.auditsRead === "number" && rec.body?.limits?.auditsRead >= 1);
  check("the paid row appears among the audits it read", rec.body?.scanned?.rows?.some((r) => r.id === freshId && r.payment?.paymentId));
  check("each row cites a digest of 64 hex characters", rec.body?.scanned?.rows?.every((r) => /^[0-9a-f]{64}$/.test(r.digest ?? "")));
  check("findings are grouped by rule", Array.isArray(rec.body?.found?.by_code));
  check("nothing here is a score", !("trust" in (rec.body ?? {})) && !("score" in (rec.body ?? {})));
  check("and a consumer is told how to read a verdict", typeof rec.body?.how_to_read?.verdict === "string");

  const page = await fetch(`${base}/security`);
  const html = await page.text();
  check("the page renders", page.status === 200, `${page.status}`);
  check("with the record on it", html.includes("The running security record"));
  check("the counts it prints", html.includes("Documents read") && html.includes("Verdicts corrected"));
  check("and the honest limit", html.includes("does not run") || html.includes("does not execute"));

  console.log(`\n${failed === 0 ? "deep-scan probe: all checks passed" : `deep-scan probe: ${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
})();
