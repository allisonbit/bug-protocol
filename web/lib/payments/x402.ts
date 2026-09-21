import "server-only";
import { getAddress, verifyTypedData, type Address, type Hex } from "viem";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SITE_URL } from "@/lib/site";

/**
 * x402: MONEY ON THE SAME REQUEST THAT ASKS FOR THE WORK.
 *
 * Mandates here have always been declarative, and this module is where that stops
 * being the end of the story: a delegator can attach an x402 payment proof to a
 * task, and the proof is checked against the payer's own signature rather than taken
 * on trust. The point is not that money is exciting. It is that a budget nobody can
 * settle is a sentence, and the ecosystem has now settled on how to settle one:
 * AP2 states intent and budget, x402 moves the value over plain HTTP in stablecoins,
 * and the two compose without either protocol learning about the other.
 *
 * THE SHAPE. `exact` on an EVM chain means an EIP-3009
 * `TransferWithAuthorization`: the payer signs an authorization naming the recipient,
 * the amount, a validity window and a random nonce, and hands over the signature
 * instead of a transaction. Anybody can then submit it, and the token contract
 * enforces it. So verification needs no node, no gas and no trust: it is one
 * `verifyTypedData` call against the token's own EIP-712 domain.
 *
 * WHAT MAKES IT SAFE, IN ORDER OF IMPORTANCE.
 *
 *   1. The nonce is UNIQUE per network in the database, so the same signed
 *      authorization cannot be spent twice. Application level caching would be a
 *      suggestion; the unique index is a fact, and it cannot be bypassed by a code
 *      path that forgot to check.
 *   2. Verification happens against the payer's signature, and the chain id and
 *      token address are part of the signed domain, so a proof made for another
 *      chain or another token cannot be replayed here.
 *   3. It FAILS CLOSED. With no `X402_PAY_TO` configured there is no catalogue, no
 *      proof is accepted, and the refusal says which variable is missing rather than
 *      pretending the door is closed for another reason. Nothing is settled until an
 *      operator sets that variable and, for real settlement, a facilitator.
 *   4. Nothing here holds a key. The payer signs; a facilitator relays. This
 *      deployment never needs custody of anyone's funds to accept a proof, which is
 *      why the payment door can be public.
 */

/** The x402 revision this implements. */
export const X402_VERSION = 1;

/** The one scheme implemented here, named as the specification names it. */
export type X402Scheme = "exact";

/**
 * The chains a payment can be made on, keyed by the name x402 uses.
 *
 * Only chains where the token address is a well known constant AND the platform
 * already has chain metadata are listed. A chain that cannot be verified against a
 * known contract is a chain where a proof would be checked against whatever address
 * the request claimed, which is not a check at all.
 */
export const X402_NETWORKS: Record<
  string,
  { chainId: number; usdc: Address; label: string; explorer: string; testnet: boolean }
> = {
  base: {
    chainId: 8453,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    label: "Base",
    explorer: "https://basescan.org",
    testnet: false,
  },
  "base-sepolia": {
    chainId: 84532,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    label: "Base Sepolia",
    explorer: "https://sepolia.basescan.org",
    testnet: true,
  },
  arbitrum: {
    chainId: 42161,
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    label: "Arbitrum One",
    explorer: "https://arbiscan.io",
    testnet: false,
  },
  optimism: {
    chainId: 10,
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    label: "Optimism",
    explorer: "https://optimistic.etherscan.io",
    testnet: false,
  },
};

/** USDC's EIP-712 domain, which every EIP-3009 token carries in its own contract. */
const USDC_DOMAIN = { name: "USD Coin", version: "2" } as const;

