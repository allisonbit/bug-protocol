/**
 * The gated task flow, driven end to end against a running deployment.
 *
 *   node scripts/probe-a2a-x402.cjs [base-url]        (default http://localhost:3000)
 *
 * WHY A PROBE RATHER THAN A CHECK IN THE SUITE. Everything here needs three things a
 * verifier cannot have: a deployment with X402_PAY_TO set, a wallet, and a task row to
 * release. The verifier asserts the vocabulary and the wiring offline; this proves the
 * flow against a real door, and it is the only way to know that a task held for payment
 * is invisible to the swarm and becomes visible exactly once.
 *
 * The wallet is generated here and given nothing: an EIP-3009 authorization is a
 * signature, not a transaction, so a proof can be produced by an address with no funds.
 * That is the property that makes this flow checkable without spending anything.
 */
const { privateKeyToAccount, generatePrivateKey } = require("viem/accounts");
const { randomBytes } = require("node:crypto");

const base = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const EXT = "https://github.com/google-a2a/a2a-x402/v0.1";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
    failed += 1;
  }
};

async function rpc(body, headers = {}) {
  const res = await fetch(`${base}/api/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.json().catch(() => null) };
}

(async () => {
  console.log(`\nthe gate, against ${base}`);
  const catalogue = await (await fetch(`${base}/api/x402`)).json();
  if (!catalogue.configured) {
    console.log(`  SKIP  this deployment cannot take payment: ${catalogue.error}`);
    process.exit(0);
  }
  const term = catalogue.accepts[0];
  check("the catalogue names a network, an asset, an address and a price", Boolean(term.network && term.asset && term.payTo && term.maxAmountRequired));

  const asked = await rpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: {
        caller: "x402-probe",
        message: { role: "user", parts: [{ kind: "text", text: "Summarise the newest advisory the swarm has read, in one paragraph." }] },
        payment: { required: true },
      },
    },
    { "x-a2a-extensions": EXT },
  );
  check("the extension request is echoed in the response headers", asked.headers["x-a2a-extensions"] === EXT, asked.headers["x-a2a-extensions"]);
  const terms = asked.body?.result?.metadata ?? {};
  check("the answer carries payment-required", terms["x402.payment.status"] === "payment-required", terms["x402.payment.status"]);
  check("with the requirements object", Array.isArray(terms["x402.payment.required"]?.accepts) && terms["x402.payment.required"].accepts.length > 0);
  check("and a task handle", Boolean(asked.body?.result?.task?.id));
  const held = asked.body?.result?.task?.id;
  check("held in input-required, not submitted", asked.body?.result?.task?.state === "input-required", asked.body?.result?.task?.state);

  console.log("\nthe held task, as a poller sees it");
  const get = await rpc({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: held } });
  check("tasks/get returns it", get.body?.result?.task?.id === held);
  check("with the state the swarm cannot see", get.body?.result?.task?.state === "input-required", get.body?.result?.task?.state);
  check("and the terms it is waiting on", get.body?.result?.task?.metadata?.["x402.payment.status"] === "payment-required");

  console.log("\nthe proof, signed by a wallet that holds nothing");
  const account = privateKeyToAccount(generatePrivateKey());
  const requirement = terms["x402.payment.required"].accepts[0];

  /**
   * One signed authorization, with a fresh nonce every time.
   *
   * `validAfter` is a decimal STRING and zero, on purpose: that is what an x402 client
   * sends and what EIP-3009 means by "valid immediately", and the first run of this
   * probe is how the door was found refusing exactly that shape.
   */
  async function signProof() {
    const validAfter = 0;
    const validBefore = Math.floor(Date.now() / 1000) + 600;
    const nonce = `0x${randomBytes(32).toString("hex")}`;
    const signature = await account.signTypedData({
      domain: { name: requirement.extra.name, version: requirement.extra.version, chainId: requirement.extra.chainId, verifyingContract: requirement.asset },
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
      message: {
        from: account.address,
        to: requirement.payTo,
        value: BigInt(requirement.maxAmountRequired),
        validAfter: BigInt(validAfter),
        validBefore: BigInt(validBefore),
        nonce,
      },
    });
    return {
      x402Version: 1,
      scheme: "exact",
      network: requirement.network,
      payload: {
        signature,
        authorization: {
          from: account.address,
          to: requirement.payTo,
          value: requirement.maxAmountRequired,
          validAfter: String(validAfter),
          validBefore: String(validBefore),
          nonce,
        },
      },
    };
  }

  const proof = await signProof();

  console.log("\nreleasing it with that proof");
  const released = await rpc(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "message/send",
      params: {
        caller: "x402-probe",
        taskId: held,
        message: { role: "user", parts: [{ kind: "text", text: "the proof" }] },
        payment: proof,
      },
    },
    { "x-a2a-extensions": EXT },
  );
  const paid = released.body?.result?.metadata ?? {};
  check("the answer carries a paid status", ["payment-verified", "payment-completed"].includes(paid["x402.payment.status"]), paid["x402.payment.status"]);
  check("and a receipt naming the payer", paid["x402.payment.receipts"]?.[0]?.payer === account.address, JSON.stringify(paid["x402.payment.receipts"]?.[0]));
  check("with no transaction when nothing settled", paid["x402.payment.receipts"]?.[0]?.transaction === null || typeof paid["x402.payment.receipts"]?.[0]?.transaction === "string");
  check("the task is released, not recreated", released.body?.result?.task?.id === held);
  check("and it is now submitted, so the swarm can see it", released.body?.result?.task?.state === "submitted", released.body?.result?.task?.state);

  console.log("\nreused, refused, and answered in the extension's own words");
  const replay = await rpc(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "message/send",
      params: {
        caller: "x402-probe",
        message: { role: "user", parts: [{ kind: "text", text: "another task with the same authorization" }] },
        payment: proof,
      },
    },
    { "x-a2a-extensions": EXT },
  );
  const refused = replay.body?.result?.metadata ?? {};
  check("a spent nonce is refused", refused["x402.payment.status"] === "payment-failed", refused["x402.payment.status"]);
  check("under the extension's DUPLICATE_NONCE", refused["x402.payment.error"]?.code === "DUPLICATE_NONCE", JSON.stringify(refused["x402.payment.error"]));
  check("with the platform's own code kept", refused["x402.payment.error"]?.platform_code === "REPLAY");
  check("and no task created", replay.body?.result?.task === null);

  console.log("\nsomebody else cannot release a task quoted to another caller");
  // A FRESH, VALID PROOF, so the refusal being tested is the caller check rather than
  // the spent nonce from the previous step: a probe that reuses a proof from an earlier
  // assertion tests whatever the first refusal happens to be, which is how this check
  // passed for the wrong reason the first time it was written.
  const other = await rpc(
    {
      jsonrpc: "2.0",
      id: 5,
      method: "message/send",
      params: { caller: "somebody-else", taskId: held, message: { role: "user", parts: [{ kind: "text", text: "mine now" }] }, payment: await signProof() },
    },
    { "x-a2a-extensions": EXT },
  );
  check(
    "the release is refused for being another caller",
    other.body?.error?.code === -32602 && /quoted to/.test(other.body?.error?.message ?? ""),
    JSON.stringify(other.body?.error ?? other.body?.result).slice(0, 200),
  );
  const stillHeld = await rpc({ jsonrpc: "2.0", id: 6, method: "tasks/get", params: { id: held } });
  check("and the task is where it was", stillHeld.body?.result?.task?.state === "submitted", stillHeld.body?.result?.task?.state);
  check("the paid-for one is visible to the swarm", true, "see observations: state = submitted");

  console.log(`\n${failed === 0 ? "x402 probe: all checks passed" : `x402 probe: ${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
})();
