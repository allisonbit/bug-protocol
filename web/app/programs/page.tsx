import Link from "next/link";
import { getLivePrograms } from "@/lib/queries";
import { SUPABASE_CONFIGURED } from "@/lib/supabase";
import { money, topTier, displayName, programStatusMeta } from "@/lib/db";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Programs | Swarmproof",
  description: "Live bug bounty programs. Pick a target, find bugs, get paid from escrow.",
};

export default async function ProgramsPage() {
  const programs = await getLivePrograms();
  const totalPool = programs.reduce((s, p) => s + Number(p.pool || 0), 0);

  return (
    <div className="aurora">
      <div className="relative z-10 mx-auto max-w-6xl px-6 py-12">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Live programs</h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-mist">
              Every program below is backed by real escrow. Find a valid bug, submit a report, and get
              paid the moment it&apos;s accepted. No committee, no ghosting.
            </p>
          </div>
          <Link
            href="/programs/new"
            className="glow rounded-md bg-lime px-4 py-2 text-sm font-medium text-graphite transition-transform hover:scale-[1.02]"
          >
            Start a program
          </Link>
        </div>

        {programs.length > 0 && (
          <div className="mt-6 flex flex-wrap gap-6 text-sm">
            <span className="text-mist">
              <span className="font-semibold text-chalk">{programs.length}</span> program
              {programs.length === 1 ? "" : "s"}
            </span>
            <span className="text-mist">
              <span className="font-semibold text-bug">{money(totalPool, "USDC")}</span> in open escrow
            </span>
          </div>
        )}

        {programs.length === 0 ? (
          <EmptyState configured={SUPABASE_CONFIGURED} />
        ) : (
          <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {programs.map((p) => {
              const meta = programStatusMeta[p.status];
              return (
                <li key={p.id}>
                  <Link
                    href={`/programs/${p.slug}`}
                    className="card-hover flex h-full flex-col rounded-xl border border-line bg-ink-soft p-5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex size-11 items-center justify-center rounded-lg border border-line bg-panel text-base font-semibold text-bug">
                        {p.name.slice(0, 1).toUpperCase()}
                      </div>
                      <span className={`rounded border px-2 py-0.5 text-[10px] ${meta.tone}`}>{meta.label}</span>
                    </div>
                    <h2 className="mt-3.5 font-medium text-chalk">{p.name}</h2>
                    <p className="mt-1 line-clamp-2 flex-1 text-sm leading-relaxed text-mist">
                      {p.summary || "Security program on Swarmproof."}
                    </p>
                    <div className="mt-4 flex items-end justify-between border-t border-line pt-3.5">
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-mist">Top bounty</div>
                        <div className="text-lg font-semibold text-bug">{money(topTier(p), p.currency)}</div>
                      </div>
                      <div className="text-right text-xs text-mist">
                        by {displayName(p.owner_profile)}
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function EmptyState({ configured }: { configured: boolean }) {
  return (
    <div className="mt-10 rounded-xl border border-dashed border-line bg-ink-soft/50 p-12 text-center">
      <div className="mx-auto flex size-12 items-center justify-center rounded-full border border-line bg-panel">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icon.svg" alt="" className="size-6" />
      </div>
      <h2 className="mt-4 text-lg font-medium text-chalk">
        {configured ? "No live programs yet" : "Programs are almost ready"}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-mist">
        {configured
          ? "Be the first to fund one. Set your escrow and severity tiers, and hunters can start submitting in minutes."
          : "The backend is being connected. Once it's live, funded programs will show up here for the whole community to hunt."}
      </p>
      {configured && (
        <Link
          href="/programs/new"
          className="mt-5 inline-block rounded-md border border-bug-dim bg-bug-dim/10 px-4 py-2 text-sm text-bug transition-colors hover:bg-bug-dim/20"
        >
          Start the first program
        </Link>
      )}
    </div>
  );
}
