const steps = [
  {
    who: "client",
    title: "Fund the program",
    body: "Create it with your scope and safe-harbour document, set a reward per severity, escrow enough to cover your top tier, and post your bond. Only then can it go live — the contract checks all four.",
  },
  {
    who: "hunter",
    title: "Commit, don't disclose",
    body: "Submit keccak256(reportURI, salt, your address) plus a small $BUG bond. The hash timestamps your finding and proves priority. The report itself goes to the client encrypted, off chain — it never touches the chain until a fix has shipped.",
  },
  {
    who: "client",
    title: "Triage inside the SLA",
    body: "Accept and the reward moves out of escrow into a claim only the hunter can withdraw, in that same transaction. Reject honestly and it costs the hunter nothing. Call it a duplicate and you must point at an earlier finding you already paid.",
  },
  {
    who: "hunter",
    title: "Escalate if ignored",
    body: "Miss the SLA and the hunter escalates to an arbiter. Escrow stays reserved the whole time, so it can't be withdrawn out from under an open report. Dispute a verdict you think is wrong within seven days.",
  },
  {
    who: "both",
    title: "Disclose after the fix",
    body: "Once the embargo lapses — or the client waives it early because it's patched — the hunter reveals the report and the chain verifies it's the one they committed to. Public record, reputation earned.",
  },
];

export default function How() {
  return (
    <section className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">How it works</h1>
      <p className="mt-3 leading-relaxed text-mist text-pretty">
        Five steps. The interesting part is what each one makes impossible.
      </p>

      <ol className="mt-12 space-y-px overflow-hidden rounded-lg border border-line bg-line">
        {steps.map((s, i) => (
          <li key={s.title} className="bg-ink-soft p-7">
            <div className="flex items-baseline gap-4">
              <span className="text-xs text-bug-dim tabular-nums">{String(i + 1).padStart(2, "0")}</span>
              <div>
                <span className="text-[10px] tracking-widest text-mist uppercase">{s.who}</span>
                <h2 className="mt-1 text-base font-medium text-chalk">{s.title}</h2>
              </div>
            </div>
            <p className="mt-4 leading-relaxed text-mist text-pretty">{s.body}</p>
          </li>
        ))}
      </ol>

      <div className="mt-16 rounded-lg border border-line bg-ink-soft p-7">
        <h2 className="text-sm text-chalk">The one limit worth knowing</h2>
        <p className="mt-3 leading-relaxed text-mist text-pretty">
          A program can only have as many open reports as its escrow can pay. Submissions are
          refused past that line. It&apos;s a real constraint and we&apos;re not hiding it — but
          it&apos;s the only way to promise that an accepted finding is always payable. Clients raise
          the cap by funding more.
        </p>
      </div>

      <div className="mt-6 rounded-lg border border-line bg-ink-soft p-7">
        <h2 className="text-sm text-chalk">Authorisation is not optional</h2>
        <p className="mt-3 leading-relaxed text-mist text-pretty">
          Every program records a signed scope and safe-harbour document before it opens. Test what
          that document says you may test, and nothing else. Going outside scope isn&apos;t a
          protocol violation — it&apos;s unauthorised access to someone else&apos;s systems, and the
          scope is what stands between a hunter and that.
        </p>
      </div>
    </section>
  );
}