const TRANSFER_WITH_AUTHORIZATION = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** The address value settles to. Unset means the door is closed, and says so. */
export function payTo(): Address | null {
  const v = (process.env.X402_PAY_TO ?? "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : null;
}

/** The price of the one paid resource here, in atomic USDC units. 0.10 USDC default. */
export function priceAtomic(): string {
  const v = (process.env.X402_PRICE_USDC ?? "0.10").trim();
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return "100000";
  // USDC has six decimals; a price is written in whole dollars by an operator and
  // converted once, here, so no caller has to know about atomic units.
  return String(Math.round(n * 1_000_000));
}

/** The facilitator this deployment trusts to relay and report settlement, if any. */
export function facilitatorUrl(): string | null {
  const v = (process.env.X402_FACILITATOR_URL ?? "").trim();
  return /^https?:\/\//.test(v) ? v.replace(/\/+$/, "") : null;
}

/** Whether settlement should actually be attempted, as opposed to verification only. */
export function shouldSettle(): boolean {
  return (process.env.X402_SETTLE ?? "").trim() === "1";
}

/**
 * What this deployment charges, in the shape x402 clients read.
 *
 * One resource is paid here and it is named for what it buys: a delegated task
 * carrying a settled budget. The catalogue is the same object a 402 response returns,
 * so a client that reads the catalogue and a client that is refused learn the same
 * facts in the same shape.
 */
export function paymentRequirements(input?: { resource?: string; amountAtomic?: string; description?: string }) {
  const to = payTo();
  const amount = input?.amountAtomic ?? priceAtomic();
  const resource = input?.resource ?? `${SITE_URL}/api/a2a`;
  if (!to) {
    return {
      x402Version: X402_VERSION,
      error: "This deployment does not accept payments: X402_PAY_TO is not set, so there is no address to settle to. Nothing is refused on a technicality here; the door is simply not open.",
      accepts: [] as unknown[],
      configured: false,
    };
  }
  return {
    x402Version: X402_VERSION,
    configured: true,
    accepts: Object.entries(X402_NETWORKS)
      // Testnets are offered only when an operator asks for them, because a
      // production deployment that advertises a testnet payment rail by accident is
      // a deployment that will one day accept worthless tokens by accident.
      .filter(([name]) => !X402_NETWORKS[name].testnet || (process.env.X402_TESTNET ?? "").trim() === "1")
      .map(([network, meta]) => ({
        scheme: "exact" as X402Scheme,
        network,
        maxAmountRequired: amount,
        asset: meta.usdc,
        payTo: to,
        resource,
        description:
          input?.description ??
          "A delegated task submitted to Swamp with a settled budget. Paying does not buy an outcome: residents choose their own work, and the task's whole life is public either way.",
        mimeType: "application/json",
        maxTimeoutSeconds: 300,
        extra: { name: USDC_DOMAIN.name, version: USDC_DOMAIN.version, chainId: meta.chainId },
      })),
  };
}

/** A payment proof as x402 clients send it. */
export type PaymentProof = {
  x402Version?: number;
  scheme?: string;
  network?: string;
  payload?: {
    signature?: string;
    authorization?: {
      from?: string;
      to?: string;
      value?: string;
      validAfter?: string | number;
      validBefore?: string | number;
      nonce?: string;
    };
  };
};

export type ProofCheck = { ok: true; requirement: ReturnType<typeof paymentRequirements>["accepts"][number] } | { ok: false; code: string; reason: string };

/**
 * Everything that can be checked without touching the chain, in one pure function.
 *
 * Pure on purpose: these are the checks that must never be skipped, and a verifier
 * can exercise every branch of them without a network, a wallet or a database. The
 * expensive checks (the signature, the facilitator, the insert) happen after this and
 * only if this passes.
 */
export function checkProof(input: {
  proof: PaymentProof | null | undefined;
  catalogue: ReturnType<typeof paymentRequirements>;
  nowSeconds: number;
}): ProofCheck {
  const { proof, catalogue, nowSeconds } = input;
  if (!catalogue.configured) {
    return { ok: false, code: "NOT_CONFIGURED", reason: catalogue.error ?? "Payments are not configured on this deployment." };
  }
  if (!proof || typeof proof !== "object") {
    return { ok: false, code: "NO_PROOF", reason: "No payment proof was presented." };
  }
  if (Number(proof.x402Version ?? 0) !== X402_VERSION) {
    return { ok: false, code: "BAD_VERSION", reason: `This door speaks x402 version ${X402_VERSION}.` };
  }
  if (proof.scheme !== "exact") {
    return { ok: false, code: "BAD_SCHEME", reason: `Only the "exact" scheme is accepted here, which is an EIP-3009 transfer authorization.` };
  }
  const requirement = catalogue.accepts?.find((a) => (a as { network: string }).network === proof.network) as
    | ReturnType<typeof paymentRequirements>["accepts"][number]
    | undefined;
  if (!requirement) {
    return {
      ok: false,
      code: "UNKNOWN_NETWORK",
      reason: `Payments are accepted on ${catalogue.accepts?.map((a) => (a as { network: string }).network).join(", ") || "no network"}. "${proof.network ?? "(none)"}" is not one of them.`,
    };
  }

  const auth = proof.payload?.authorization ?? {};
  const signature = typeof proof.payload?.signature === "string" ? proof.payload.signature.trim() : "";
  const from = typeof auth.from === "string" ? auth.from.trim() : "";
  const to = typeof auth.to === "string" ? auth.to.trim() : "";
  const nonce = typeof auth.nonce === "string" ? auth.nonce.trim() : "";
  const value = String(auth.value ?? "");

  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return { ok: false, code: "BAD_SIGNATURE_SHAPE", reason: "payload.signature must be a 65 byte hex signature." };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(from)) {
    return { ok: false, code: "BAD_PAYER", reason: "payload.authorization.from must be an address." };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
    return { ok: false, code: "BAD_RECIPIENT", reason: "payload.authorization.to must be an address." };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) {
    return { ok: false, code: "BAD_NONCE", reason: "payload.authorization.nonce must be 32 bytes of hex. It is what stops this proof being spent twice." };
  }
  if (!/^[0-9]+$/.test(value)) {
    return { ok: false, code: "BAD_AMOUNT", reason: "payload.authorization.value must be an integer in atomic units." };
  }
  const wanted = getAddress((requirement as { payTo: string }).payTo);
  if (getAddress(to) !== wanted) {
    return {
      ok: false,
      code: "WRONG_RECIPIENT",
      reason: `This proof pays ${to}, and this deployment settles to ${wanted}.`,
    };
  }
  if (BigInt(value) < BigInt((requirement as { maxAmountRequired: string }).maxAmountRequired)) {
    return {
      ok: false,
      code: "UNDERPAID",
      reason: `This resource costs ${(requirement as { maxAmountRequired: string }).maxAmountRequired} atomic USDC on ${proof.network} and the proof authorizes ${value}.`,
    };
  }
  // THE WINDOW, AS CLIENTS ACTUALLY SEND IT.
  //
  // Two things here were wrong, and both refused the proofs real clients produce
  // while accepting a shape only this codebase wrote.
  //
  //   1. x402 clients send `validAfter` and `validBefore` as DECIMAL STRINGS, because
  //      JSON numbers cannot carry a uint256 safely and the authorization's other
  //      numeric field (`value`) is already read that way a few lines above.
  //   2. `validAfter: 0` is not a missing value, it is EIP-3009's convention for
  //      "valid immediately", and it is what a client sends by default. Rejecting zero
  //      rejected the ordinary case.
  //
  // Found by the probe that drives a signed authorization through the gated task flow,
  // not by reading this file: the unit checks all used numbers, which is the shape the
  // author of the check had in mind.
  const seconds = (v: unknown): number | null => {
    if (typeof v === "number") return Number.isSafeInteger(v) ? v : null;
    if (typeof v === "string" && /^[0-9]+$/.test(v.trim())) {
      const n = Number(v.trim());
      return Number.isSafeInteger(n) ? n : null;
    }
    return null;
  };
  const validAfter = seconds(auth.validAfter ?? 0);
  const validBefore = seconds(auth.validBefore);
  if (validAfter === null || validBefore === null || validBefore <= 0) {
    return {
      ok: false,
      code: "BAD_WINDOW",
      reason:
        "payload.authorization needs validAfter and validBefore in seconds, as numbers or as decimal strings, with validBefore set to when the authorization stops being valid. validAfter 0 means valid immediately.",
    };
  }
  // Strictly reversed only. An authorization whose bounds are EQUAL is caught by the
  // temporal checks below as not yet valid, which is the more useful answer than a
  // shape error, and a caller that sent the same second twice gets a sentence about
  // time rather than one about fields.
  if (validBefore < validAfter) {
    return {
      ok: false,
      code: "BAD_WINDOW",
      reason: `This authorization's window is empty: it becomes valid at ${validAfter} and stops at ${validBefore}.`,
    };
  }
  if (validAfter > nowSeconds) {
    return { ok: false, code: "NOT_YET_VALID", reason: `This authorization is not valid until ${new Date(validAfter * 1000).toISOString()}.` };
  }
  if (validBefore <= nowSeconds) {
    return { ok: false, code: "EXPIRED", reason: `This authorization expired at ${new Date(validBefore * 1000).toISOString()}.` };
  }
  return { ok: true, requirement };
}

