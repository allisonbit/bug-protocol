import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSubmission, getProgramSubmissions } from "@/lib/queries";
import { currentUser } from "@/lib/supabase/server";
import { readChainSubmission } from "@/lib/onchain";
import {
  money,
  displayName,
  initials,
  fmtDate,
  timeAgo,
  severityMeta,
  submissionStatusMeta,
} from "@/lib/db";
import { CHAIN_SUB_STATUS } from "@/lib/contract";
import {
  TriagePanel,
  DisclosePanel,
  ReportPanel,
  WaiveEmbargoPanel,
  SpamFinalizePanel,
  type ChainFacts,
} from "./triage";
import { RevealPanel } from "./reveal-panel";

export const dynamic = "force-dynamic";

export const metadata = { title: "Finding | Swamp" };

export default async function SubmissionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) redirect(`/login?next=/submissions/${id}`);

  const submission = await getSubmission(id);
  // RLS returns nothing unless you're the hunter or the program owner.
  if (!submission) notFound();

  const program = submission.program;
  const isOwner = !!program && user.id === program.owner;
  const st = submissionStatusMeta[submission.status];
  const claimed = severityMeta[submission.severity];
  const final = submission.assigned_severity ? severityMeta[submission.assigned_severity] : null;

  const onchainId = submission.onchain_submission_id;
  const chainId = submission.chain_id;
  const isEscrowed = onchainId !== null && chainId !== null;

  /**
   * Read the chain once, server-side, and hand a plain snapshot to the panels.
   *
   * Two reasons this isn't left to the client: the owner's first paint should show
   * the real verdict rather than flashing "pending" and correcting itself, and the
   * values have to come from the contract anyway. Nothing the browser asserts
   * about escrow is trusted anywhere in this app.
   */
  const chain = isEscrowed ? await readChainSubmission(chainId, BigInt(onchainId)) : null;

  const facts: ChainFacts | null = chain
    ? {
        status: chain.status,
        statusIndex: chain.statusIndex,
        severityIndex: chain.severityIndex,
        award: chain.award.toString(),
        bond: chain.bond.toString(),
        reportURI: chain.reportURI,
        submittedAt: Number(chain.submittedAt),
        triagedAt: Number(chain.triagedAt),
        triageDeadline: Number(chain.triageDeadline),
        escalatedFromPending: chain.escalatedFromPending,
        embargoWaived: chain.embargoWaived,
      }
    : null;

  // Candidates a duplicate verdict may point at: earlier, already-accepted
  // on-chain findings on the same program. The contract enforces exactly this
  // (BadDuplicateReference), so the picker only offers rows that would pass.
  const dupeOptions =
    isOwner && program && isEscrowed
      ? (await getProgramSubmissions(program.id))
          .filter(
            (s) =>
              s.onchain_submission_id !== null &&
              s.onchain_submission_id < (onchainId ?? 0) &&
              (s.status === "accepted" || s.status === "disclosed"),
          )
          .map((s) => ({ id: s.onchain_submission_id as number, title: s.title }))
      : [];

  const chainLabel = facts ? CHAIN_SUB_STATUS[facts.statusIndex] : null;
  const hunterPanel =
    !isOwner && isEscrowed && onchainId !== null && chainId !== null && program
      ? { rowId: submission.id, chainId, onchainSubmissionId: onchainId }
      : null;

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      {program && (
        <Link href={`/programs/${program.slug}`} className="text-xs text-mist transition-colors hover:text-chalk">
          {program.name}
        </Link>
      )}

      <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight">{submission.title}</h1>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-mist">
            <span className={`rounded border px-2 py-0.5 text-[11px] ${st.tone}`}>{st.label}</span>
            {chainLabel && (
              <span className="rounded border border-line px-2 py-0.5 text-[11px] text-mist">
                chain: {chainLabel}
              </span>
            )}
            
            <span className="flex items-center gap-1.5">
              <span className={`size-2 rounded-full ${claimed.dot}`} />
              claimed {claimed.label}
            </span>
            {final && submission.status !== "pending" && (
              <>
                
                <span className="flex items-center gap-1.5">
                  <span className={`size-2 rounded-full ${final.dot}`} />
                  final {final.label}
                </span>
              </>
            )}
            
            <span>{timeAgo(submission.created_at)}</span>
          </div>
        </div>
        {(submission.status === "accepted" || submission.status === "disclosed") && submission.reward > 0 && (
          <div className="rounded-lg border border-bug-dim/40 bg-bug-dim/[0.06] px-4 py-2 text-right">
            <div className="text-[11px] uppercase tracking-wide text-mist">Awarded</div>
            <div className="text-xl font-semibold text-bug">
              {money(submission.reward, program?.currency ?? "USDC")}
            </div>
          </div>
        )}
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-6">
          {submission.target && (
            <div className="text-sm">
              <span className="text-mist">Target: </span>
              <span className="font-mono text-mist-bright">{submission.target}</span>
            </div>
          )}

          {submission.report_uri && (
            <div className="text-sm">
              <span className="text-mist">Committed report: </span>
              <span className="font-mono text-xs break-all text-mist-bright">{submission.report_uri}</span>
            </div>
          )}

          {/* The owner decrypts in the browser; the hunter already knows their own
              report, so they just see it back. */}
          <ReportPanel report={submission.report} encrypted={submission.encrypted} />

          {submission.triage_note && (
            <section>
              <h2 className="text-sm font-medium text-chalk">Note from the owner</h2>
              <div className="mt-3 whitespace-pre-wrap rounded-xl border border-line bg-panel p-4 text-sm leading-relaxed text-mist-bright">
                {submission.triage_note}
              </div>
            </section>
          )}
        </div>

        <div className="space-y-5">
          {isOwner && program ? (
            <>
              {submission.status !== "disclosed" && (
                <TriagePanel
                  submission={{
                    id: submission.id,
                    title: submission.title,
                    severity: submission.severity,
                    assigned_severity: submission.assigned_severity,
                    status: submission.status,
                    reward: submission.reward,
                    triage_note: submission.triage_note,
                    encrypted: submission.encrypted,
                  }}
                  program={program}
                  facts={facts}
                  dupeOptions={dupeOptions}
                  rewardToken={program.reward_token}
                  onchainProgramId={program.onchain_program_id}
                />
              )}

              {isEscrowed && onchainId !== null && facts && facts.triagedAt > 0 && (
                <WaiveEmbargoPanel onchainSubmissionId={onchainId} waived={facts.embargoWaived} />
              )}
              {isEscrowed && onchainId !== null && facts && facts.statusIndex === 4 && (
                <SpamFinalizePanel onchainSubmissionId={onchainId} triagedAt={facts.triagedAt} />
              )}

              {(submission.status === "accepted" || submission.status === "disclosed") && (
                <DisclosePanel
                  id={submission.id}
                  disclosed={submission.status === "disclosed"}
                  slug={program.slug}
                  handle={submission.hunter_profile?.handle ?? ""}
                />
              )}
            </>
          ) : (
            <>
              {hunterPanel && program ? (
                <RevealPanel
                  rowId={hunterPanel.rowId}
                  chainId={hunterPanel.chainId}
                  onchainSubmissionId={hunterPanel.onchainSubmissionId}
                  commitHash={submission.commit_hash}
                  status={submission.status}
                  revealedAt={submission.revealed_at}
                  rewardToken={program.reward_token}
                />
              ) : (
                <div className="rounded-xl border border-line bg-ink-soft p-5">
                  <h2 className="text-sm font-medium text-chalk">Status</h2>
                  <p className="mt-2 text-sm leading-relaxed text-mist">
                    {submission.status === "pending"
                      ? "Waiting on the program owner to triage. You'll see the decision and any payout here."
                      : submission.status === "accepted"
                        ? "Accepted. Nice work. The reward is recorded above."
                        : submission.status === "escalated"
                          ? "Escalated to the arbiter. Their ruling decides the outcome."
                          : submission.status === "disclosed"
                            ? "Accepted and publicly disclosed. It's part of your public track record now."
                            : `Marked ${st.label.toLowerCase()} by the owner.`}
                  </p>
                  {submission.status === "disclosed" && submission.hunter_profile?.handle && (
                    <Link
                      href={`/u/${submission.hunter_profile.handle}`}
                      className="mt-3 inline-block text-xs text-bug transition-colors hover:text-bug-dim"
                    >
                      View it on your profile
                    </Link>
                  )}
                  {submission.triaged_at && (
                    <p className="mt-3 text-xs text-mist">Triaged {fmtDate(submission.triaged_at)}</p>
                  )}
                </div>
              )}

              {/* A hunter's own off-chain finding still gets its authorship proof
                  and its commit hash. The receipt is what makes it defensible. */}
              {!isEscrowed && submission.commit_hash && (
                <div className="rounded-xl border border-line bg-ink-soft p-5">
                  <h2 className="text-sm font-medium text-chalk">Your commit</h2>
                  <p className="mt-2 text-[11px] leading-relaxed text-mist">
                    This program holds no escrow, so the reward is the owner&apos;s to honour. But the commit below,
                    combined with the receipt in your browser, still dates and binds this finding to you.
                  </p>
                  <p className="mt-2 font-mono text-[11px] break-all text-mist-bright">{submission.commit_hash}</p>
                </div>
              )}
            </>
          )}

          <div className="rounded-xl border border-line bg-ink-soft p-5">
            <h2 className="text-sm font-medium text-chalk">Reported by</h2>
            <div className="mt-3 flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-full border border-bug-dim/60 bg-bug-dim/15 text-xs font-semibold text-bug">
                {initials(displayName(submission.hunter_profile))}
              </span>
              <div className="min-w-0">
                {submission.hunter_profile?.handle ? (
                  <Link href={`/u/${submission.hunter_profile.handle}`} className="block min-w-0">
                    <div className="truncate text-sm text-chalk transition-colors hover:text-bug">
                      {displayName(submission.hunter_profile)}
                    </div>
                    <div className="truncate text-xs text-mist">@{submission.hunter_profile.handle}</div>
                  </Link>
                ) : (
                  <div className="truncate text-sm text-chalk">{displayName(submission.hunter_profile)}</div>
                )}
              </div>
            </div>
            {submission.revealed_at && (
              <p className="mt-3 text-[11px] text-mist">
                Report revealed {fmtDate(submission.revealed_at)}. The committed document is now public.
              </p>
            )}
            {submission.dispute_deadline && isOwner && (
              <p className="mt-1 text-[11px] text-mist">
                Dispute window closes {fmtDate(submission.dispute_deadline)}.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
