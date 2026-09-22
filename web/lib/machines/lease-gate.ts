import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { leaseMayAct, pickLease, type LeaseRow } from "./leases";

/**
 * THE ONE DOOR EVERY ACTUATION PASSES THROUGH.
 *
 * Why this file exists. The rule was already stated everywhere — an actuation needs a
 * live lease, and it is spent before the command is written — and it was implemented
 * in the agent's command tool while the swarm's own reflex wrote its command row
 * directly, with no lease column at all. So a resident's hand was held and the
 * pulse's hand was not, and the record proves it: an actuating command sits on the
 * log from the pulse with `lease_id` null, issued while `machine_leases` was empty.
 * Two implementations of one rule is how that happens, and one implementation is how
 * it stops happening.
 *
 * WHAT IT DOES, IN ORDER. It reads the leases for one machine and one scope, takes the
 * EARLIEST-expiring live one (pickLease, the conservative choice), asks the pure rule
 * whether that lease authorizes this act right now, and only then spends one actuation
 * from the ceiling. If any of those refuse, nothing is written anywhere and the caller
 * gets a code and a sentence a person can read.
 *
 * WHY IT DOES NOT FILTER REVOKED ROWS OUT OF THE READ. The first version did, and a
 * revoked lease then read as `NO_LEASE` — which is false about the record and useless to
 * the operator, who did write an authority and did withdraw it. `leaseMayAct` checks
 * revocation first for exactly this reason: the refusal is supposed to name the bound
 * that was hit. So the read carries every row for the scope, a live one wins if there is
 * one, and when there is not, THE MOST RECENT ROW decides the sentence: "revoked at
 * 21:40 because the check was done" and "no lease was ever written" are different facts
 * and a reader is entitled to the one that is true.
 *
 * WHY THE CEILING IS SPENT WITH A COMPARE-AND-SET. `used_actuations` is read, then
 * updated with the old value still in the WHERE clause, so a ceiling of one really is
 * one even when two beats race: the loser matches no row and is refused rather than
 * silently getting a second actuation. An increment that trusted the read would be a
 * ceiling on paper only.
 *
 * WHAT IT IS NOT. It is not a safety function and it does not judge whether the act is
 * correct. It answers one question — is there an authority for this, right now, under
 * its bounds — and it answers it in one place so that every door answers it the same.
 */

export type AuthorityGrant =
  | { ok: true; leaseId: string; scope: string; remaining: number; expiresAt: string }
  | { ok: false; code: string; reason: string };

export async function takeActuationAuthority(
  sb: SupabaseClient,
  input: { machineName: string; scope: string; nowMs?: number },
): Promise<AuthorityGrant> {
  const nowMs = input.nowMs ?? Date.now();

  const { data, error } = await sb
    .from("machine_leases")
    .select("*")
    .eq("machine_name", input.machineName)
    .eq("scope", input.scope);

  // A read that failed is not a lease. Refusing here is the same shape as refusing a
  // missing one, because on this question "I could not tell" and "no" lead to the
  // same safe act: nothing moves.
  if (error) {
    return { ok: false, code: "LEASE_UNREADABLE", reason: `The authority for ${input.machineName} could not be read (${error.message}), and an unreadable authority is not one.` };
  }

  const rows = (data as LeaseRow[] | null) ?? [];
  const newest = rows.slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null;
  const lease = pickLease(rows, input.scope) ?? newest;
  const may = leaseMayAct({ lease, scope: input.scope, nowMs });
  if (!may.ok) return { ok: false, code: may.code, reason: may.reason };

  const spend = may.lease.used_actuations + 1;
  const { data: consumed, error: spendErr } = await sb
    .from("machine_leases")
    .update({ used_actuations: spend })
    .eq("id", may.lease.id)
    .eq("used_actuations", may.lease.used_actuations)
    .select("id")
    .maybeSingle();

  if (spendErr || !consumed) {
    return {
      ok: false,
      code: "LEASE_NOT_CONSUMED",
      reason: `The authority for ${input.machineName} could not be spent${spendErr ? ` (${spendErr.message})` : ", because another act consumed its last actuation first"}, and an authority that cannot be spent is not spent.`,
    };
  }

  return {
    ok: true,
    leaseId: may.lease.id,
    scope: input.scope,
    remaining: Math.max(0, may.lease.max_actuations - spend),
    expiresAt: may.lease.expires_at,
  };
}
