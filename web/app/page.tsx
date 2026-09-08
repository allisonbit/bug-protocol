import Link from "next/link";
import { isDeployed, BOUNTY_ADDRESS } from "@/lib/contract";
import { addressUrl } from "@/lib/chain";

const invariants = [
  {
    n: "01",
    title: "Your report never touches the chain in plaintext",
    body: "A public vulnerability report is a live exploit handed to everyone. You submit a hash — keccak256(reportURI, salt, your address) — and the body goes to the client encrypted, off chain. Disclosure happens after the fix ships, not before.",
    detail:
      "Your address is baked into the hash. Someone watching the mempool can copy it, but they can't produce a preimage that opens to their own address without already knowing your report. Priority is yours.",
  },
  {
    n: "02",
    title: "A program can't open without funded escrow",
    body: "Going live requires four things at once: a signed scope and safe-harbour document, a payout tier, escrow covering the top severity, and the client's own slashable bond. No exceptions, no admin override.",
    detail:
      "Every un-triaged report stays fully covered — submissions are refused when the pool couldn't pay them all. Concurrency is capped by what the client actually funded. That's the trade for a real guarantee.",
  },
  {
    n: "03",
    title: "A client can't accept your finding and then not pay",
    body: "Acceptance moves the money out of escrow into a claim only you can withdraw, in the same transaction. There is no separate payment step to stall on, no invoice, no email thread.",
    detail:
      "Go silent instead and the SLA lapses — you escalate, an arbiter rules, and the client's bond is forfeit pro rata to whatever went unpaid.",
  },
];

export default function Home() {
  return (
    <>
      <section className="grid-bg border-b border-line">
        <div className="mx-auto max-w-5xl px-6 py-24">
          <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 text-xs text-mist">
            <span className="size-1.5 rounded-full bg-bug" aria-hidden />
            Robinhood Chain · id 4663
          </p>
          <h1 className="max-w-3xl text-4xl leading-tight font-semibold tracking-tight text-balance sm:text-5xl">
            Bug bounties that <span className="text-bug">can&apos;t stiff you</span>.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-mist text-pretty">
            Companies fund a program. The community finds the bugs. Accepted findings pay out of
            escrow the client cannot reclaim — enforced by the contract, not by a support ticket.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <Link
              href="/programs"
              className="rounded border border-bug-dim bg-bug-dim/10 px-5 py-2.5 text-sm text-bug transition-colors hover:bg-bug-dim/20"
            >
              browse programs
            </Link>
            <Link
              href="/how"
              className="rounded border border-line px-5 py-2.5 text-sm text-chalk transition-colors hover:border-mist"
            >
              how it works
            </Link>
          </div>
          {!isDeployed && (
            <p className="mt-10 max-w-2xl border-l-2 border-warn pl-4 text-sm leading-relaxed text-mist">
              <span className="text-warn">Pre-launch.</span> The contracts are written and tested
              but not yet deployed, so there are no live programs to show. Nothing on this site is
              simulated — when the protocol ships, this page reads its state directly from the
              chain.
            </p>
          )}
          {isDeployed && BOUNTY_ADDRESS && (
            <p className="mt-10 text-xs text-mist">
              protocol at{" "}
              <a className="text-bug underline underline-offset-4" href={addressUrl(BOUNTY_ADDRESS)}>
                {BOUNTY_ADDRESS}
              </a>
            </p>
          )}
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-6 py-20">
        <h2 className="text-xs tracking-widest text-mist uppercase">
          Three things the contract guarantees
        </h2>
        <div className="mt-10 grid gap-px overflow-hidden rounded-lg border border-line bg-line">
          {invariants.map((it) => (
            <article key={it.n} className="bg-ink-soft p-8">
              <div className="flex items-baseline gap-4">
                <span className="text-xs text-bug-dim">{it.n}</span>
                <h3 className="text-lg font-medium tracking-tight text-chalk text-balance">
                  {it.title}
                </h3>
              </div>
              <p className="mt-4 max-w-3xl leading-relaxed text-mist text-pretty">{it.body}</p>
              <p className="mt-3 max-w-3xl border-l border-line pl-4 text-sm leading-relaxed text-mist/70 text-pretty">
                {it.detail}
              </p>
            </article>
          ))}
        </div>
      </section>

      <section className="border-t border-line bg-ink-soft">
        <div className="mx-auto max-w-5xl px-6 py-20">
          <h2 className="text-xs tracking-widest text-mist uppercase">Where $BUG is actually used</h2>
          <p className="mt-6 max-w-2xl leading-relaxed text-mist text-pretty">
            Not as a payment rail — clients fund rewards in ETH or a stablecoin, because that&apos;s
            what hunters want to be paid in. $BUG does the job a dollar can&apos;t: it bonds good
            faith on both sides, because a bond has to be <em>forfeitable</em> to mean anything.
          </p>
          <dl className="mt-10 grid gap-8 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-chalk">Clients post a slashable bond</dt>
              <dd className="mt-2 text-sm leading-relaxed text-mist text-pretty">
                Uphold a finding they refused to pay and the bond is forfeit to the hunter, pro rata
                to the unpaid share. This is the pain point real bounty platforms never solved.
              </dd>
            </div>
            <div>
              <dt className="text-sm text-chalk">Hunters post an anti-spam bond</dt>
              <dd className="mt-2 text-sm leading-relaxed text-mist text-pretty">
                Slashed only for bad faith — never for an honest miss. A rejected report costs you
                nothing, and a wrong spam call is reversible for seven days.
              </dd>
            </div>
          </dl>
        </div>
      </section>
    </>
  );
}
