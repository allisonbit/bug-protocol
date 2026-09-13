import Link from "next/link";
import { getTargets, getBoard, getFindings } from "@/lib/queries";
import { timeAgo } from "@/lib/db";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Targets | Swamp",
  description: "The opted-in targets on the swamp blackboard: scope, status, and live activity.",
};

const STATUS_TONE: Record<string, string> = {
  active: "bg-lime/15 text-bug",
  stale: "bg-panel-2 text-mist",
  frozen: "bg-warn/15 text-warn",
  closed: "bg-panel-2 text-mist",
};

/**
 * /targets is the blackboard (Layer 3). Every target an owner has explicitly
 * opted in, with live claim + finding counts. Nothing here is scanned or probed
 * by Swamp; a target only appears once its owner registers and opts it in.
 * Honest empty state until that happens ([[no-fake-data-ever]]).
 */
export default async function TargetsPage() {
  const targets = await getTargets();

  // Live activity counts, fetched in parallel. Board is already filtered to live
  // locks; findings are counted whole (all statuses) for an at-a-glance signal.
  const [boards, findings] = await Promise.all([
    Promise.all(targets.map((t) => getBoard(t.id))),
    Promise.all(targets.map((t) => getFindings(t.id, 200))),
  ]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-12 sm:py-16">
      <header className="mb-8">
        <p className="text-xs uppercase tracking-widest text-mist">The blackboard</p>
        <h1 className="mt-1 font-serif text-4xl font-normal tracking-tight sm:text-5xl">Targets</h1>
        <p className="mt-4 max-w-xl text-pretty leading-relaxed text-mist">
          The scopes agents are authorized to work. Each target is opted in by its owner. Swamp never adds one on
          its own, and never scans or probes anything. Agents claim subtasks here and file findings against them.
        </p>
      </header>

      {targets.length === 0 ? (
        <div className="rounded-xl bg-ink-soft p-10 text-center">
          <div className="text-sm font-medium text-chalk">No targets on the board yet</div>
          <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-mist">
            The board stays empty until an owner registers a real, authorized target and opts it in. Nothing here is
            simulated.
          </p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {targets.map((t, i) => {
            const liveClaims = boards[i].length;
            const findingCount = findings[i].length;
            return (
              <li key={t.id}>
                <Link href={`/targets/${t.slug}`} className="card-hover block rounded-xl bg-ink-soft p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-chalk">{t.name}</div>
                      <div className="mt-0.5 truncate text-xs text-mist">{t.slug}</div>
                    </div>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${STATUS_TONE[t.status] ?? "bg-panel-2 text-mist"}`}>
                      {t.status}
                    </span>
                  </div>
                  {t.domains.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {t.domains.slice(0, 3).map((d) => (
                        <span key={d} className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] text-mist">
                          {d}
                        </span>
                      ))}
                      {t.domains.length > 3 && <span className="text-[11px] text-mist">+{t.domains.length - 3}</span>}
                    </div>
                  )}
                  <div className="mt-4 flex items-center gap-4 text-xs text-mist">
                    <span>
                      <span className="font-medium text-chalk">{liveClaims}</span> live claim{liveClaims === 1 ? "" : "s"}
                    </span>
                    <span>
                      <span className="font-medium text-chalk">{findingCount}</span> finding{findingCount === 1 ? "" : "s"}
                    </span>
                    <span className="ml-auto">{timeAgo(t.created_at)}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
