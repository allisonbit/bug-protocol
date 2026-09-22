"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { issueMachineLease, revokeMachineLease } from "@/app/actions";
import { timeAgo } from "@/lib/db";
import type { LeaseRow } from "@/lib/machines/leases";

/**
 * AUTHORITY, ON THE PAGE.
 *
 * The lease machinery has been enforced at every actuating door from the start, and
 * nothing rendered it, so the authority around a machine was visible only to whoever
 * called the API. This is the missing half: what a lease is, which ones are live, and
 * the two acts that write one — issuing, and the operator's stand-down.
 *
 * The LIST is public. A grant of authority to move hardware is exactly the kind of row
 * this platform publishes rather than hides, and a hunter of machine incidents needs to
 * see who authorized what, until when, how many times and why.
 *
 * The FORMS are the owner's only. An agent may act inside an authority a person wrote
 * down; it may not write itself one. That split is the whole reason the controls are
 * gated here rather than simply hidden behind the API.
 */

type Lease = LeaseRow & { issuer?: { handle: string | null; display_name: string | null } | null };

/** The state a reader cares about, derived from the same bounds the doors enforce. */
function stateOf(lease: Lease, nowMs: number): { label: string; tone: string; why: string } {
  if (lease.revoked_at) {
    return { label: "revoked", tone: "bg-warn/15 text-warn", why: lease.revoked_reason ?? "withdrawn by its issuer" };
  }
  const expires = Date.parse(lease.expires_at);
  if (!Number.isFinite(expires)) return { label: "unreadable", tone: "bg-warn/15 text-warn", why: "an expiry that cannot be read is treated as no bound" };
  if (nowMs >= expires) return { label: "expired", tone: "bg-panel-2 text-mist", why: "a permission that has ended" };
  if (lease.used_actuations >= lease.max_actuations) {
    return { label: "exhausted", tone: "bg-panel-2 text-mist", why: `${lease.used_actuations} of ${lease.max_actuations} used` };
  }
  return { label: "live", tone: "bg-lime/15 text-bug", why: `${lease.max_actuations - lease.used_actuations} actuation(s) remaining` };
}

function issuerName(lease: Lease): string {
  const who = lease.issuer;
  if (who) return who.display_name ?? (who.handle ? `@${who.handle}` : "a person");
  if (lease.issued_by_agent) return "an agent";
  return lease.issued_by ? "a person" : "the platform";
}

