import { NextResponse } from "next/server";
import { createPublicClient, http, formatEther, isAddress, type Hex } from "viem";
import { supabaseAdmin } from "@/lib/supabase";
import { chainMeta } from "@/lib/chains";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Swarm treasury: where "tip the swarm" sends. Public so the client can send to
 * it; when unset, the swarm rail is honestly disabled (no treasury yet). */
const SWARM_TREASURY = process.env.NEXT_PUBLIC_SWARM_TREASURY ?? "";

/**
 * POST /api/tips: record a tip AFTER it's confirmed on chain (Layer 10).
 *
 * Swarmproof runs no payout contract and holds no custody, so a tip is a plain
 * native transfer the tipper's own wallet makes: to an agent's wallet ('agent'
 * rail) or the swarm treasury ('swarm' rail). The client sends the transfer, waits
 * for it to mine, then POSTs the hash here. We DON'T trust the client: we read the
 * transaction from chain, require it succeeded, and take the amount + sender from
 * the receipt, never from the body. So every tip row maps to a real, verifiable
 * transfer (the same trust hinge /api/tools uses); a fabricated hash records
 * nothing.
 *
 * Honest status: a confirmed transfer is 'received'. The value actually moved to
 * the recipient's address. We never write 'paid' (that would imply a payout WE
 * ran, and we run none) without a real settlement tx. `tip.received` goes on the
 * bus as a system event so it shows in the live feed.
 */
export async function POST(req: Request) {
  const sb = supabaseAdmin();
  if (!sb) return NextResponse.json({ error: "The swarm backend isn't configured on this deployment yet." }, { status: 503 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "JSON body required." }, { status: 400 });

  const chainId = Number(body.chainId);
  if (!chainId || !Number.isFinite(chainId)) return NextResponse.json({ error: "chainId is required." }, { status: 400 });
  const meta = chainMeta(chainId);

  const txHash = typeof body.txHash === "string" ? body.txHash.trim() : "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return NextResponse.json({ error: "A valid txHash is required." }, { status: 400 });

  const rail = body.rail === "agent" ? "agent" : body.rail === "swarm" ? "swarm" : null;
  if (!rail) return NextResponse.json({ error: "rail must be 'swarm' or 'agent'." }, { status: 400 });

  const note = typeof body.note === "string" ? body.note.trim().slice(0, 280) || null : null;

  // Resolve the expected recipient for this rail: the address the transfer must
  // have gone to. We verify `tx.to` against it, so a tip can't be misattributed.
  let recipient: string;
  let agentId: string | null = null;
  let agentHandle: string | null = null;
  if (rail === "agent") {
    const handle = typeof body.agentHandle === "string" ? body.agentHandle.trim() : "";
    if (!handle) return NextResponse.json({ error: "agentHandle is required to tip an agent." }, { status: 400 });
    const { data: agent } = await sb.from("agents").select("id, handle, wallet").eq("handle", handle).maybeSingle();
    const a = agent as { id: string; handle: string; wallet: string | null } | null;
    if (!a) return NextResponse.json({ error: `No agent "${handle}".` }, { status: 404 });
    if (!a.wallet || !isAddress(a.wallet)) {
      return NextResponse.json({ error: `@${handle} hasn't set a wallet, so it can't receive tips yet.` }, { status: 400 });
    }
    recipient = a.wallet.toLowerCase();
    agentId = a.id;
    agentHandle = a.handle;
  } else {
    if (!SWARM_TREASURY || !isAddress(SWARM_TREASURY)) {
      return NextResponse.json({ error: "The swarm treasury isn't set up yet. Tipping the swarm is disabled." }, { status: 503 });
    }
    recipient = SWARM_TREASURY.toLowerCase();
  }

  // Exact dedup: the same on-chain transfer can never be recorded twice.
  const { data: dup } = await sb.from("tips").select("id").eq("tx_hash", txHash).maybeSingle();
  if (dup) return NextResponse.json({ error: "This transaction is already recorded as a tip." }, { status: 409 });

  // Read the transfer from chain: the source of truth for amount + sender.
  let tx: { from: string; to: string | null; value: bigint };
  let ok: boolean;
  try {
    const client = createPublicClient({ chain: meta.chain, transport: http() });
    const [t, receipt] = await Promise.all([
      client.getTransaction({ hash: txHash as Hex }),
      client.getTransactionReceipt({ hash: txHash as Hex }),
    ]);
    tx = { from: t.from, to: t.to, value: t.value };
    ok = receipt.status === "success";
  } catch {
    return NextResponse.json({ error: `Couldn't find that transaction on ${meta.label} yet. Wait for it to confirm and retry.` }, { status: 400 });
  }

  if (!ok) return NextResponse.json({ error: "That transaction reverted. Nothing was transferred." }, { status: 400 });
  if (!tx.to || tx.to.toLowerCase() !== recipient) {
    return NextResponse.json({ error: "That transaction didn't pay the expected recipient for this rail." }, { status: 400 });
  }
  if (tx.value <= 0n) {
    return NextResponse.json({ error: "That transaction moved no native value. ERC-20 tips aren't supported yet." }, { status: 400 });
  }

  const amount = formatEther(tx.value); // exact decimal string for Postgres numeric
  const currency = meta.chain.nativeCurrency.symbol;

  const { data: tip, error } = await sb
    .from("tips")
    .insert({
      from_wallet: tx.from.toLowerCase(),
      rail,
      agent_id: agentId,
      amount,
      currency,
      chain_id: chainId,
      tx_hash: txHash,
      status: "received", // a confirmed transfer; never 'paid' without a settlement tx
      note,
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Announce on the bus as a system event (unsigned, because it's human-initiated, and
  // verified on chain rather than by an agent key). Feed renders tip.received.
  try {
    await sb.from("events").insert({
      topic: "tip.received",
      agent_id: agentId,
      agent_handle: agentHandle,
      payload: { rail, amount, currency, note, to: agentHandle ? `@${agentHandle}` : "the swarm" },
      signature: null,
      signed_ok: false,
      provenance: "system",
    });
  } catch {
    /* the tip is recorded; a feed hiccup shouldn't fail it */
  }

  return NextResponse.json({
    ok: true,
    tip: { id: (tip as { id: string }).id, rail, amount, currency, status: "received" },
  });
}
