"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, useChainId } from "wagmi";
import type { Address } from "viem";
import { bountyAbi, CHAIN_SUB_STATUS, INDEX_SEVERITY, PROTOCOL_FALLBACK } from "@/lib/contract";
import { commitmentFor } from "@/lib/commit";
import { findByCommitHash, importReceipt, type VaultEntry } from "@/lib/vault";
import { useBounty, useMyBalances, useProgram, useSubmissionChain } from "@/lib/reads";
import { useTx } from "@/lib/useTx";
import { mirrorSubmission } from "@/app/actions";
import { assetInfo, chainMeta } from "@/lib/chains";
import { fmtAmount, short, untilLabel } from "@/lib/format";
import { Button, Card, Copyable } from "@/components/ui";
import { severityMeta, type Severity, type SubmissionStatus } from "@/lib/db";

/**
 * The hunter's side of a finding, once it's on chain.
 *
 * Three jobs, in the order they become possible:
 *
 *  1. **Prove we can open the commit.** The salt is the only thing standing
 *     between a hunter and an unclaimable finding, and there is no way to recover
 *     it. So before offering any action, we recompute
 *     `keccak256(reportURI, salt, hunter)` from the local vault and compare it
 *     with what the chain holds. A mismatch is shown loudly rather than
 *     discovered at reveal time, months later.
 *
 *  2. **Reveal**, but only once the program's own disclosure delay has run from
 *     triage (or the owner waived it). The countdown reads the *on-chain* delay,
 *     not the off-chain `response_days`. Those are different numbers, and using
 *     the wrong one tells a hunter to sign a transaction that will revert.
 *
 *  3. **Escalate.** Two independent grounds, and the contract distinguishes
 *     them: the owner let the triage SLA lapse (still Pending), or the hunter
 *     disputes a Rejected / Duplicate / Spam verdict within the dispute window.
 *     Both are hunter-only calls.
 */
