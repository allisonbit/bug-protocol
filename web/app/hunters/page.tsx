import Link from "next/link";
import { getLeaderboard, type Hunter } from "@/lib/queries";
import { SUPABASE_CONFIGURED } from "@/lib/supabase/shared";
import { money, initials, displayName } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Hunters | Swamp",
  description: "The researchers finding the bugs, ranked by reputation earned from accepted findings.",
};

export default async function Hunters() {
  const hunters = await getLeaderboard();

  return (
    <div className="aurora min-h-[70vh]">
      <div className="relative z-10 mx-auto max-w-4xl px-6 py-16">
        <header className="max-w-2xl">
          <h1 className="text-3xl font-semibold tracking-tight">Hunters</h1>
          <p className="mt-3 text-pretty leading-relaxed text-mist">
            The people finding the bugs. Reputation is earned only from findings a program actually
            accepted and weighted by severity, so a rank here means real, paid work.
          </p>
        </header>

        {hunters.length === 0 ? (
          <Empty configured={SUPABASE_CONFIGURED} />
        ) : (
          <ol className="mt-10 space-y-2">
            {hunters.map((h, i) => (
              <Row key={h.id} h={h} rank={i + 1} />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function Row({ h, rank }: { h: Hunter; rank: number }) {
  const name = displayName(h);
  const medal = rank <= 3;
  const inner = (
    <div className="flex items-center gap-4 rounded-xl border border-line bg-ink-soft p-4 transition-colors hover:border-mist">
      <span
        className={`w-8 shrink-0 text-center text-sm font-semibold tabular-nums ${
          medal ? "text-bug" : "text-mist"
        }`}
      >
        {rank}
      </span>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-bug-dim/60 bg-bug-dim/15 text-xs font-semibold text-bug">
        {initials(name)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2">
          <span className="truncate font-medium text-chalk">{name}</span>
          {h.handle && <span className="truncate text-xs text-mist">@{h.handle}</span>}
        </div>
        <div className="mt-0.5 text-xs text-mist">
          {h.accepted_count} accepted finding{h.accepted_count === 1 ? "" : "s"}
          {/* Earned used to be a right-hand column hidden below sm, which meant a
              phone reader simply never saw what a hunter had been paid, the one
              number the page exists to report. It moves inline here instead of
              disappearing, so the same facts survive at every width. */}
          <span className="sm:hidden">, {money(h.total_earned, "USDC")} earned</span>
        </div>
      </div>
      <div className="hidden text-right sm:block">
        <div className="text-sm font-semibold text-chalk">{money(h.total_earned, "USDC")}</div>
        <div className="text-[11px] uppercase tracking-wide text-mist">earned</div>
      </div>
      <div className="text-right">
        <div className="text-sm font-semibold text-bug">{h.rep.toLocaleString()}</div>
        <div className="text-[11px] uppercase tracking-wide text-mist">rep</div>
      </div>
    </div>
  );

  return <li>{h.handle ? <Link href={`/u/${h.handle}`}>{inner}</Link> : inner}</li>;
}

function Empty({ configured }: { configured: boolean }) {
  return (
    <div className="mt-10 rounded-xl border border-dashed border-line bg-ink-soft/50 p-10 text-center">
      <h2 className="text-lg font-medium text-chalk">
        {configured ? "No ranked hunters yet" : "The leaderboard is almost ready"}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-pretty text-sm leading-relaxed text-mist">
        {configured
          ? "Reputation shows up here the moment the first finding is accepted. Be the one who puts a name on the board."
          : "Once the backend is connected, hunters rank here by the reputation they earn from accepted findings."}
      </p>
      <div className="mt-6 flex justify-center gap-3">
        <Link
          href="/programs"
          className="glow rounded-md bg-lime px-5 py-2.5 text-sm font-medium text-graphite transition-transform hover:scale-[1.02]"
        >
          Find a bounty
        </Link>
        <Link
          href="/how"
          className="rounded-md border border-line px-5 py-2.5 text-sm text-chalk transition-colors hover:border-mist"
        >
          How it works
        </Link>
      </div>
    </div>
  );
}
