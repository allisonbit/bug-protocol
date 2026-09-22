import { supabaseAdmin } from "@/lib/supabase";
import { money, topTier } from "@/lib/db";

/**
 * THE MONEY SIDE OF A BOUNTY, WRITTEN DOWN WHERE EVERYONE CAN SEE IT.
 *
 * The finding lifecycle has been on the bus from the start. Nothing recorded what
 * pays for a finding: a programme opening, escrow standing behind it, a reward
 * actually leaving, or a programme closing. So the half of the product a hunter
 * most needs to trust was the half with no public record at all, and "backed by
 * real escrow" was a sentence on a page rather than a row on the log.
 *
 * WHY THESE ARE SYSTEM EVENTS AND NOT SIGNED ONES. A row here is a fact about a
 * balance the platform is holding for somebody, so it has to be the platform's
 * own record rather than an agent's claim. These are written with
 * `provenance: "system"` and no signature, exactly the way `tip.received` and the
 * machine events are, and they are deliberately kept OUT of VALID_TOPICS in
 * lib/agents/ingest.ts: a signed escrow fact would be an unbacked assertion about
 * money, which is the one thing this bus exists to make impossible.
 *
 * A failed write is logged and swallowed. The escrow row in `programs` is the
 * ledger of record; the event is the public trace of it, and a feed hiccup must
 * not roll back a payment the owner already made. That is the same rule the tip
 * door follows.
 */

export type EscrowTopic = "program.opened" | "program.funded" | "reward.paid" | "program.closed";

type Programish = {
  slug: string;
  name: string;
  currency: string;
};

async function emit(topic: EscrowTopic, payload: Record<string, unknown>): Promise<void> {
  const sb = supabaseAdmin();
  if (!sb) return;
  const { error } = await sb.from("events").insert({
    topic,
    agent_id: null,
    agent_handle: null,
    payload,
    signature: null,
    signed_ok: false,
    provenance: "system",
  });
  if (error) console.warn(`[write refused] events:${topic}: ${error.message ?? error}`);
}

/** A programme now takes reports. Emitted when it goes live, not while it is a draft. */
export async function emitProgramOpened(
  p: Programish & { tier_low: number; tier_medium: number; tier_high: number; tier_critical: number },
): Promise<void> {
  const top = topTier(p);
  await emit("program.opened", {
    text: `a programme opened: ${p.name}, up to ${money(top, p.currency)}`,
    program: p.slug,
    name: p.name,
    currency: p.currency,
    top_reward: money(top, p.currency),
  });
}

/** A balance moved into escrow, with the new total, so a reader sees the balance, not just a delta. */
export async function emitProgramFunded(
  p: Programish & { pool: number; added: number },
): Promise<void> {
  await emit("program.funded", {
    text: `${money(p.added, p.currency)} went into ${p.name}, now ${money(p.pool, p.currency)}`,
    program: p.slug,
    name: p.name,
    currency: p.currency,
    amount: money(p.added, p.currency),
    pool: money(p.pool, p.currency),
  });
}

/** A payout left escrow for an accepted finding. The promise the whole product rests on. */
export async function emitRewardPaid(
  p: Programish & { amount: number; severity: string; submission: string },
): Promise<void> {
  await emit("reward.paid", {
    text: `${money(p.amount, p.currency)} for a ${p.severity} finding left escrow in ${p.name}`,
    program: p.slug,
    name: p.name,
    currency: p.currency,
    amount: money(p.amount, p.currency),
    severity: p.severity,
    submission: p.submission,
  });
}

/** A programme no longer takes reports, and says what it paid out before it stopped. */
export async function emitProgramClosed(p: Programish & { paid_out: number }): Promise<void> {
  await emit("program.closed", {
    text: `${p.name} closed, having paid out ${money(p.paid_out, p.currency)}`,
    program: p.slug,
    name: p.name,
    currency: p.currency,
    paid_out: money(p.paid_out, p.currency),
  });
}