export function RevealPanel({
  rowId,
  chainId,
  onchainSubmissionId,
  commitHash,
  status,
  revealedAt,
  rewardToken,
}: {
  rowId: string;
  chainId: number;
  onchainSubmissionId: number;
  commitHash: string | null;
  status: SubmissionStatus;
  revealedAt: string | null;
  rewardToken: string | null;
}) {
  const { address } = useAccount();
  const connectedChainId = useChainId();
  const { meta } = useBounty();
  const onRightChain = connectedChainId === chainId;
  const linkMeta = chainMeta(chainId);

  const [refetchKey, setRefetchKey] = useState(0);
  const refresh = () => setRefetchKey((k) => k + 1);
  const chain = useSubmissionChain(BigInt(onchainSubmissionId), refetchKey);
  const program = useProgram(chain.submission?.programId, refetchKey);

  const [entry, setEntry] = useState<VaultEntry | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reveal = useTx(refresh);
  const escalate = useTx(refresh);

  // ---- find our salt ---------------------------------------------------------
  useEffect(() => {
    if (!commitHash) {
      setLoaded(true);
      return;
    }
    // Look for the commit hash we hold, preferring an entry made by the
    // connected wallet: a browser can hold secrets for several addresses.
    setEntry(findByCommitHash(commitHash, address) ?? findByCommitHash(commitHash) ?? null);
    setLoaded(true);
  }, [commitHash, address]);

  const verification = useMemo(() => {
    if (!entry || !chain.submission) return null;
    const recomputed = commitmentFor(entry.reportURI, entry.salt, entry.hunter);
    return {
      ok: recomputed.toLowerCase() === chain.submission.commitHash.toLowerCase(),
      recomputed,
      onchain: chain.submission.commitHash,
    };
  }, [entry, chain.submission]);

  async function afterTx(action: () => Promise<unknown>) {
    setError(null);
    await action();
    // Re-read the chain and stamp the index, so the page never disagrees with
    // the contract about what just happened.
    const fd = new FormData();
    fd.set("submission_id", rowId);
    try {
      await mirrorSubmission(fd);
    } catch {
      /* the chain is the source of truth; a mirror hiccup isn't fatal here */
    }
    refresh();
  }

  if (!onRightChain) {
    return (
      <Card className="p-5">
        <h2 className="text-sm font-medium text-chalk">This finding is on {linkMeta.short}</h2>
        <p className="mt-2 text-xs leading-relaxed text-mist">
          Revealing, escalating and claiming all happen on {linkMeta.label}. Switch networks in the top bar.
        </p>
      </Card>
    );
  }

  if (!meta.bounty) {
    return (
      <Card className="p-5">
        <h2 className="text-sm font-medium text-chalk">Escrow contract not configured here</h2>
        <p className="mt-2 text-xs leading-relaxed text-mist">
          This build doesn&apos;t know the BugBounty address for {linkMeta.label}, so it can&apos;t read or reveal this
          finding. Set the deployment address for this chain and reload.
        </p>
      </Card>
    );
  }

  if (chain.isLoading) {
    return (
      <Card className="p-5">
        <p className="text-xs text-mist">Reading the chain...</p>
      </Card>
    );
  }

  const sub = chain.submission;
  if (!sub || !program.program) {
    return (
      <Card className="p-5">
        <h2 className="text-sm font-medium text-chalk">On-chain submission #{onchainSubmissionId}</h2>
        <p className="mt-2 text-xs leading-relaxed text-mist">
          Couldn&apos;t read it back from {linkMeta.label}. It exists, and the contract has an id for it, but this
          deployment didn&apos;t answer just now. Reload in a moment.
        </p>
      </Card>
    );
  }

  const chainStatus = CHAIN_SUB_STATUS[sub.status] ?? "pending";
  const now = Math.floor(Date.now() / 1000);
  const triagedAt = Number(sub.triagedAt);
  const revealableAt = triagedAt + Number(program.program.disclosureDelay);
  const revealed = !!sub.reportURI || !!revealedAt;
  const canReveal =
    !revealed && chainStatus !== "pending" && (chain.embargoWaived || now >= revealableAt);
  const revealCountdown = triagedAt > 0 ? untilLabel(revealableAt) : null;

  // Escalation ground 1: the SLA lapsed with the finding still pending. The
  // contract holds its escrow cover when this happens, so the ruling is payable.
  const slaDeadline = Number(chain.triageDeadline ?? 0n);
  const canEscalateSla = chainStatus === "pending" && slaDeadline > 0 && now > slaDeadline;
  // Escalation ground 2: disputing a verdict, inside the dispute window.
  const disputeDeadline = triagedAt > 0 ? triagedAt + Number(PROTOCOL_FALLBACK.disputeWindow) : 0;
  const canDispute =
    ["rejected", "duplicate", "spam"].includes(chainStatus) && disputeDeadline > 0 && now <= disputeDeadline;
  const disputeCountdown = disputeDeadline > 0 ? untilLabel(disputeDeadline) : null;

  const isEscalated = chainStatus === "escalated";
  const isResolved = chainStatus === "resolved";

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-chalk">On-chain state</h2>
          <span className="text-[11px] text-mist">
            #{onchainSubmissionId} on {linkMeta.short}
          </span>
        </div>

        <dl className="mt-3 space-y-1.5 text-xs">
          <Line label="verdict" value={chainStatus} />
          <Line
            label="severity"
            value={sub.severity > 0 ? severityMeta[INDEX_SEVERITY[sub.severity] as Severity].label : "n/a"}
          />
          <Line label="submitted" value={new Date(Number(sub.submittedAt) * 1000).toLocaleString()} />
          {triagedAt > 0 && <Line label="triaged" value={new Date(triagedAt * 1000).toLocaleString()} />}
          <Line label="commit" value={short(sub.commitHash)} />
          {sub.award > 0n && (
            <Line
              label="award"
              value={fmtAmount(
                sub.award,
                assetInfo(chainId, program.program.rewardToken).decimals,
                assetInfo(chainId, program.program.rewardToken).symbol,
              )}
            />
          )}
          {sub.bond > 0n && <Line label="anti-spam bond" value={fmtAmount(sub.bond, 18, "$BUG")} />}
          {sub.dupeOf > 0n && <Line label="duplicate of" value={`#${sub.dupeOf}`} />}
          {revealed && <Line label="report" value={<Copyable value={sub.reportURI} display={short(sub.reportURI)} />} />}
        </dl>

        {isEscalated && (
          <p className="mt-3 rounded border border-orange-500/30 bg-orange-500/[0.06] p-2.5 text-[11px] leading-relaxed text-mist">
            With the arbiter.{" "}
            {chain.escalatedFromPending
              ? "Because this was escalated from pending, the escrow covering it is still reserved. A ruling in your favour is payable from the pool."
              : "This is a dispute of a recorded verdict, so the escrow was released when it was triaged."}
          </p>
        )}
        {isResolved && (
          <p className="mt-3 text-[11px] leading-relaxed text-mist">
            The arbiter has ruled. Rewards and bond credit are withdrawn from your wallet drawer.
          </p>
        )}
      </Card>

      {/* Preimage self-check: the one thing a hunter must never be wrong about. */}
      <Card className={`p-5 ${verification?.ok === false ? "border-red-500/40 bg-red-500/[0.04]" : ""}`}>
        <h2 className="text-sm font-medium text-chalk">Your commit secret</h2>
        {!commitHash ? (
          <p className="mt-2 text-xs leading-relaxed text-mist">
            This finding was indexed from the chain, so the report URI and salt, which never left the hunter&apos;s                device, aren&apos;t here. Import the receipt file to reveal it.
          </p>
        ) : entry ? (
          verification?.ok ? (
            <p className="mt-2 text-xs leading-relaxed text-bug">
              Your saved salt opens this commit. Reveal will be accepted once the disclosure embargo has run.
            </p>
          ) : verification ? (
            <div className="mt-2 space-y-1.5 text-xs">
              <p className="text-red-400">
                This salt doesn&apos;t open the commit the chain holds. Revealing with it would revert, and the
                mismatch can&apos;t be repaired. Check you imported the right receipt.
              </p>
              <p className="font-mono text-[11px] break-all text-mist">
                yours: {verification.recomputed}
                <br />
                chain: {verification.onchain}
              </p>
            </div>
          ) : (
            <p className="mt-2 text-xs text-mist">Checking...</p>
          )
        ) : (
          <div className="mt-2 space-y-2">
            <p className="text-xs leading-relaxed text-mist">
              No secret for this commit is stored in this browser. Import the receipt file you downloaded when you
              submitted. Without it the finding can never be revealed.
            </p>
            <input
              type="file"
              accept="application/json,.json"
              className="block w-full text-xs text-mist file:mr-3 file:rounded file:border file:border-line file:bg-ink file:px-3 file:py-1.5 file:text-xs file:text-chalk hover:file:border-mist"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const imported = importReceipt(await file.text());
                if (imported) {
                  setEntry(imported);
                  setImportNote("Receipt imported and stored in this browser.");
                } else {
                  setImportNote("That file doesn't look like a commit receipt.");
                }
              }}
            />
            {importNote && <p className="text-[11px] text-mist">{importNote}</p>}
          </div>
        )}

        {loaded && !entry && !commitHash && (
          <p className="mt-2 text-[11px] text-mist">
            Only the hunter who filed this holds the salt. Nothing on this site can reconstruct it.
          </p>
        )}
      </Card>

      {/* Actions */}
      <Card className="p-5">
        <h2 className="text-sm font-medium text-chalk">Actions</h2>

        <div className="mt-3 space-y-3">
          <div>
            <Button
              disabled={!canReveal || !entry || reveal.busy}
              onClick={() =>
                entry &&
                afterTx(() =>
                  reveal.run({
                    address: meta.bounty!,
                    abi: bountyAbi,
                    functionName: "reveal",
                    args: [BigInt(onchainSubmissionId), entry.reportURI, entry.salt],
                  }),
                )
              }
            >
              {reveal.busy ? "revealing..." : revealed ? "Already revealed" : "Reveal report"}
            </Button>
            <p className="mt-1.5 text-[11px] leading-relaxed text-mist">
              {revealed
                ? "The report URI is now public on chain, which proves the revealed document is the one you committed to."
                : chainStatus === "pending"
                  ? "Reveal unlocks once the owner has triaged. The embargo is measured from their decision."
                  : chain.embargoWaived
                    ? "The owner has waived the embargo, so you can reveal now."
                    : canReveal && isEscalated && chain.escalatedFromPending
                      ? "You can reveal right away here: the disclosure delay is measured from a triage that never happened, so nothing is holding it back. Revealing is also what puts the evidence in front of the arbiter, who can only judge what they can read."
                      : revealCountdown?.lapsed
                      ? "The embargo has run, so revealing is allowed."
                      : `The owner's disclosure delay runs until ${new Date(revealableAt * 1000).toLocaleString()}${
                          revealCountdown ? ` (${revealCountdown.label})` : ""
                        }.`}
            </p>
          </div>

          {(canEscalateSla || canDispute || isEscalated) && (
            <div className="border-t border-line pt-3">
              <Button
                variant={canEscalateSla ? "primary" : "ghost"}
                disabled={escalate.busy || isEscalated || (!canEscalateSla && !canDispute)}
                onClick={() =>
                  afterTx(() =>
                    escalate.run({
                      address: meta.bounty!,
                      abi: bountyAbi,
                      functionName: "escalate",
                      args: [BigInt(onchainSubmissionId)],
                    }),
                  )
                }
              >
                {escalate.busy ? "escalating..." : isEscalated ? "Escalated" : "Escalate to the arbiter"}
              </Button>
              <p className="mt-1.5 text-[11px] leading-relaxed text-mist">
                {isEscalated
                  ? "Waiting on the arbiter's ruling."
                  : canEscalateSla
                    ? "The owner has missed the triage deadline. Escalating hands the decision to the arbiter, and the escrow set aside for this finding stays reserved until they rule."
                    : `You can dispute this verdict until ${disputeCountdown?.label ?? "the window closes"}. Losing an appeal in good faith doesn't cost you the bond. Only a bad-faith ruling does.`}
              </p>
            </div>
          )}
        </div>

        {(error || reveal.error || escalate.error) && (
          <p className="mt-3 text-xs text-red-400">{error ?? reveal.error ?? escalate.error}</p>
        )}
      </Card>

      <RewardsCard chainId={chainId} rewardToken={rewardToken} status={status} onDone={refresh} />
    </div>
  );
}

