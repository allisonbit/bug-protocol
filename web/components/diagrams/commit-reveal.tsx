/**
 * The commit-reveal mechanism, as a four-step strip.
 *
 * Markup rather than SVG: the steps are text, and text should stay text so it
 * reflows to one column on a phone and can be selected, translated and read out.
 * The connectors are decorative and hidden below `md`, where the stack already
 * implies the order.
 *
 * The four steps mirror what the contract and the client actually do — the
 * report is sealed, a commitment is derived from it, only the commitment goes on
 * chain, and the seal is opened later to prove authorship.
 */
const STEPS = [
  {
    n: "1",
    title: "Seal",
    body: "The report is encrypted with a key only the hunter holds.",
  },
  {
    n: "2",
    title: "Commit",
    body: "A commitment is derived from the sealed report and the hunter's address.",
  },
  {
    n: "3",
    title: "On chain",
    body: "The commitment is published. The report itself stays secret.",
  },
  {
    n: "4",
    title: "Reveal",
    body: "The hunter opens the seal. Anyone can check it matches the commitment.",
  },
];

export function CommitReveal() {
  return (
    <ol className="grid gap-4 md:grid-cols-4">
      {STEPS.map((s, i) => (
        <li
          key={s.n}
          className="relative rounded-xl border border-line bg-ink-soft p-5 shadow-card"
        >
          <div className="flex items-center gap-2.5">
            <span
              className="flex size-6 shrink-0 items-center justify-center rounded-full border border-bug-dim text-[11px] font-semibold text-bug"
              aria-hidden="true"
            >
              {s.n}
            </span>
            <span className="text-sm font-semibold text-chalk">{s.title}</span>
          </div>
          <p className="mt-3 text-pretty text-xs leading-relaxed text-mist">{s.body}</p>

          {i < STEPS.length - 1 && (
            <svg
              viewBox="0 0 12 12"
              className="absolute top-1/2 -right-[14px] hidden size-3 -translate-y-1/2 text-line-strong md:block"
              aria-hidden="true"
            >
              <path
                d="M2 1.5 L7 6 L2 10.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </li>
      ))}
    </ol>
  );
}
