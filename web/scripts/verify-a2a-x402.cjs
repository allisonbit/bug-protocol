/**
 * The A2A x402 extension: the vocabulary, the flow, and the gate that holds work.
 *
 * WHY THIS FILE EXISTS. Interoperability fails quietly. A client written against this
 * extension reads a status from a fixed set of six, an error code from a fixed set, and
 * a receipts array it expects to ACCUMULATE; get any of those wrong and nothing here
 * errors, because nothing here is the client. So the vocabulary is asserted against
 * literals, the projections are asserted for all four outcomes the verifier can return,
 * and the gate is asserted to be a real state rather than a label: a task held for
 * payment must be invisible to the swarm, which is a property of the residents'
 * observation query, so that query is read and checked too.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-a2a-x402.cjs
 */
const fs = require("fs");
const path = require("path");

(async () => {
  const ext = await import("../lib/payments/a2a-x402.ts");

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else {
      console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
      failed += 1;
    }
  };
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

  console.log("\nthe vocabulary, spelled the way the extension spells it");
  check("the extension uri is the published one", ext.X402_EXTENSION_URI === "https://github.com/google-a2a/a2a-x402/v0.1", ext.X402_EXTENSION_URI);
  for (const status of ["payment-required", "payment-submitted", "payment-verified", "payment-completed", "payment-rejected", "payment-failed"]) {
    check(`the statuses include ${status}`, ext.X402_STATUSES.includes(status));
  }
  check("and there are exactly six of them", ext.X402_STATUSES.length === 6, String(ext.X402_STATUSES.length));
  const err = ext.paymentError("REPLAY", "already spent");
  check("a replay maps to DUPLICATE_NONCE", err.code === "DUPLICATE_NONCE", err.code);
  check("an expiry maps to EXPIRED_PAYMENT", ext.paymentError("EXPIRED", "x").code === "EXPIRED_PAYMENT");
  check("the platform's own code is kept beside the extension's", err.platform_code === "REPLAY");
  check("an unmapped refusal still gets a code", ext.paymentError("SOMETHING_NEW", "x").code === "PAYMENT_INVALID");

  console.log("\nthe requirement metadata, and the fail-closed case");
  const savedTo = process.env.X402_PAY_TO;
  const savedSettle = process.env.X402_SETTLE;
  delete process.env.X402_PAY_TO;
  const closed = ext.requiredMetadata();
  check("with no address the door says payment-failed", closed["x402.payment.status"] === "payment-failed", closed["x402.payment.status"]);
  check("and names the missing variable", /X402_PAY_TO/.test(closed["x402.payment.error"].message), closed["x402.payment.error"].message);

  process.env.X402_PAY_TO = "0x1111111111111111111111111111111111111111";
  delete process.env.X402_SETTLE;
  const open = ext.requiredMetadata();
  check("with an address it answers payment-required", open["x402.payment.status"] === "payment-required", open["x402.payment.status"]);
  check("and carries the accepts catalogue", Array.isArray(open["x402.payment.required"].accepts) && open["x402.payment.required"].accepts.length > 0);
  check("with the version the extension reads", open["x402.payment.required"].x402Version === 1);
  const first = open["x402.payment.required"].accepts[0];
  check("and a full term: scheme, network, asset, payTo, amount", ["exact", "base"].includes(first.scheme) && first.network && first.asset && first.payTo && first.maxAmountRequired);

  console.log("\nthe four outcomes, projected without flattening two of them together");
  const receipts = [{ network: "base", payer: "0xabc", amount: "1000", status: "verified", transaction: null, at: "2026-09-21T00:00:00.000Z" }];
  const verified = ext.paidMetadata({ ok: true, status: "verified", payer: "0xabc", network: "base", amount: "2500", settlementRef: null, note: "no facilitator", id: "p1" }, receipts);
  check("a verified proof reads payment-verified, not completed", verified["x402.payment.status"] === "payment-verified", verified["x402.payment.status"]);
  const settled = ext.paidMetadata({ ok: true, status: "settled", payer: "0xabc", network: "base", amount: "2500", settlementRef: "0xdead", note: null, id: "p2" }, receipts);
  check("a settled one reads payment-completed", settled["x402.payment.status"] === "payment-completed", settled["x402.payment.status"]);
  check("receipts accumulate rather than replace", settled["x402.payment.receipts"].length === 2);
  check("and the earlier receipt is untouched", JSON.stringify(settled["x402.payment.receipts"][0]) === JSON.stringify(receipts[0]));
  check("a receipt names the network, the payer and the amount", settled["x402.payment.receipts"][1].network === "base" && settled["x402.payment.receipts"][1].amount === "2500");
  check("and carries the transaction when funds moved", settled["x402.payment.receipts"][1].transaction === "0xdead");
  const refused = ext.failedMetadata({ ok: false, code: "REPLAY", reason: "spent", status: 402 });
  check("a refusal reads payment-failed", refused["x402.payment.status"] === "payment-failed");
  check("with the extension's error code", refused["x402.payment.error"].code === "DUPLICATE_NONCE");

  console.log("\nthe settlement note, which distinguishes verifying from moving money");
  check("with no settlement enabled it says so", /No funds move/.test(ext.settlementNote()), ext.settlementNote());
  process.env.X402_SETTLE = "1";
  check("and with settlement on it says funds move", /becomes payment-completed/.test(ext.settlementNote()));
  if (savedSettle === undefined) delete process.env.X402_SETTLE;
  else process.env.X402_SETTLE = savedSettle;
  if (savedTo === undefined) delete process.env.X402_PAY_TO;
  else process.env.X402_PAY_TO = savedTo;

  console.log("\nactivation by header, and the echo");
  const asked = new Request("https://example.com/api/a2a", { headers: { "x-a2a-extensions": ext.X402_EXTENSION_URI } });
  const other = new Request("https://example.com/api/a2a", { headers: { "x-a2a-extensions": "https://example.com/other/v1" } });
  const none = new Request("https://example.com/api/a2a");
  check("the header activates it", ext.extensionRequested(asked));
  check("a different extension does not", !ext.extensionRequested(other));
  check("and no header does not", !ext.extensionRequested(none));
  check("an activation is echoed", ext.extensionHeaders(asked)["x-a2a-extensions"] === ext.X402_EXTENSION_URI);
  check("nothing is echoed when nothing was asked", ext.extensionHeaders(none)["x-a2a-extensions"] === undefined);
  const listAsked = new Request("https://example.com/api/a2a", { headers: { "x-a2a-extensions": `https://x.example/v1, ${ext.X402_EXTENSION_URI}` } });
  check("it is found in a list of extensions", ext.extensionRequested(listAsked));

  console.log("\nthe card, so discovery precedes any negotiation");
  const declared = ext.agentCardExtension();
  check("the card declares the extension uri", declared.uri === ext.X402_EXTENSION_URI);
  check("it says activation is by header", /X-A2A-Extensions/.test(declared.description));
  check("and names the states", declared.states.length === 6);
  check("the agent card route serves it", read("app/well-known/agent-card/route.ts").includes("agentCardExtension()"));

  console.log("\nthe gate, which is a state and not a label");
  const a2a = read("app/api/a2a/route.ts");
  check("a caller can ask for terms", a2a.includes("paymentParam.required === true"));
  check("the gate records the quote on the row", a2a.includes("payment_gate: terms"));
  check("and holds the task rather than queueing it", a2a.includes('state: "input-required"'));
  check("the held work is not requoted from the reply", /The task's own message is never\n  \/\/ retaken from the reply/.test(a2a) || a2a.includes("never\n  // retaken from the reply"));
  check("a continuation is refused from another caller", a2a.includes("held.caller !== caller"));
  check("releasing the task is guarded on the state", a2a.includes('.eq("state", "input-required")'));
  check("the release emits a submission on the bus", a2a.includes("was paid for and is now queued"));
  check("and the payment is bound to the task it paid for", a2a.includes("bindPaymentToTask(sb, payment.id, held.id)"));
  check("a gate is refused when the door cannot take payment", a2a.includes('status === "payment-failed"'));
  check("tasks/get serves the terms it is waiting on", a2a.includes("paymentGate:"));
  check("and the quote is answered, not recomputed", a2a.includes("against the quote you received"));

  const migration = read("supabase/migrate-a2a-x402.sql");
  check("the migration widens the state constraint", migration.includes("'input-required'"));
  check("by dropping the old constraint by lookup, not by a guessed name", migration.includes("from pg_constraint"));
  check("and adds the gate column", migration.includes("add column if not exists payment_gate jsonb"));

  console.log("\nthe property the state exists for: the swarm cannot see unpaid work");
  const observations = read("lib/swamp/observations.ts");
  const query = observations.split("\n").find((l) => l.includes('from("a2a_tasks")'));
  check("the residents' observation query reads only submitted tasks", Boolean(query) && query.includes('.eq("state", "submitted")'), query ?? "no query found");
  check("so a held task is invisible with no change to that query", !observations.includes("input-required"));

  console.log(`\n${failed === 0 ? "a2a-x402: all checks passed" : `a2a-x402: ${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
})();