function Line({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-mist">{label}</dt>
      <dd className="text-right font-mono text-[11px] text-chalk">{value}</dd>
    </div>
  );
}

/**
 * Claimable rewards, including the program's own reward token.
 *
 * The wallet drawer knows native + USDC; a program can escrow anything, so
 * without this a hunter paid in a niche token could see the award on chain and
 * have no way to pull it.
 */
function RewardsCard({
  chainId,
  rewardToken,
  status,
  onDone,
}: {
  chainId: number;
  rewardToken: string | null;
  status: SubmissionStatus;
  onDone: () => void;
}) {
  const { address } = useAccount();
  const { address: bounty } = useBounty();
  const [key, setKey] = useState(0);
  const balances = useMyBalances(key, rewardToken ? [rewardToken as Address] : []);
  const claim = useTx(() => {
    setKey((k) => k + 1);
    onDone();
  });

  const owed = balances.claimable.filter((c) => c.amount > 0n);
  if (!address || (!owed.length && (balances.bondCredit ?? 0n) === 0n)) return null;

  return (
    <Card className="p-5">
      <h2 className="text-sm font-medium text-chalk">Withdraw</h2>
      <p className="mt-1.5 text-[11px] leading-relaxed text-mist">
        The contract never pushes funds to you, so a wallet that reverts on receive can&apos;t block anyone else&apos;s
        triage. You pull, whenever you like.
      </p>
      <div className="mt-3 space-y-2">
        {owed.map((c) => {
          const info = assetInfo(chainId, c.token);
          const isUsdc = balances.usdc && c.token.toLowerCase() === balances.usdc.toLowerCase();
          const symbol = isUsdc ? "USDC" : info.symbol;
          const decimals = isUsdc ? 6 : info.decimals;
          return (
            <div key={c.token} className="flex items-center justify-between gap-3">
              <span className="text-xs text-chalk">{fmtAmount(c.amount, decimals, symbol)}</span>
              <Button
                variant="ghost"
                disabled={claim.busy}
                onClick={() =>
                  claim.run({ address: bounty!, abi: bountyAbi, functionName: "claim", args: [c.token, address] })
                }
              >
                {claim.busy ? "..." : "claim"}
              </Button>
            </div>
          );
        })}
        {(balances.bondCredit ?? 0n) > 0n && (
          <div className="flex items-center justify-between gap-3 border-t border-line pt-2">
            <span className="text-xs text-chalk">{fmtAmount(balances.bondCredit ?? 0n, 18, "$BUG bond")}</span>
            <Button
              variant="ghost"
              disabled={claim.busy}
              onClick={() =>
                claim.run({ address: bounty!, abi: bountyAbi, functionName: "withdrawBond", args: [address] })
              }
            >
              {claim.busy ? "..." : "withdraw"}
            </Button>
          </div>
        )}
      </div>
      {claim.error && <p className="mt-2 text-[11px] text-red-400">{claim.error}</p>}
      {owed.length === 0 && (balances.bondCredit ?? 0n) === 0n && status !== "accepted" && (
        <p className="mt-2 text-[11px] text-mist">Nothing to withdraw yet.</p>
      )}
    </Card>
  );
}
