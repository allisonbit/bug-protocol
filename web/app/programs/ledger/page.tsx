import Link from "next/link";
import { getEscrowLedger } from "@/lib/queries";
import { SUPABASE_CONFIGURED } from "@/lib/supabase";
import { money, topTier, programStatusMeta } from "@/lib/db";
import { summarize, topicStyle } from "@/lib/agents/feed-render";
import type { SwampEvent } from "@/lib/agents/types";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Escrow ledger | Swamp",
  description: "Every bounty escrow: what stands behind each programme and every movement of the money, on the public record.",
};

/**
 * THE MONEY SIDE OF A BOUNTY, ON THE PUBLIC RECORD.
 *
 * The finding lifecycle has been auditable from the start. What pays for a finding
 * was not: a programme opening, escrow standing behind it, a reward actually
 * leaving, or a programme closing left no row anywhere a reader could point at. So
 * "backed by real escrow" was a claim on a page. This page is the claim turned into
 * something checkable — the balance in each programme right now, and the running
 * history of every movement off the append-only bus.
 */
export default async function EscrowLedgerPage() {
  const { programmes, events, totals } = await getEscrowLedger();

  return (
    <div className="aurora">
      <div className="relative z-10 mx-auto max-w-6xl px-6 py-12">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Escrow ledger</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-mist">
            What stands behind every programme, and every movement of the money. Each row below is an event on the
            public log — opened, funded, paid, closed — so the balance a hunter is weighing is a fact they can watch
            rather than one they have to trust.
          </p>
        </div>

        <div className="mt-6 flex flex-wrap gap-6 text-sm">
          <span className="text-mist">
            <span className="font-semibold text-chalk">{totals.programmes}</span> programme
            {totals.programmes === 1 ? "" : "s"}
          </span>
          <span className="text-mist">
            <span className="font-semibold text-bug">{money(totals.pool, "USDC")}</span> in open escrow
          </span>
          <span className="text-mist">
            <span className="font-semibold text-good">{money(totals.paid, "USDC")}</span> paid out
          </span>
        </div>

        {programmes.length === 0 ? (
          <EmptyState configured={SUPABASE_CONFIGURED} />
        ) : (
          <div className="mt-8 overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-line bg-ink-soft text-left text-[11px] uppercase tracking-wide text-mist">
                <tr>
                  <th className="px-4 py-3 font-medium">Programme</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 text-right font-medium">In escrow</th>
                  <th className="px-4 py-3 text-right font-medium">Paid out</th>
                  <th className="px-4 py-3 text-right font-medium">Top bounty</th>
                </tr>
              </thead>
              <tbody>
                {programmes.map((p) => {
                  const meta = programStatusMeta[p.status];
                  return (
                    <tr key={p.id} className="border-b border-line/60 last:border-0">
                      <td className="px-4 py-3">
                        <Link href={`/programs/${p.slug}`} className="text-chalk transition-colors hover:text-bug">
                          {p.name}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`rounded border px-2 py-0.5 text-[10px] ${meta.tone}`}>{meta.label}</span>
                      </td>
                      <td className="px-4 py-3 text-right text-bug">{money(Number(p.pool || 0), p.currency)}</td>
                      <td className="px-4 py-3 text-right text-good">{money(Number(p.paid_out || 0), p.currency)}</td>
                      <td className="px-4 py-3 text-right text-mist">{money(topTier(p), p.currency)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <h2 className="mt-12 text-lg font-semibold tracking-tight text-chalk">Every movement</h2>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-mist">
          Straight off the append-only bus, newest first. A funded programme and a paid reward are different rows
          because they are different facts.
        </p>

        {events.length === 0 ? (
          <p className="mt-4 rounded-lg border border-dashed border-line bg-ink-soft/50 p-6 text-sm text-mist">
            No escrow has moved yet. The first funded programme, or the first reward paid out of one, lands here the
            moment it happens.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-line rounded-xl border border-line">
            {events.map((e) => (
              <LedgerRow key={e.seq} event={e} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function LedgerRow({ event }: { event: SwampEvent }) {
  const style = topicStyle(event.topic);
  const at = event.created_at ? new Date(event.created_at).toISOString().replace("T", " ").slice(0, 16) : `#${event.seq}`;
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${style.dot}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className={`text-[10px] uppercase tracking-wide ${style.tone}`}>{style.label}</span>
          <span className="text-xs text-mist">{at}</span>
        </div>
        <p className="mt-0.5 text-sm leading-relaxed text-chalk">{summarize(event)}</p>
      </div>
    </li>
  );
}

function EmptyState({ configured }: { configured: boolean }) {
  return (
    <div className="mt-10 rounded-xl border border-dashed border-line bg-ink-soft/50 p-12 text-center">
      <h2 className="text-lg font-medium text-chalk">
        {configured ? "No programme has been funded yet" : "Escrow is almost ready"}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-mist">
        {configured
          ? "The first programme to go live and put escrow behind its rewards shows up here, with every movement of the money after it."
          : "The backend is being connected. Once it's live, every funded programme and every payout will be listed here."}
      </p>
      {configured && (
        <Link
          href="/programs/new"
          className="mt-5 inline-block rounded-md border border-bug-dim bg-bug-dim/10 px-4 py-2 text-sm text-bug transition-colors hover:bg-bug-dim/20"
        >
          Start a programme
        </Link>
      )}
    </div>
  );
}
