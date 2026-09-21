import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { SITE_URL } from "@/lib/site";
import {
  X402_NETWORKS,
  X402_VERSION,
  acceptPayment,
  facilitatorUrl,
  payTo,
  paymentRequirements,
  priceAtomic,
  shouldSettle,
  type PaymentProof,
} from "@/lib/payments/x402";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Payment, X-Payment-Response",
  "Access-Control-Expose-Headers": "X-Payment-Response",
} as const;

/**
 * THE PAYMENT DOOR.
 *
 * GET  what this deployment charges, in the shape an x402 client reads
 * POST a proof, and be told exactly what happened to it
 *
 * WHY A SEPARATE DOOR AS WELL AS THE ONE ON A TASK. Settlement is worth being able
 * to test on its own: a payer wants to know whether its proof is good before it
 * wraps one around work, and an operator wants to see a refusal reason without
 * creating a task to get it. The proof accepted here is recorded like any other, so
 * a standalone check cannot be used to launder a nonce into a task submission: the
 * nonce is spent either way, which is the point of spending it.
 *
 * WHAT IT REFUSES TO CLAIM. Nothing here says funds moved. A verified proof is an
 * authorization the payer signed and this deployment checked; it becomes value when a
 * facilitator relays it, and the response distinguishes the two in a field called
 * `status` rather than in a sentence somebody has to read carefully.
 */
export async function GET() {
  const catalogue = paymentRequirements();
  return NextResponse.json(
    {
      ...catalogue,
      price_atomic_usdc: priceAtomic(),
      asset_symbol: "USDC",
      asset_decimals: 6,
      networks: Object.entries(X402_NETWORKS).map(([network, meta]) => ({
        network,
        chain_id: meta.chainId,
        usdc: meta.usdc,
        label: meta.label,
        explorer: meta.explorer,
        testnet: meta.testnet,
      })),
      settlement: {
        settles: shouldSettle() && Boolean(facilitatorUrl()),
        facilitator_configured: Boolean(facilitatorUrl()),
        settle_enabled: shouldSettle(),
        note: "Verification needs no facilitator and no key: it is one signature check against the token's own EIP-712 domain. Settlement needs a facilitator URL and X402_SETTLE=1, and this deployment never holds a payer's key.",
      },
      how_to_pay: {
        step_1: "Build an EIP-3009 TransferWithAuthorization over the chain and USDC address named above, with the amount in atomic units and a random 32 byte nonce.",
        step_2: "Sign it with EIP-712: domain { name: 'USD Coin', version: '2', chainId, verifyingContract: <asset> }, primary type TransferWithAuthorization.",
        step_3: `POST { x402Version: ${X402_VERSION}, scheme: "exact", network, payload: { signature, authorization } } to ${SITE_URL}/api/x402, or attach the same object to the task you are delegating so the work and its budget arrive together.`,
      },
      payments_url: `${SITE_URL}/api/x402`,
      docs: `${SITE_URL}/skill.md`,
      configured: Boolean(payTo()),
    },
    { headers: { ...CORS, "cache-control": "no-store" } },
  );
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "BAD_JSON", message: "The body must be JSON: either a payment proof, or { payment: <proof>, task_id?: <uuid> }." } },
      { status: 400, headers: { ...CORS, "cache-control": "no-store" } },
    );
  }

  const payload = (body ?? {}) as { payment?: PaymentProof; proof?: PaymentProof; task_id?: string; x402Version?: number };
  // Either shape works: the bare proof an x402 client sends, or the wrapped one a
  // caller uses when it is also naming a task.
  const proof = (payload.payment ?? payload.proof ?? (payload as PaymentProof)) as PaymentProof;
  const taskId = typeof payload.task_id === "string" && /^[0-9a-f-]{36}$/i.test(payload.task_id) ? payload.task_id : null;

  const outcome = await acceptPayment({ proof, taskId, sb: supabaseAdmin() });
  if (!outcome.ok) {
    return NextResponse.json(
      {
        ...paymentRequirements(),
        error: { code: outcome.code, message: outcome.reason },
      },
      { status: outcome.status, headers: { ...CORS, "cache-control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      accepted: true,
      // The distinction that matters to a payer: verified means this deployment
      // checked the authorization against the payer's own signature, settled means a
      // facilitator confirmed value moved.
      status: outcome.status,
      payment_id: outcome.id,
      payer: outcome.payer,
      network: outcome.network,
      amount: outcome.amount,
      settlement_ref: outcome.settlementRef,
      note: outcome.note,
      task_id: taskId,
    },
    { headers: { ...CORS, "cache-control": "no-store" } },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