/**
 * The signature check, which is the one thing here that cannot be faked by a
 * well-formed request.
 *
 * The domain carries the chain id and the token address, so the same authorization
 * signature is worthless on another chain or against another contract. `verifyTypedData`
 * checks it locally: no node, no facilitator, no third party has to be trusted for
 * this step.
 */
export async function verifyProofSignature(proof: PaymentProof, network: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const meta = X402_NETWORKS[network];
  if (!meta) return { ok: false, reason: `Unknown network ${network}.` };
  const auth = proof.payload?.authorization ?? {};
  try {
    const valid = await verifyTypedData({
      address: getAddress(String(auth.from)) as Address,
      domain: { ...USDC_DOMAIN, chainId: meta.chainId, verifyingContract: meta.usdc },
      types: TRANSFER_WITH_AUTHORIZATION,
      primaryType: "TransferWithAuthorization",
      message: {
        from: getAddress(String(auth.from)) as Address,
        to: getAddress(String(auth.to)) as Address,
        value: BigInt(String(auth.value)),
        validAfter: BigInt(String(auth.validAfter)),
        validBefore: BigInt(String(auth.validBefore)),
        nonce: String(auth.nonce) as Hex,
      },
      signature: String(proof.payload?.signature) as Hex,
    });
    return valid ? { ok: true } : { ok: false, reason: "The signature does not match the authorization it is attached to." };
  } catch (e) {
    return { ok: false, reason: `The signature could not be checked: ${e instanceof Error ? e.message : "unknown error"}.` };
  }
}

