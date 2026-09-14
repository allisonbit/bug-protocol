import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/supabase/server";
import { SUPABASE_CONFIGURED } from "@/lib/supabase/shared";
import { getMyPrograms, getMySubmissions, getInbox, getProfile, type SubmissionWithProgram } from "@/lib/queries";
import {
  money,
  topTier,
  displayName,
  fmtDate,
  timeAgo,
  programStatusMeta,
  submissionStatusMeta,
  severityMeta,
  escrowMode,
  escrowModeMeta,
  type Profile,
  type Program,
} from "@/lib/db";

export const dynamic = "force-dynamic";

type DashData = {
  profile: Profile | null;
  programs: Program[];
  submissions: SubmissionWithProgram[];
  inbox: SubmissionWithProgram[];
};

export default async function DashboardPage() {
  const user = SUPABASE_CONFIGURED ? await currentUser() : null;

  // Backend connected but nobody signed in: use the real login gate.
  if (SUPABASE_CONFIGURED && !user) redirect("/login?next=/dashboard");

  // No backend yet: render the real dashboard with honest zeros. Never fabricated
  // programs or findings ([[no-fake-data-ever]]). It fills with real rows the moment
  // an account exists and the backend is connected.
  let data: DashData = { profile: null, programs: [], submissions: [], inbox: [] };
  if (user) {
    const [profile, programs, submissions, inbox] = await Promise.all([
      getProfile(user.id),
      getMyPrograms(user.id),
      getMySubmissions(user.id),
      getInbox(user.id),
    ]);
    data = { profile, programs, submissions, inbox };
  }

  const { profile, programs, submissions, inbox } = data;
  const name = displayName(profile) || user?.email?.split("@")[0] || "there";

  const live = programs.filter((p) => p.status === "live");
  // Only a program with an `onchain_program_id` actually holds funds in a
  // contract. Summing every pool into one "in escrow" figure would claim a
  // guarantee for honour-system programs that nobody is enforcing, so the two
  // are counted separately and the off-chain part is named rather than absorbed.
  const committed = programs
    .filter((p) => escrowMode(p) === "escrow")
    .reduce((s, p) => s + Number(p.pool || 0), 0);
  const offchainCommitted = programs
    .filter((p) => escrowMode(p) === "offchain")
    .reduce((s, p) => s + Number(p.pool || 0), 0);
  const paidOut = programs.reduce((s, p) => s + Number(p.paid_out || 0), 0);
  const accepted = submissions.filter((s) => s.status === "accepted");
  const earnings = accepted.reduce((s, x) => s + Number(x.reward || 0), 0);

  return (
    <div className="mx-auto max-w-6xl">
      {!SUPABASE_CONFIGURED && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warn/40 bg-warn/5 px-4 py-3">
          <div className="flex items-center gap-2.5 text-sm">
            <span className="rounded bg-warn/20 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-warn">
              BACKEND NOT CONNECTED
            </span>
            <span className="text-mist-bright">
              This is your real dashboard. It fills with your own programs, findings, and earnings once the
              backend is connected. Nothing here is sample data.
            </span>
          </div>
          <Link href="/signup" className="text-sm font-medium text-bug hover:underline">
            Create an account
          </Link>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-mist">{greeting()},</p>
          <h1 className="mt-0.5 text-2xl font-semibold tracking-tight">{name}</h1>
        </div>
        <div className="flex gap-2.5">
          <Link
            href="/programs"
            className="rounded-md bg-panel-2 px-4 py-2 text-sm text-chalk transition-colors hover:bg-panel"
          >
            Find bugs to hunt
          </Link>
          <Link
            href="/programs/new"
            className="glow rounded-md bg-lime px-4 py-2 text-sm font-medium text-graphite transition-transform hover:scale-[1.02]"
          >
            Start a program
          </Link>
        </div>
      </div>

      {/* Stat band.
          Only the figures this account has a basis for. The four cards were
          fixed: a hunter who runs no programs permanently read "$0 in escrow,
          0 live", and an owner who files no findings permanently read "You've
          earned $0", bare zeros that read as data rather than as "nothing has
          happened yet". Which cards appear is decided by activity, not by the
          role field, because activity is the ground truth and a role can be
          stale. Nothing is shown until there is something true to show. */}
      {programs.length === 0 && submissions.length === 0 ? (
        <StartHere />
      ) : (
        <div
          className={`mt-8 grid grid-cols-2 gap-3 ${
            programs.length > 0 && submissions.length > 0 ? "sm:grid-cols-4" : "sm:grid-cols-2"
          }`}
        >
          {programs.length > 0 && (
            <>
              <StatCard
                label="In escrow"
                value={money(committed, "USDC")}
                sub={
                  offchainCommitted > 0
                    ? `${live.length} live, plus ${money(offchainCommitted, "USDC")} committed off-chain`
                    : `${live.length} live`
                }
                accent
              />
              <StatCard label="Paid to hunters" value={money(paidOut, "USDC")} sub="all-time" />
            </>
          )}
          {submissions.length > 0 && (
            <>
              <StatCard
                label="Findings filed"
                value={submissions.length.toString()}
                sub={`${accepted.length} accepted`}
              />
              <StatCard label="You've earned" value={money(earnings, "USDC")} sub="from bounties" />
            </>
          )}
        </div>
      )}

      {/* Highlights: AI Copilot + Live swamp */}
      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        <Link
          href="/dashboard/ai"
          className="card-hover flex items-center gap-4 rounded-2xl bg-gradient-to-br from-lime/20 to-cyan/10 p-5"
        >
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-lime text-graphite">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
              <path d="M12 3l1.9 5.6L19 10l-5.1 1.4L12 17l-1.9-5.6L5 10l5.1-1.4z" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium text-chalk">AI Copilot</span>
              <span className="rounded bg-lime px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-graphite">NEW</span>
            </div>
            <p className="mt-0.5 text-sm text-mist-bright">
              Agents that recon targets, triage findings, grade severity, and catch dupes over MCP.
            </p>
          </div>
          <span className="hidden shrink-0 text-bug sm:block">Open</span>
        </Link>

        <Link
          href="/dashboard/swamp"
          className="card-hover flex items-center gap-4 rounded-2xl bg-gradient-to-br from-bug-dim/20 to-panel-2/40 p-5"
        >
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-bug text-graphite">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="6" r="2.5" />
              <circle cx="18" cy="7" r="2.5" />
              <circle cx="12" cy="17" r="2.5" />
              <path d="M8 7l2 8M16 9l-3 6M8 6.5h7.5" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium text-chalk">Live swamp</span>
              <span className="rounded bg-bug px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-graphite">LIVE</span>
            </div>
            <p className="mt-0.5 text-sm text-mist-bright">
              Watch connected agents and their signed events in real time, or connect your own brain.
            </p>
          </div>
          <span className="hidden shrink-0 text-bug sm:block">Open</span>
        </Link>
      </div>

      <div className="mt-10 grid gap-8 lg:grid-cols-[1.4fr_1fr]">
        {/* Left column: programs you run + triage inbox */}
        <div className="space-y-10">
          <section>
            <SectionHead title="Your programs" action={{ href: "/programs/new", label: "New program" }} />
            {programs.length === 0 ? (
              <EmptyCard
                title="No programs yet"
                body="Fund an escrow, set your severity tiers, and let the community find bugs before attackers do."
                cta={{ href: "/programs/new", label: "Create your first program" }}
              />
            ) : (
              <ul className="mt-4 space-y-2.5">
                {programs.map((p) => {
                  const meta = programStatusMeta[p.status];
                  const esc = escrowModeMeta[escrowMode(p)];
                  return (
                    <li key={p.id}>
                      <Link
                        href={`/programs/${p.slug}`}
                        className="card-hover flex items-center gap-4 rounded-lg bg-ink-soft p-4"
                      >
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-panel-2 text-sm font-semibold text-bug">
                          {p.name.slice(0, 1).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium text-chalk">{p.name}</span>
                            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${meta.tone}`}>{meta.label}</span>
                          </div>
                          {/* "In escrow" is only true when a contract actually holds it. */}
                          <div className="mt-0.5 truncate text-xs text-mist">
                            {money(p.pool, p.currency)}{" "}
                            {escrowMode(p) === "escrow" ? "in escrow" : "committed off-chain"}, up to{" "}
                            {money(topTier(p), p.currency)} / bug
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            <span className={`rounded border px-1.5 py-0.5 text-[10px] ${esc.tone}`}>
                              {esc.label}
                            </span>
                            <span className="truncate text-[10px] text-mist">{esc.blurb}</span>
                          </div>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section>
            <SectionHead title="Needs triage" count={inbox.length} />
            {inbox.length === 0 ? (
              <p className="mt-4 rounded-lg bg-ink-soft p-5 text-sm text-mist">
                Nothing waiting on you. New submissions to your programs land here.
              </p>
            ) : (
              <ul className="mt-4 space-y-2.5">
                {inbox.map((s) => {
                  const sev = severityMeta[s.severity];
                  return (
                    <li key={s.id}>
                      <Link
                        href={`/submissions/${s.id}`}
                        className="card-hover flex items-center gap-3 rounded-lg bg-ink-soft p-3.5"
                      >
                        <span className={`size-2 shrink-0 rounded-full ${sev.dot}`} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-chalk">{s.title}</div>
                          <div className="truncate text-xs text-mist">
                            {s.program?.name ?? "program"}, claims {sev.label}, {timeAgo(s.created_at)}
                          </div>
                        </div>
                        <span className="shrink-0 rounded bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-500">
                          Review
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        {/* Right column: findings you filed */}
        <section>
          <SectionHead title="Your findings" action={{ href: "/programs", label: "Hunt more" }} />
          {submissions.length === 0 ? (
            <EmptyCard
              title="You haven't filed a finding yet"
              body="Browse live programs, pick a target, and submit your first report. Accepted bugs pay from escrow."
              cta={{ href: "/programs", label: "Browse programs" }}
            />
          ) : (
            <ul className="mt-4 space-y-2.5">
              {submissions.map((s) => {
                const st = submissionStatusMeta[s.status];
                return (
                  <li key={s.id}>
                    <Link
                      href={`/submissions/${s.id}`}
                      className="card-hover block rounded-lg bg-ink-soft p-4"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm text-chalk">{s.title}</span>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${st.tone}`}>{st.label}</span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-xs text-mist">
                        <span className="truncate">{s.program?.name ?? "program"}</span>
                        <span className="shrink-0">
                          {s.status === "accepted" && s.reward > 0
                            ? money(s.reward, s.program?.currency ?? "USDC")
                            : fmtDate(s.created_at)}
                        </span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * What a brand-new account sees where the stat band would be. Deliberately not
 * four zeros: a zero is a measurement, and there is nothing here to measure
 * yet. This says that plainly and offers the two ways to start.
 */
function StartHere() {
  return (
    <div className="mt-8 rounded-2xl bg-ink-soft p-6">
      <h2 className="text-sm font-medium text-chalk">No numbers yet, and that&apos;s accurate</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-mist">
        Escrow totals and earnings appear here once you either fund a program or file a finding. Until
        then there is nothing to total, so this shows you the two ways in rather than a row of zeros.
      </p>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <Link
          href="/programs"
          className="card-hover rounded-xl bg-panel-2 p-4 transition-colors hover:bg-panel"
        >
          <div className="text-sm font-medium text-chalk">Hunt a program</div>
          <p className="mt-1 text-xs leading-relaxed text-mist">
            Browse what&apos;s live, read the scope, and submit a report. Accepted findings pay from
            escrow that&apos;s already funded.
          </p>
        </Link>
        <Link
          href="/programs/new"
          className="card-hover rounded-xl bg-panel-2 p-4 transition-colors hover:bg-panel"
        >
          <div className="text-sm font-medium text-chalk">Fund a program</div>
          <p className="mt-1 text-xs leading-relaxed text-mist">
            Publish your scope and lock the rewards up front, so a hunter who finds something real is
            paid without an invoice to chase.
          </p>
        </Link>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className={`rounded-lg p-4 ${accent ? "bg-lime/15" : "bg-ink-soft"}`}>
      <div className="text-[11px] uppercase tracking-wide text-mist">{label}</div>
      <div className={`mt-1.5 text-2xl font-semibold tracking-tight ${accent ? "text-bug" : "text-chalk"}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-mist">{sub}</div>}
    </div>
  );
}

function SectionHead({
  title,
  action,
  count,
}: {
  title: string;
  action?: { href: string; label: string };
  count?: number;
}) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-sm font-medium text-chalk">
        {title}
        {typeof count === "number" && count > 0 && (
          <span className="rounded-full bg-bug-dim/15 px-2 py-0.5 text-[11px] text-bug">{count}</span>
        )}
      </h2>
      {action && (
        <Link href={action.href} className="text-xs text-mist transition-colors hover:text-bug">
          {action.label}
        </Link>
      )}
    </div>
  );
}

function EmptyCard({ title, body, cta }: { title: string; body: string; cta: { href: string; label: string } }) {
  return (
    <div className="mt-4 rounded-lg bg-ink-soft p-6 text-center">
      <div className="text-sm font-medium text-chalk">{title}</div>
      <p className="mx-auto mt-1.5 max-w-xs text-xs leading-relaxed text-mist">{body}</p>
      <Link
        href={cta.href}
        className="mt-4 inline-block rounded-md bg-lime px-4 py-2 text-sm font-medium text-graphite transition-transform hover:scale-[1.02]"
      >
        {cta.label}
      </Link>
    </div>
  );
}
