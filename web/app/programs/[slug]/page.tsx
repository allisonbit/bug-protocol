import Link from "next/link";
import { notFound } from "next/navigation";
import { getProgramBySlug, getProgramSubmissions, getProgramDisclosures } from "@/lib/queries";
import { currentUser } from "@/lib/supabase/server";
import {
  money,
  topTier,
  displayName,
  initials,
  timeAgo,
  fmtDate,
  SEVERITIES,
  severityMeta,
  programStatusMeta,
  submissionStatusMeta,
  tierFor,
  escrowMode,
  escrowModeMeta,
} from "@/lib/db";
import { ManagePanel } from "./manage";
import { ScopeHashPanel } from "./scope-panel";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const program = await getProgramBySlug(slug);
  return { title: program ? `${program.name} | Swarmproof` : "Program | Swarmproof" };
}

export default async function ProgramPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [program, user] = await Promise.all([getProgramBySlug(slug), currentUser()]);
  if (!program) notFound();

  const isOwner = !!user && user.id === program.owner;
  const [submissions, disclosures] = await Promise.all([
    user ? getProgramSubmissions(program.id) : Promise.resolve([]),
    getProgramDisclosures(program.id),
  ]);
  const meta = programStatusMeta[program.status];
  const canSubmit = program.status === "live";
  // Which kind of bounty this is decides everything a hunter needs to know about
  // whether an accepted finding can actually be forced to pay, so it is shown
  // beside the status rather than buried.
  const escrow = escrowMode(program);
  const escrowMeta = escrowModeMeta[escrow];

  return (
    <div className="aurora">
      <div className="relative z-10 mx-auto max-w-5xl px-6 py-10">
        <Link href="/programs" className="text-xs text-mist transition-colors hover:text-chalk">
          All programs
        </Link>

        {/* Header */}
        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="flex size-14 shrink-0 items-center justify-center rounded-xl border border-line bg-panel text-xl font-semibold text-bug">
              {program.name.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-2xl font-semibold tracking-tight">{program.name}</h1>
                <span className={`rounded border px-2 py-0.5 text-[11px] ${meta.tone}`}>{meta.label}</span>
                <span
                  className={`rounded border px-2 py-0.5 text-[11px] ${escrowMeta.tone}`}
                  title={escrowMeta.blurb}
                >
                  {escrowMeta.label}
                </span>
              </div>
              <p className="mt-1 text-sm text-mist">
                by{" "}
                {program.owner_profile?.handle ? (
                  <Link
                    href={`/u/${program.owner_profile.handle}`}
                    className="text-mist transition-colors hover:text-bug"
                  >
                    {displayName(program.owner_profile)}
                  </Link>
                ) : (
                  displayName(program.owner_profile)
                )}
                {program.safe_harbor && <span className="ml-2 text-bug">safe harbor</span>}
              </p>
            </div>
          </div>
          {canSubmit && (
            <Link
              href={`/programs/${program.slug}/submit`}
              className="glow rounded-md bg-lime px-4 py-2 text-sm font-medium text-graphite transition-transform hover:scale-[1.02]"
            >
              Submit a finding
            </Link>
          )}
        </div>

        {program.summary && (
          <p className="mt-5 max-w-2xl text-[15px] leading-relaxed text-mist-bright">{program.summary}</p>
        )}

        {/* Stat band */}
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="In escrow" value={money(program.pool, program.currency)} accent />
          <Stat label="Top bounty" value={money(topTier(program), program.currency)} />
          <Stat label="Paid out" value={money(program.paid_out, program.currency)} />
          <Stat label="Response SLA" value={`${program.response_days}d`} />
        </div>

        <div className="mt-10 grid gap-8 lg:grid-cols-[1.5fr_1fr]">
          <div className="space-y-8">
            {/* Reward tiers */}
            <section>
              <h2 className="text-sm font-medium text-chalk">Reward tiers</h2>
              <div className="mt-3 overflow-hidden rounded-xl border border-line">
                {SEVERITIES.map((sev, i) => {
                  const sm = severityMeta[sev];
                  return (
                    <div
                      key={sev}
                      className={`flex items-center justify-between px-4 py-3 ${
                        i > 0 ? "border-t border-line" : ""
                      } ${i % 2 ? "bg-ink-soft/40" : "bg-ink-soft"}`}
                    >
                      <span className="flex items-center gap-2.5 text-sm">
                        <span className={`size-2 rounded-full ${sm.dot}`} />
                        {sm.label}
                      </span>
                      <span className="text-sm font-medium text-chalk">
                        {money(tierFor(program, sev), program.currency)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Scope, with an in-browser check of the recorded hash once the
                program is escrowed, since that hash is what authorises testing. */}
            {program.description &&
              (program.scope_hash ? (
                <ScopeHashPanel text={program.description} scopeHash={program.scope_hash} />
              ) : (
                <section>
                  <h2 className="text-sm font-medium text-chalk">Scope & rules</h2>
                  <div className="mt-3 whitespace-pre-wrap rounded-xl border border-line bg-ink-soft p-4 font-mono text-xs leading-relaxed text-mist-bright">
                    {program.description}
                  </div>
                </section>
              ))}

            {/* Targets */}
            {program.targets.length > 0 && (
              <section>
                <h2 className="text-sm font-medium text-chalk">Targets</h2>
                <ul className="mt-3 flex flex-wrap gap-2">
                  {program.targets.map((t) => (
                    <li
                      key={t}
                      className="rounded-md border border-line bg-panel px-2.5 py-1 font-mono text-xs text-mist-bright"
                    >
                      {t}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Hall of fame: publicly disclosed findings (safe projection only) */}
            {disclosures.length > 0 && (
              <section>
                <h2 className="text-sm font-medium text-chalk">Hall of fame</h2>
                <p className="mt-1 text-xs text-mist">Findings this program accepted, paid, and disclosed.</p>
                <ul className="mt-3 space-y-2">
                  {disclosures.map((d) => {
                    const sev = severityMeta[d.assigned_severity ?? d.severity];
                    return (
                      <li
                        key={d.id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-ink-soft p-3.5"
                      >
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${sev.tone}`}>
                          {sev.label}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm text-chalk">{d.title}</span>
                        {d.hunter?.handle ? (
                          <Link
                            href={`/u/${d.hunter.handle}`}
                            className="text-xs text-mist transition-colors hover:text-chalk"
                          >
                            {displayName(d.hunter)}
                          </Link>
                        ) : (
                          <span className="text-xs text-mist">{displayName(d.hunter)}</span>
                        )}
                        {d.reward > 0 && (
                          <span className="text-sm font-medium text-bug">{money(d.reward, program.currency)}</span>
                        )}
                        {d.triaged_at && <span className="text-xs text-mist">{fmtDate(d.triaged_at)}</span>}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {/* Submissions (owner sees all to triage; hunters see their own) */}
            {user && submissions.length > 0 && (
              <section>
                <h2 className="text-sm font-medium text-chalk">
                  {isOwner ? "Submissions" : "Your submissions"}
                </h2>
                <ul className="mt-3 space-y-2">
                  {submissions.map((s) => {
                    const st = submissionStatusMeta[s.status];
                    const sev = severityMeta[s.assigned_severity ?? s.severity];
                    return (
                      <li key={s.id}>
                        <Link
                          href={`/submissions/${s.id}`}
                          className="card-hover flex items-center gap-3 rounded-lg border border-line bg-ink-soft p-3.5"
                        >
                          <span className={`size-2 shrink-0 rounded-full ${sev.dot}`} />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm text-chalk">{s.title}</div>
                            <div className="truncate text-xs text-mist">
                              {isOwner ? displayName(s.hunter_profile) : "you"}, {timeAgo(s.created_at)}
                            </div>
                          </div>
                          <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${st.tone}`}>
                            {st.label}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </div>

          {/* Right rail */}
          <div className="space-y-5">
            {isOwner && <ManagePanel program={program} />}

            <div className="rounded-xl border border-line bg-ink-soft p-5">
              <h2 className="text-sm font-medium text-chalk">
                {canSubmit ? "Found something?" : "Not accepting submissions"}
              </h2>
              <p className="mt-2 text-xs leading-relaxed text-mist">
                {canSubmit
                  ? escrow === "escrow"
                    ? "Write a clear report with steps to reproduce. Your finding is committed on chain before the owner can read it, and an accepted verdict pays out of escrow in the same transaction."
                    : "Write a clear report with steps to reproduce. You still get an encrypted report and a commit receipt proving authorship, but this program holds no escrow, so the reward is the owner's to honour."
                  : program.status === "draft"
                    ? "This program hasn't been published yet."
                    : "This program is currently paused or closed."}
              </p>
              {canSubmit &&
                (user ? (
                  <Link
                    href={`/programs/${program.slug}/submit`}
                    className="mt-4 inline-block w-full rounded-md border border-bug-dim bg-bug-dim/10 py-2 text-center text-sm text-bug transition-colors hover:bg-bug-dim/20"
                  >
                    Submit a finding
                  </Link>
                ) : (
                  <Link
                    href={`/login?next=/programs/${program.slug}/submit`}
                    className="mt-4 inline-block w-full rounded-md border border-bug-dim bg-bug-dim/10 py-2 text-center text-sm text-bug transition-colors hover:bg-bug-dim/20"
                  >
                    Log in to submit
                  </Link>
                ))}
            </div>

            {program.owner_profile && (
              <div className="rounded-xl border border-line bg-ink-soft p-5">
                <h2 className="text-sm font-medium text-chalk">Program owner</h2>
                <div className="mt-3 flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-full border border-bug-dim/60 bg-bug-dim/15 text-xs font-semibold text-bug">
                    {initials(displayName(program.owner_profile))}
                  </span>
                  <div className="min-w-0">
                    {program.owner_profile.handle ? (
                      <Link href={`/u/${program.owner_profile.handle}`} className="block min-w-0">
                        <div className="truncate text-sm text-chalk transition-colors hover:text-bug">
                          {displayName(program.owner_profile)}
                        </div>
                        <div className="truncate text-xs text-mist">@{program.owner_profile.handle}</div>
                      </Link>
                    ) : (
                      <div className="truncate text-sm text-chalk">{displayName(program.owner_profile)}</div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg border p-4 ${accent ? "border-bug-dim/40 bg-bug-dim/[0.06]" : "border-line bg-ink-soft"}`}>
      <div className="text-[11px] uppercase tracking-wide text-mist">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${accent ? "text-bug" : "text-chalk"}`}>{value}</div>
    </div>
  );
}
