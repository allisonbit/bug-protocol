/**
 * LEASES: THE AUTHORITY ENVELOPE AROUND MOVING HARDWARE.
 *
 * A command that closes a relay is an act in the world. This module is the decision
 * that says whether such an act is authorized right now, and it is pure so every branch
 * can be exercised without a database or a machine: a live lease inside its window and
 * under its ceiling authorizes; a missing, expired, exhausted or revoked one refuses,
 * each with the reason a person reading the log needs.
 *
 * WHAT A LEASE BUYS, AND WHAT IT DOES NOT. A live lease says somebody with the standing
 * to say so authorized this act, until this instant, this many times, for this reason.
 * It does not say the actuation is safe, that the machine is well, or that the action is
 * correct. Those are different claims and this platform keeps them separate everywhere,
 * so it keeps them separate here: nothing in this module asserts a safety function.
 *
 * WHY THE CEILING AND THE EXPIRY ARE BOTH REQUIRED. An open ended authority is the thing
 * this exists to prevent. A lease that never expires is a permission; a lease that never
 * runs out is a licence. Bounding both is what makes revoking one row enough to stand a
 * site down, and it is why every refusal below names which bound was hit.
 */

/** The command names a lease may scope to, from the platform's closed palette. */
export type LeaseScope = "report_now" | "set_interval" | "pulse_relay";

/** A lease as the table keeps it. */
export type LeaseRow = {
  id: string;
  machine_id: string;
  machine_name: string;
  scope: string;
  expires_at: string;
  max_actuations: number;
  used_actuations: number;
  issued_by?: string | null;
  issued_by_agent?: string | null;
  reason: string;
  revoked_at?: string | null;
  revoked_reason?: string | null;
  created_at: string;
};

/** Which palette commands are actuations, so a lease can be required only of those. */
export const ACTUATION_SCOPES: LeaseScope[] = ["pulse_relay"];

/** True when acting on this command needs a lease. Reporting commands do not. */
export function needsLease(command: string): boolean {
  return (ACTUATION_SCOPES as string[]).includes(command);
}

export type LeaseDecision =
  | { ok: true; lease: LeaseRow; remaining: number; reason: string }
  | { ok: false; code: string; reason: string };

/**
 * Whether this lease authorizes this act right now.
 *
 * ORDER OF THE CHECKS IS THE ORDER OF THE CLAIMS. Revocation is checked first because a
 * revoked lease is revoked whatever the clock says. Then expiry, then exhaustion: each
 * is a different fact and each refusal names the one that applied, because "not
 * authorized" without the reason is what sends an operator looking at the wrong row.
 */
export function leaseMayAct(input: {
  lease: LeaseRow | null | undefined;
  scope: string;
  nowMs: number;
}): LeaseDecision {
  const lease = input.lease;
  if (!lease) {
    return {
      ok: false,
      code: "NO_LEASE",
      reason: `No lease authorizes ${input.scope}, and an actuation without a live lease is refused, because authority to move hardware is a row somebody wrote down.`,
    };
  }
  if (lease.scope !== input.scope) {
    return {
      ok: false,
      code: "WRONG_SCOPE",
      reason: `Lease ${lease.id} authorizes ${lease.scope}, not ${input.scope}. A scope is not a suggestion: a lease for one act does not carry another.`,
    };
  }
  if (lease.revoked_at) {
    return {
      ok: false,
      code: "REVOKED",
      reason: `Lease ${lease.id} was revoked at ${lease.revoked_at}${lease.revoked_reason ? ` (${lease.revoked_reason})` : ""}, so it authorizes nothing regardless of its other bounds.`,
    };
  }
  const expires = Date.parse(lease.expires_at);
  if (!Number.isFinite(expires)) {
    return {
      ok: false,
      code: "BAD_EXPIRY",
      reason: `Lease ${lease.id} has an unreadable expiry (${lease.expires_at}), and an unreadable bound is treated as no bound at all, which is refused.`,
    };
  }
  if (input.nowMs >= expires) {
    return {
      ok: false,
      code: "EXPIRED",
      reason: `Lease ${lease.id} expired at ${lease.expires_at}, which is before now. An expired lease is a permission that has ended.`,
    };
  }
  if (lease.used_actuations >= lease.max_actuations) {
    return {
      ok: false,
      code: "EXHAUSTED",
      reason: `Lease ${lease.id} has been used ${lease.used_actuations} of ${lease.max_actuations} times, so it authorizes nothing more. A ceiling of one means one.`,
    };
  }
  return {
    ok: true,
    lease,
    remaining: lease.max_actuations - lease.used_actuations - 1,
    reason: `Lease ${lease.id} authorizes ${lease.scope} on ${lease.machine_name} until ${lease.expires_at}, ${lease.max_actuations - lease.used_actuations} actuation(s) remaining.`,
  };
}

/**
 * The live lease for a machine and scope, or null.
 *
 * When more than one is live the EARLIEST EXPIRY wins, which is the conservative choice:
 * a caller with two overlapping grants is held to the one that ends soonest, so an
 * accidental second lease cannot quietly extend an authority nobody renewed.
 */
export function pickLease(rows: LeaseRow[], scope: string): LeaseRow | null {
  const live = rows.filter((l) => l.scope === scope && !l.revoked_at);
  if (live.length === 0) return null;
  return live.slice().sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at))[0];
}

/** The rules a lease must satisfy to be issued at all. */
export function leaseIssuable(input: {
  machineName: string;
  scope: unknown;
  expiresAtMs: number;
  maxActuations: unknown;
  reason: unknown;
  nowMs: number;
}): { ok: true; scope: LeaseScope; maxActuations: number; reason: string } | { ok: false; code: string; reason: string } {
  const scope = typeof input.scope === "string" ? input.scope.trim() : "";
  if (!["report_now", "set_interval", "pulse_relay"].includes(scope)) {
    return { ok: false, code: "BAD_SCOPE", reason: "`scope` must name one of the platform's closed palette commands: report_now, set_interval or pulse_relay." };
  }
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";
  if (reason.length < 10) {
    return { ok: false, code: "REASON_REQUIRED", reason: "A lease needs a `reason` of at least 10 characters. A grant with no reason is indistinguishable from a grant nobody thought about." };
  }
  const max = Number(input.maxActuations);
  if (!Number.isInteger(max) || max < 1 || max > 100) {
    return { ok: false, code: "BAD_CEILING", reason: "`max_actuations` must be an integer from 1 to 100. A lease with no ceiling is a licence, which is what this table exists to prevent." };
  }
  if (!Number.isFinite(input.expiresAtMs)) {
    return { ok: false, code: "BAD_EXPIRY", reason: "`expires_at` must be an ISO timestamp the lease's authority ends at." };
  }
  if (input.expiresAtMs <= input.nowMs) {
    return { ok: false, code: "ALREADY_EXPIRED", reason: `The lease would expire at ${new Date(input.expiresAtMs).toISOString()}, which is not after now, so it would authorize nothing from the moment it was written.` };
  }
  const maxHorizon = input.nowMs + 30 * 24 * 60 * 60 * 1000;
  if (input.expiresAtMs > maxHorizon) {
    return { ok: false, code: "TOO_LONG", reason: "A lease may not run longer than 30 days. An authority nobody has to renew is one nobody revisits." };
  }
  return { ok: true, scope: scope as LeaseScope, maxActuations: max, reason };
}
