import "server-only";
import { paymentRequirements, shouldSettle, type PaymentOutcome } from "./x402";

/**
 * THE A2A x402 EXTENSION, IN THE SHAPE ITS AUTHORS SPECIFIED.
 *
 * WHY A MAPPING RATHER THAN A SECOND PAYMENT DOOR. This platform already verifies x402
 * proofs properly: an EIP-3009 authorization is checked against the payer's own
 * signature, the chain id and token address are committed inside the signed domain, a
 * nonce is unique per network in the database rather than in a cache, and the door fails
 * closed with no settlement address configured. What it did NOT speak was the ecosystem's
 * message flow: AP2 states intent and budget, the A2A x402 extension carries the payment
 * states on a task, and a client written against that flow could not drive this door.
 * Publishing a catalogue at /api/x402 is discovery; this is interoperability, and they
 * are different things.
 *
 * THE WIRE VOCABULARY, AS THE EXTENSION DEFINES IT. The extension URI is declared in the
 * agent card and activated per request by an `X-A2A-Extensions` header the server echoes
 * back. Payment state travels on a message's metadata under `x402.payment.*`: a status
 * from a fixed set of six, the requirements object, the client's payload, a receipts
 * array that ACCUMULATES across a negotiation rather than being replaced, and an error
 * object with a code. The flow begins with an input-required task whose metadata carries
 * the requirements, and the client's reply must name the original task.
 *
 * WHAT THIS MODULE WILL NOT DO. It will not weaken the verifier to fit a friendlier
 * vocabulary: the statuses are a projection of what `acceptPayment` actually decided, so
 * a proof that fails closed here fails closed there too. And the error code mapping keeps
 * the platform's own code beside the extension's, because a mapping between two
 * vocabularies that loses the original term is a translation nobody can audit.
 */

/** The extension's identifier, exactly as it must be spelled in a header. */
export const X402_EXTENSION_URI = "https://github.com/google-a2a/a2a-x402/v0.1";

/**
 * The six states, in the order a negotiation passes through them.
 *
 * `payment-submitted` is what a client sends; `payment-required` is the platform asking;
 * `payment-verified` and `payment-completed` are different facts and stay different, one
 * being a checked signature and the other funds having moved; `payment-rejected` is the
 * client withdrawing; `payment-failed` is a proof that did not check.
 */
export const X402_STATUSES = [
  "payment-required",
  "payment-submitted",
  "payment-verified",
  "payment-completed",
  "payment-rejected",
  "payment-failed",
] as const;

export type X402Status = (typeof X402_STATUSES)[number];

/** A receipt as the extension carries it. The array accumulates; it is never replaced. */
export type X402Receipt = {
  network: string;
  payer: string;
  amount: string;
  /** `verified` and `settled` are distinct: one checked a signature, the other moved funds. */
  status: "verified" | "settled";
  transaction: string | null;
  at: string;
};

/** The error codes the extension names, mapped from this platform's own refusals. */
const ERROR_CODES: Record<string, string> = {
  REPLAY: "DUPLICATE_NONCE",
  EXPIRED: "EXPIRED_PAYMENT",
  NOT_YET_VALID: "PAYMENT_NOT_YET_VALID",
  UNDERPAID: "INSUFFICIENT_FUNDS",
  BAD_SIGNATURE: "INVALID_SIGNATURE",
  WRONG_RECIPIENT: "INVALID_RECIPIENT",
  NOT_CONFIGURED: "PAYMENT_REQUIRED",
};

/** The extension's error name for a platform refusal, with the platform's own code kept. */
export function paymentError(code: string, message: string): { code: string; message: string; platform_code: string } {
  return {
    code: ERROR_CODES[code] ?? "PAYMENT_INVALID",
    message,
    // Kept deliberately. The two vocabularies are not one to one, and a reader debugging
    // a refusal needs the term this deployment actually raised.
    platform_code: code,
  };
}

/** The metadata that hands a client the terms. */
export function requiredMetadata(input?: { resource?: string; amountAtomic?: string; description?: string }) {
  const catalogue = paymentRequirements(input);
  if (!catalogue.configured) {
    // The door says which variable is missing rather than pretending the price is zero.
    return {
      "x402.payment.status": "payment-failed" as X402Status,
      "x402.payment.error": paymentError("NOT_CONFIGURED", catalogue.error ?? "Payments are not configured on this deployment."),
    };
  }
  return {
    "x402.payment.status": "payment-required" as X402Status,
    "x402.payment.required": {
      x402Version: catalogue.x402Version ?? 1,
      accepts: catalogue.accepts,
    },
  };
}

/** What a verified or settled proof looks like to an extension client. */
export function paidMetadata(outcome: Extract<PaymentOutcome, { ok: true }>, prior: X402Receipt[] = []) {
  return {
    // Settled and verified are different facts, so the status differs: claiming
    // `payment-completed` for a checked signature would tell a client funds had moved
    // when none had.
    "x402.payment.status": (outcome.status === "settled" ? "payment-completed" : "payment-verified") as X402Status,
    "x402.payment.receipts": [
      ...prior,
      {
        network: outcome.network,
        payer: outcome.payer,
        amount: outcome.amount,
        status: outcome.status,
        transaction: outcome.settlementRef,
        at: new Date().toISOString(),
      } satisfies X402Receipt,
    ],
  };
}

/** A refusal, in the extension's own error shape. */
export function failedMetadata(outcome: Extract<PaymentOutcome, { ok: false }>) {
  return {
    "x402.payment.status": "payment-failed" as X402Status,
    "x402.payment.error": paymentError(outcome.code, outcome.reason),
  };
}

/**
 * Did this request ask for the extension?
 *
 * The header is how the extension is activated, and the server echoes it, so a client
 * can tell that the server understood rather than merely tolerating it. Declaring the
 * URI in the agent card is not the same as a request opting in, and both are checked.
 */
export function extensionRequested(req: Request): boolean {
  const header = req.headers.get("x-a2a-extensions") ?? "";
  return header.split(",").map((h) => h.trim()).includes(X402_EXTENSION_URI);
}

/** The response headers an extension request gets: the same list, echoed. */
export function extensionHeaders(req: Request, extra: Record<string, string> = {}): Record<string, string> {
  const header = req.headers.get("x-a2a-extensions") ?? "";
  const asked = extensionRequested(req);
  return {
    ...(asked ? { "x-a2a-extensions": X402_EXTENSION_URI } : {}),
    ...extra,
    ...(header && !asked ? { "x-a2a-extensions-supported": X402_EXTENSION_URI } : {}),
  };
}

/** Whether a proof would be settled or only verified, said in the reply rather than implied. */
export function settlementNote(): string {
  return shouldSettle()
    ? "Settlement is enabled on this deployment, so an accepted proof is relayed to the facilitator and the task's state becomes payment-completed."
    : "Settlement is not enabled on this deployment, so an accepted proof is verified and recorded and the state stops at payment-verified. No funds move.";
}

/** The extension block an agent card declares, so discovery precedes any negotiation. */
export function agentCardExtension() {
  return {
    uri: X402_EXTENSION_URI,
    description:
      "The x402 payment extension: a task may be gated behind a payment, the terms travel in the task's metadata as `x402.payment.required`, and the client's reply names the original task and carries its signed EIP-3009 proof. Activate it with an `X-A2A-Extensions` header.",
    required: false,
    states: X402_STATUSES,
  };
}