/**
 * Ask a facilitator to relay the authorization, and record what it said.
 *
 * Only attempted when an operator has both configured a facilitator and asked for
 * settlement. The reply is recorded verbatim in the payment row, including the
 * transaction hash, because a payment whose settlement nobody can look up is an
 * assertion rather than a receipt.
 */
export async function settleViaFacilitator(input: {
  proof: PaymentProof;
  requirement: unknown;
}): Promise<{ attempted: boolean; ok: boolean; ref: string | null; reason: string | null }> {
  const url = facilitatorUrl();
  if (!url || !shouldSettle()) {
    return {
      attempted: false,
      ok: false,
      ref: null,
      reason: url
        ? "A facilitator is configured but settlement is not enabled (X402_SETTLE is not 1), so the proof was verified and not relayed."
        : "No facilitator is configured, so the proof was verified and not relayed. Set X402_FACILITATOR_URL and X402_SETTLE=1 to move funds.",
    };
  }
  try {
    const res = await fetch(`${url}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload: input.proof, paymentRequirements: input.requirement }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => null)) as { success?: boolean; transaction?: string; errorReason?: string; error?: string } | null;
    if (!res.ok || !body) {
      return { attempted: true, ok: false, ref: null, reason: `The facilitator answered ${res.status}.` };
    }
    return {
      attempted: true,
      ok: body.success === true,
      ref: body.transaction ?? null,
      reason: body.success === true ? null : body.errorReason ?? body.error ?? "The facilitator refused to settle.",
    };
  } catch (e) {
    return { attempted: true, ok: false, ref: null, reason: `The facilitator could not be reached: ${e instanceof Error ? e.message : "unknown error"}.` };
  }
}

export type PaymentOutcome =
  | { ok: true; status: "verified" | "settled"; payer: string; network: string; amount: string; settlementRef: string | null; note: string | null; id: string | null }
  | { ok: false; code: string; reason: string; status: number };

/**
 * The whole pipeline, in the order it must happen: shape, signature, settlement,
 * then the unique insert that makes replay impossible.
 *
 * THE ORDER MATTERS. The row is written only after the proof checks out, and the
 * unique index on (network, nonce) is the final gate: two simultaneous submissions
 * of the same authorization both reach the insert, and exactly one of them returns a
 * row. A refusal is recorded too, because a payment door whose refusals were silent
 * would be the one surface here nobody could audit.
 */
export async function acceptPayment(input: {
  proof: PaymentProof | null | undefined;
  /**
   * The service client. Passed in rather than reached for, so the pure half of this
   * module can be exercised without a deployment's server-only imports attached.
   */
  sb: SupabaseClient | null;
  taskId?: string | null;
  description?: string;
  /**
   * The resource being paid for, when it is not the A2A door.
   *
   * Passed through so a 402 names what the money buys: a client that is refused a deep
   * audit scan has to be told the scan is what costs money, and a catalogue that named
   * the A2A door for an audit request would be describing a different purchase.
   */
  resource?: string;
  /** The price, when this resource is not priced like the default one. */
  amountAtomic?: string;
}): Promise<PaymentOutcome> {
  const catalogue = paymentRequirements({ description: input.description, resource: input.resource, amountAtomic: input.amountAtomic });
  const check = checkProof({ proof: input.proof, catalogue, nowSeconds: Math.floor(Date.now() / 1000) });
  if (!check.ok) {
    return { ok: false, code: check.code, reason: check.reason, status: check.code === "NOT_CONFIGURED" ? 503 : 402 };
  }
  const proof = input.proof as PaymentProof;
  const network = String(proof.network);
  const auth = proof.payload?.authorization ?? {};
  const payer = String(auth.from);
  const amount = String(auth.value);
  const nonce = String(auth.nonce);
  const signature = String(proof.payload?.signature);
  const sb = input.sb;

  const sig = await verifyProofSignature(proof, network);
  if (!sig.ok) {
    await record(sb, {
      taskId: input.taskId ?? null,
      payer,
      payTo: String((check.requirement as { payTo: string }).payTo),
      asset: String((check.requirement as { asset: string }).asset),
      network,
      amount,
      nonce,
      signature,
      status: "refused",
      note: sig.reason,
      raw: proof as unknown as Record<string, unknown>,
    });
    return { ok: false, code: "BAD_SIGNATURE", reason: sig.reason, status: 402 };
  }

  const settlement = await settleViaFacilitator({ proof, requirement: check.requirement });
  const status: "verified" | "settled" = settlement.ok ? "settled" : "verified";
  const note = settlement.ok ? null : settlement.reason;

  const write = await record(sb, {
    taskId: input.taskId ?? null,
    payer,
    payTo: String((check.requirement as { payTo: string }).payTo),
    asset: String((check.requirement as { asset: string }).asset),
    network,
    amount,
    nonce,
    signature,
    status,
    settlementRef: settlement.ref,
    note,
    raw: proof as unknown as Record<string, unknown>,
  });

  if (!write.ok && write.code === "REPLAY") {
    return {
      ok: false,
      code: "REPLAY",
      reason: `This authorization has already been presented on ${network}. A nonce is spendable exactly once, and the database refused the second write rather than an application check deciding not to.`,
      status: 402,
    };
  }
  if (!write.ok) {
    return { ok: false, code: write.code, reason: write.reason, status: 500 };
  }

  // Public, like every other fact here. The event says what was paid and on what
  // basis, never anything about the payer beyond the address that signed.
  await sb
    ?.from("events")
    .insert({
      topic: "x402.payment",
      agent_id: null,
      agent_handle: null,
      payload: {
        text: `payment of ${amount} atomic USDC on ${network} accepted from ${payer}${input.taskId ? ` for task ${input.taskId.slice(0, 8)}` : ""}${settlement.ok ? `, settled as ${settlement.ref}` : ", verified only"}`,
        task_id: input.taskId ?? null,
        payer,
        network,
        amount,
        status,
        settlement_ref: settlement.ref,
      },
      signature: null,
      signed_ok: false,
      provenance: "system",
    })
    .then(undefined, () => null);

  return { ok: true, status, payer, network, amount, settlementRef: settlement.ref, note, id: write.id };
}

/**
 * Attach an accepted payment to the task it paid for.
 *
 * The order is forced by the data: a payment is verified before a task exists,
 * because a task recorded against a proof that later fails to verify would be a task
 * whose budget was imaginary. So the payment lands first and is pointed at the task a
 * moment later, and a failure to attach leaves a verified payment with no task, which
 * is visible in the table rather than hidden.
 */
export async function bindPaymentToTask(
  sb: SupabaseClient | null,
  paymentId: string | null,
  taskId: string,
): Promise<boolean> {
  if (!sb || !paymentId) return false;
  const { error } = await sb.from("x402_payments").update({ task_id: taskId }).eq("id", paymentId);
  return !error;
}

/** Write one payment row, treating the unique index as the replay guard. */
async function record(
  sb: SupabaseClient | null,
  row: {
    taskId: string | null;
    payer: string;
    payTo: string;
    asset: string;
    network: string;
    amount: string;
    nonce: string;
    signature: string;
    status: "verified" | "settled" | "refused";
    settlementRef?: string | null;
    note?: string | null;
    raw: Record<string, unknown>;
  },
): Promise<{ ok: true; id: string | null } | { ok: false; code: string; reason: string }> {
  if (!sb) {
    return {
      ok: false,
      code: "NO_BACKEND",
      reason: "The Swamp backend is not connected to this deployment, so a payment cannot be recorded, and an unrecorded payment is not accepted here.",
    };
  }
  const { data, error } = await sb
    .from("x402_payments")
    .insert({
      task_id: row.taskId,
      payer: row.payer,
      pay_to: row.payTo,
      asset: row.asset,
      network: row.network,
      amount: row.amount,
      scheme: "exact",
      nonce: row.nonce,
      signature: row.signature,
      status: row.status,
      settlement_ref: row.settlementRef ?? null,
      note: row.note ?? null,
      raw: row.raw,
    })
    .select("id")
    .single();
  if (error) {
    // 23505 is the unique violation on (network, nonce), which is the replay guard
    // doing its job rather than a bug to be reported as one.
    if (error.code === "23505") return { ok: false, code: "REPLAY", reason: "That nonce has already been spent." };
    return { ok: false, code: "WRITE_FAILED", reason: `The payment could not be recorded: ${error.message}` };
  }
  return { ok: true, id: (data as { id: string }).id };
}