export function AuthoritySection({
  machine,
  leases,
  isOwner,
}: {
  machine: { name: string; kind: string };
  leases: Lease[];
  isOwner: boolean;
}) {
  const nowMs = Date.now();
  const live = leases.filter((l) => stateOf(l, nowMs).label === "live");

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xs uppercase tracking-widest text-mist">Authority</h2>
        <p className="text-xs text-mist">
          {live.length > 0 ? (
            <span className="text-bug">
              {live.length} live lease{live.length === 1 ? "" : "s"}
            </span>
          ) : (
            "no live lease: an actuation now would be refused"
          )}
        </p>
      </div>

      <p className="mt-2 max-w-2xl text-xs leading-relaxed text-mist">
        A lease is the authority envelope around moving this machine: a scope, an expiry, a ceiling on how many
        times, an issuer and a reason. An actuation without a live lease for its scope is refused by every door
        that can move hardware. It is not a safety mechanism and it does not certify that an actuation is safe.
      </p>

      {leases.length === 0 ? (
        <p className="mt-3 text-sm leading-relaxed text-mist">
          No lease has ever been issued for this machine, so nothing here has been authorized to actuate. A person
          issues one {isOwner ? "below" : "from their dashboard"}.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {leases.map((l) => {
            const state = stateOf(l, nowMs);
            return (
              <li key={l.id} className="rounded-lg bg-ink-soft p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${state.tone}`}>{state.label}</span>
                  <span className="font-mono text-chalk">{l.scope}</span>
                  <span className="text-mist">
                    {l.used_actuations} of {l.max_actuations} actuation{l.max_actuations === 1 ? "" : "s"} used
                  </span>
                  <span className="text-mist">
                    {state.label === "live" ? `until ${new Date(l.expires_at).toISOString().replace("T", " ").slice(0, 16)}` : state.why}
                  </span>
                  <span className="ml-auto text-mist">{timeAgo(l.created_at)}</span>
                </div>
                <p className="mt-1.5 leading-relaxed text-mist-bright">
                  {l.reason} <span className="text-mist">— issued by {issuerName(l)}</span>
                </p>
                {isOwner && state.label !== "revoked" && (
                  <form action={revokeMachineLease} className="mt-2 flex flex-wrap items-center gap-2">
                    <input type="hidden" name="machine" value={machine.name} />
                    <input type="hidden" name="lease_id" value={l.id} />
                    <input
                      name="reason"
                      required
                      minLength={10}
                      placeholder="why this authority is withdrawn"
                      className="min-w-0 flex-1 rounded border border-line bg-ink px-2 py-1 text-[11px] text-chalk outline-none focus:border-bug-dim"
                    />
                    <RevokeButton />
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {isOwner && <IssueForm machine={machine} />}
    </section>
  );
}

const SCOPES = [
  { value: "pulse_relay", label: "pulse_relay (actuation)", hint: "close a relay for a bounded time" },
  { value: "report_now", label: "report_now", hint: "ask for a reading; needs no lease to happen, but may be granted" },
  { value: "set_interval", label: "set_interval", hint: "change the reporting cadence" },
];

function IssueForm({ machine }: { machine: { name: string; kind: string } }) {
  const [open, setOpen] = useState(false);
  const canActuate = machine.kind === "actuator" || machine.kind === "robot";

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-3 rounded-md border border-bug-dim bg-bug-dim/10 px-3 py-1.5 text-xs text-bug transition-colors hover:bg-bug-dim/20"
      >
        Issue a lease
      </button>
    );
  }

  return (
    <form action={issueMachineLease} className="mt-3 rounded-xl border border-bug-dim/30 bg-bug-dim/[0.04] p-4">
      <input type="hidden" name="machine" value={machine.name} />
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-[11px] text-mist">
          <span className="block tracking-wide uppercase">Scope</span>
          <select
            name="scope"
            defaultValue={canActuate ? "pulse_relay" : "report_now"}
            className="mt-1 w-full rounded border border-line bg-ink px-2 py-1.5 text-xs text-chalk outline-none focus:border-bug-dim"
          >
            {SCOPES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-[11px] text-mist">
          <span className="block tracking-wide uppercase">Expires in (minutes)</span>
          <input
            name="expires_minutes"
            type="number"
            min="1"
            max="43200"
            defaultValue={60}
            required
            className="mt-1 w-full rounded border border-line bg-ink px-2 py-1.5 text-xs text-chalk outline-none focus:border-bug-dim"
          />
        </label>
        <label className="block text-[11px] text-mist">
          <span className="block tracking-wide uppercase">At most (actuations)</span>
          <input
            name="max_actuations"
            type="number"
            min="1"
            max="100"
            defaultValue={1}
            required
            className="mt-1 w-full rounded border border-line bg-ink px-2 py-1.5 text-xs text-chalk outline-none focus:border-bug-dim"
          />
        </label>
      </div>
      <label className="mt-3 block text-[11px] text-mist">
        <span className="block tracking-wide uppercase">Reason (at least 10 characters)</span>
        <textarea
          name="reason"
          required
          minLength={10}
          rows={2}
          placeholder="certified rig test on the production cell"
          className="mt-1 w-full rounded border border-line bg-ink px-2 py-1.5 text-xs text-chalk outline-none focus:border-bug-dim"
        />
      </label>
      <div className="mt-3 flex items-center gap-2">
        <Submit label="Issue it" />
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-mist hover:text-chalk">
          cancel
        </button>
        <span className="text-[11px] text-mist">
          A grant with no reason is indistinguishable from a grant nobody thought about.
        </span>
      </div>
    </form>
  );
}

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md border border-bug-dim bg-bug-dim/15 px-3 py-1.5 text-xs text-bug transition-colors hover:bg-bug-dim/25 disabled:opacity-50"
    >
      {pending ? "writing..." : label}
    </button>
  );
}

function RevokeButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="shrink-0 rounded border border-red-500/40 bg-red-500/5 px-2 py-1 text-[11px] text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
    >
      {pending ? "..." : "Revoke"}
    </button>
  );
}
