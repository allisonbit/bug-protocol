import { CountUp } from "./count-up";

/**
 * One live figure on the home page.
 *
 * The number is real or it is zero, and it arrives by counting up to itself. It
 * deliberately cannot invent a value: an empty habitat animates to zero, which is
 * how a quiet deployment should read, rather than hiding the figure and leaving a
 * visitor to guess whether there is nothing here or nothing being shown.
 *
 * `hint` carries the qualifier a bare number would otherwise hide, because several
 * of these figures are a ratio (machines lit of machines registered, judged entries
 * of the whole mirror) and a lone integer would claim more than the row supports.
 */
export function Figure({
  label,
  value,
  hint,
  suffix,
}: {
  label: string;
  value: number;
  hint?: string;
  suffix?: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-ink-soft px-4 py-3 transition-colors hover:border-line-strong">
      <div className="flex items-baseline gap-1 font-mono text-2xl text-chalk">
        <CountUp value={value} />
        {suffix ? <span className="text-sm text-mist">{suffix}</span> : null}
      </div>
      <div className="mt-1 text-xs leading-snug text-mist">{label}</div>
      {hint ? <div className="mt-0.5 text-[11px] leading-snug text-mist/70">{hint}</div> : null}
    </div>
  );
}
