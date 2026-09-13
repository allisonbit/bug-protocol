"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { useAccount, useChainId } from "wagmi";
import {
  bountyAbi,
  CHAIN_SUB_STATUS,
  PROTOCOL_FALLBACK,
  SEVERITY_INDEX,
  VERDICT_INDEX,
  severityIndexOf,
} from "@/lib/contract";
import { decryptReport } from "@/lib/commit";
import { useProgram } from "@/lib/reads";
import { useTx } from "@/lib/useTx";
import { triageSubmission, discloseSubmission } from "@/app/actions";
import { assetInfo, chainMeta } from "@/lib/chains";
import { fmtAmount, untilLabel } from "@/lib/format";
import { Button, Card, Field, Input, Select, Textarea } from "@/components/ui";
import {
  money,
  tierFor,
  SEVERITIES,
  severityMeta,
  type Program,
  type Severity,
  type SubmissionStatus,
} from "@/lib/db";

/**
 * Serializable snapshot of what the chain says about a submission, shaped by the
 * page's server-side read. Passing this in means the owner's first paint shows the
 * real verdict instead of flashing "pending" and then correcting itself.
 */
export type ChainFacts = {
  status: string;
  statusIndex: number;
  severityIndex: number;
  /** Award and bond are decimal strings of base units. Bigints don't cross the
   *  server/client boundary in a typed way, and these are display values here. */
  award: string;
  bond: string;
  reportURI: string;
  submittedAt: number;
  triagedAt: number;
  triageDeadline: number;
  escalatedFromPending: boolean;
  embargoWaived: boolean;
};

type TriageSub = {
  id: string;
  title: string;
  severity: Severity;
  assigned_severity: Severity | null;
  status: SubmissionStatus;
  reward: number;
  triage_note: string | null;
  encrypted: boolean;
};

/**
 * Decrypts the report in the browser.
 *
 * This is the payoff for the whole envelope design: the server has held only
 * ciphertext, and the plaintext appears here because the owner was given the
 * passphrase out of band. Nothing is sent anywhere to make this work.
 */
export function ReportPanel({ report, encrypted }: { report: string | null; encrypted: boolean }) {
  const [pass, setPass] = useState("");
  const [plain, setPlain] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!report) return null;

  const looksEnveloped = encrypted || report.trimStart().startsWith("{" );

  return (
    <section>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium text-chalk">Report</h2>
        {looksEnveloped && (
          <span className="rounded border border-line px-2 py-0.5 text-[11px] text-mist">encrypted envelope</span>
        )}
      </div>

      {looksEnveloped && plain === null && (
        <div className="mt-3 rounded-xl border border-line bg-ink-soft p-4">
          <p className="text-xs leading-relaxed text-mist">
            This report is sealed with AES-GCM. The hunter gave you a passphrase; enter it to read the finding. It is
            decrypted here in your browser and never sent to the server, which is why nobody here can read it for you.
          </p>
          <div className="mt-3 flex gap-2">
            <Input
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              placeholder="passphrase from the hunter"
            />
            <Button
              variant="ghost"
              className="shrink-0"
              disabled={!pass || busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  setPlain(await decryptReport(report, pass));
                } catch {
                  setError("Couldn't decrypt. That passphrase doesn't open this envelope.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "..." : "decrypt"}
            </Button>
          </div>
          {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
        </div>
      )}

      {(plain !== null || !looksEnveloped) && (
        <div className="mt-3 whitespace-pre-wrap rounded-xl border border-line bg-ink-soft p-5 font-mono text-xs leading-relaxed text-mist-bright">
          {plain ?? report}
        </div>
      )}

      {plain !== null && (
        <p className="mt-2 text-[11px] text-mist">
          Decrypted locally. If you accept this finding, publish nothing here. The hunter reveals the report
          themselves once the embargo has run.
        </p>
      )}
    </section>
  );
}

const OUTCOMES: { value: Exclude<SubmissionStatus, "disclosed" | "escalated" | "resolved">; label: string; blurb: string }[] = [
  { value: "accepted", label: "Accept & pay", blurb: "Credits the award out of escrow in the same transaction." },
  { value: "rejected", label: "Reject", blurb: "An honest miss costs the hunter nothing. The bond comes back." },
  { value: "duplicate", label: "Duplicate", blurb: "Must point at an earlier accepted finding on this program." },
  { value: "spam", label: "Spam", blurb: "Holds the bond for the dispute window; it is slashed only if unchallenged." },
];

/**
 * Triage.
 *
 * On an escrowed program the decision IS a transaction. The contract computes the
 * award out of the pool and there is no way to pay a hunter without it. So this
 * panel sends `triage(...)` first and then records the note here; it never asks the
 * owner to type a number that the chain has already decided.
 *
 * The guards below mirror the contract's own, so the owner is stopped before
 * signing rather than after: `Severity.None` and unpayable tiers are unwritable,
 * a duplicate reference has to be an earlier *accepted* submission on the same
 * program, and the triage window has to still be open.
 */
export function TriagePanel({
  submission,
  program,
  facts,
  dupeOptions,
  rewardToken,
  onchainProgramId,
}: {
  submission: TriageSub;
  program: Pick<Program, "currency" | "tier_low" | "tier_medium" | "tier_high" | "tier_critical">;
  facts: ChainFacts | null;
  dupeOptions: { id: number; title: string }[];
  rewardToken: string | null;
  onchainProgramId: number | null;
}) {
  const chainId = useChainId();
  const escrowed = facts !== null;

  // Live tier reads, so the owner can see which severities the contract can
  // actually pay and which are zero (a zero tier is unwritable: Severity.None
  // is deliberately unpayable, so accepting at one would revert).
  const onchain = useProgram(onchainProgramId ? BigInt(onchainProgramId) : undefined);

  const [status, setStatus] = useState<"accepted" | "rejected" | "duplicate" | "spam">(
    submission.status === "accepted" || submission.status === "disclosed" ? "accepted" : "rejected",
  );
  const [assigned, setAssigned] = useState<Severity>(submission.assigned_severity ?? submission.severity);
  const [reward, setReward] = useState<number>(
    submission.reward || tierFor(program as Program, submission.assigned_severity ?? submission.severity),
  );
  const [dupeOf, setDupeOf] = useState<string>(dupeOptions[0] ? String(dupeOptions[0].id) : "");
  const [note, setNote] = useState(submission.triage_note ?? "");
  const [error, setError] = useState<string | null>(null);

  const tx = useTx();
  // The contract reverts with TriageWindowClosed once the SLA lapses, which is
  // exactly the moment the hunter gains the right to escalate, so the owner is
  // warned rather than discovering it in a revert.
  const windowOpen = !facts || facts.triageDeadline === 0 || Date.now() / 1000 <= facts.triageDeadline;
  const canRetriage = !facts || facts.statusIndex === 0;

  if (escrowed && !canRetriage) {
    // The verdict is already recorded on chain. Re-triage is impossible by design
    // (the contract reverts NotPending), so this becomes a note-only panel.
    return (
      <NoteOnly
        submissionId={submission.id}
        note={note}
        setNote={setNote}
        status={submission.status}
        onchainStatus={facts.status}
      />
    );
  }

  async function submitOffchain(fd: FormData) {
    setError(null);
    try {
      await triageSubmission(fd);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the decision.");
    }
  }

  async function submitOnchain() {
    setError(null);
    if (!facts) return;
    const meta = chainMeta(chainId);
    if (!meta.bounty) return setError(`No contract address configured for ${meta.label}.`);
    if (status === "duplicate" && !dupeOf) return setError("Pick the earlier accepted finding this duplicates.");

    const fd = new FormData();
    fd.set("submission_id", submission.id);
    fd.set("triage_note", note);

    try {
      const txHash = await tx.run({
        address: meta.bounty,
        abi: bountyAbi,
        functionName: "triage",
        args: [
          BigInt(submission.id),
          VERDICT_INDEX[status],
          status === "accepted" ? severityIndexOf(assigned) : 0,
          status === "duplicate" ? BigInt(dupeOf) : 0n,
        ],
      });
      if (!txHash) return setError(tx.error ?? "The triage transaction didn't confirm.");
      // The verdict is on chain; this records the note and mirrors the numbers.
      fd.set("tx_hash", txHash);
      await triageSubmission(fd);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't record the decision.");
    }
  }

  // A tier the contract reads as zero cannot be accepted at: `triage` reverts
  // InvalidSeverity. Disabling it is honest; the alternative is a signature that
  // is guaranteed to fail.
  const tierZeroFor: Record<Severity, boolean> = {
    none: true,
    low: !onchain.tiers?.[1] || onchain.tiers?.[1] === 0n,
    medium: !onchain.tiers?.[2] || onchain.tiers?.[2] === 0n,
    high: !onchain.tiers?.[3] || onchain.tiers?.[3] === 0n,
    critical: !onchain.tiers?.[4] || onchain.tiers?.[4] === 0n,
  };
  const rewardInfo = assetInfo(chainId, (rewardToken ?? "0x0000000000000000000000000000000000000000") as `0x${string}`);


  return (
    <Card className="border-bug-dim/40 bg-bug-dim/[0.05] p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-chalk">Triage</h2>
        {facts && (
          <span className="rounded border border-line px-2 py-0.5 text-[11px] text-mist">
            on-chain, {CHAIN_SUB_STATUS[facts.statusIndex]}
          </span>
        )}
      </div>

      <div className="mt-4 space-y-4">
        <Field label="Decision">
          <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            {OUTCOMES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <span className="mt-1 block text-[11px] text-mist">
            {OUTCOMES.find((o) => o.value === status)?.blurb}
          </span>
        </Field>

        <div>
          <span className="text-xs text-chalk">Final severity</span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {SEVERITIES.map((s) => {
              const on = assigned === s;
              const unpayable = facts ? tierZeroFor[s] : false;
              return (
                <button
                  key={s}
                  type="button"
                  disabled={unpayable}
                  title={unpayable ? "This tier is zero on chain, so the contract would revert" : undefined}
                  onClick={() => {
                    setAssigned(s);
                    if (!facts) setReward(tierFor(program as Program, s));
                  }}
                  className={`rounded-md border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
                    on ? severityMeta[s].tone + " bg-panel" : "border-line text-mist hover:text-chalk"
                  }`}
                >
                  {severityMeta[s].label}
                </button>
              );
            })}
          </div>
          {facts && status === "accepted" && (
            <p className="mt-1.5 text-[11px] text-mist">
              The contract pays{" "}
              <span className="text-bug">
                {fmtAmount(
                  onchain.tiers?.[severityIndexOf(assigned)] ?? 0n,
                  rewardInfo.decimals,
                  rewardInfo.symbol,
                )}
              </span>{" "}
              out of escrow at this tier, in the same transaction. Tiers are frozen while findings are open.
            </p>
          )}
          {!facts && (
            <p className="mt-1.5 text-[11px] text-mist">
              Suggested from your {severityMeta[assigned].label} tier:{" "}
              {money(tierFor(program as Program, assigned), program.currency)}
            </p>
          )}
        </div>

        {status === "duplicate" && (
          <Field label="Duplicate of" hint="Only an earlier, already-accepted finding on this program counts.">
            {dupeOptions.length ? (
              <Select value={dupeOf} onChange={(e) => setDupeOf(e.target.value)}>
                {dupeOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    #{d.id}: {d.title}
                  </option>
                ))}
              </Select>
            ) : (
              <p className="text-[11px] text-amber-300">
                This program has no earlier accepted on-chain finding, so a duplicate verdict would be rejected by the
                contract.
              </p>
            )}
          </Field>
        )}

        {!facts && status === "accepted" && (
          <Field label={`Reward (${program.currency})`}>
            <Input
              type="number"
              min={0}
              value={reward}
              onChange={(e) => setReward(Number(e.target.value) || 0)}
            />
          </Field>
        )}

        <Field label="Note to hunter">
          <Textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional: explain the decision or ask for more detail."
          />
        </Field>

        {facts ? (
          <>
            <Button disabled={tx.busy || !windowOpen} onClick={submitOnchain} className="w-full">
              {tx.busy
                ? "confirming..."
                : status === "accepted"
                  ? "Accept & pay from escrow"
                  : `Record ${status}`}
            </Button>
            <p className="text-[11px] leading-relaxed text-mist">
              This sends the triage transaction. Accepting credits the hunter&apos;s claim out of the program pool in the
              same call. The client never gets a chance to pay later, or to refuse.
            </p>
          </>
        ) : (
          <form action={submitOffchain}>
            <input type="hidden" name="submission_id" value={submission.id} />
            <input type="hidden" name="status" value={status} />
            <input type="hidden" name="assigned_severity" value={assigned} />
            {status === "accepted" && <input type="hidden" name="reward" value={reward} />}
            <input type="hidden" name="triage_note" value={note} />
            <Submit accepted={status === "accepted"} reward={reward} currency={program.currency} />
          </form>
        )}

        {error && <p className="text-[11px] text-red-400">{error}</p>}
        {tx.error && <p className="text-[11px] text-red-400">{tx.error}</p>}
      </div>
    </Card>
  );
}

/** Note-only panel for a submission the chain has already decided. */
function NoteOnly({
  submissionId,
  note,
  setNote,
  status,
  onchainStatus,
}: {
  submissionId: string;
  note: string;
  setNote: (v: string) => void;
  status: SubmissionStatus;
  onchainStatus: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card className="p-5">
      <h2 className="text-sm font-medium text-chalk">Recorded on chain</h2>
      <p className="mt-2 text-[11px] leading-relaxed text-mist">
        The verdict is <span className="text-chalk">{onchainStatus}</span>, and a verdict on chain is final. The
        contract refuses to triage the same submission twice. The hunter can dispute it to the arbiter within the
        dispute window. Your note is still editable.
      </p>
      <div className="mt-3">
        <Field label="Note to hunter">
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Button
          variant="ghost"
          className="mt-3"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const fd = new FormData();
            fd.set("submission_id", submissionId);
            fd.set("triage_note", note);
            try {
              await triageSubmission(fd);
            } catch (e) {
              setError(e instanceof Error ? e.message : "Couldn't save the note.");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "..." : "Save note"}
        </Button>
        {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
        {status === "spam" && (
          <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-mist">
            A spam verdict holds the hunter&apos;s bond rather than taking it. Once the dispute window closes with no
            appeal, anyone can finalize the slash.
          </p>
        )}
      </div>
    </Card>
  );
}

function Submit({ accepted, reward, currency }: { accepted: boolean; reward: number; currency: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="glow w-full rounded-md bg-lime py-2.5 text-sm font-medium text-graphite transition-transform hover:scale-[1.01] disabled:opacity-50"
    >
      {pending ? "Saving..." : accepted ? `Accept & pay ${money(reward, currency)}` : "Save decision"}
    </button>
  );
}

/**
 * Releases the disclosure embargo early.
 *
 * The embargo exists so a fix can ship before the finding becomes public. The
 * owner is the one who knows when the fix is deployed, so the contract lets them
 * waive it rather than making the hunter wait out a timer that no longer serves a
 * purpose.
 */
export function WaiveEmbargoPanel({
  onchainSubmissionId,
  waived,
}: {
  onchainSubmissionId: number;
  waived: boolean;
}) {
  const { address } = useAccount();
  const chainId = useChainId();
  const tx = useTx();
  const meta = chainMeta(chainId);
  if (waived) {
    return (
      <Card className="p-5">
        <h2 className="text-sm font-medium text-chalk">Disclosure embargo waived</h2>
        <p className="mt-2 text-[11px] leading-relaxed text-mist">
          The hunter may reveal their report now. Revealing makes the report URI public on chain and proves it is the
          document that was committed to.
        </p>
      </Card>
    );
  }
  return (
    <Card className="p-5">
      <h2 className="text-sm font-medium text-chalk">Disclosure embargo</h2>
      <p className="mt-2 text-[11px] leading-relaxed text-mist">
        The hunter can&apos;t publish their report until the disclosure delay has run from your decision. Waive it once
        the fix is deployed and you&apos;re happy for this to become public.
      </p>
      <Button
        variant="ghost"
        className="mt-3"
        disabled={tx.busy || !meta.bounty || !address}
        onClick={() =>
          tx.run({
            address: meta.bounty!,
            abi: bountyAbi,
            functionName: "waiveEmbargo",
            args: [BigInt(onchainSubmissionId)],
          })
        }
      >
        {tx.busy ? "..." : "Waive embargo"}
      </Button>
      {tx.error && <p className="mt-2 text-[11px] text-red-400">{tx.error}</p>}
    </Card>
  );
}

/**
 * Collects a slashed spam bond once it can no longer be disputed.
 *
 * Deliberately permissionless in the contract, and shown here as such: the owner
 * isn't the only one who can clean this up, and the bond is held, not taken,
 * until the window closes. That delay is what makes a bad-faith Spam call
 * reversible, which is the whole reason it isn't credited at triage time.
 */
export function SpamFinalizePanel({ onchainSubmissionId, triagedAt }: { onchainSubmissionId: number; triagedAt: number }) {
  const { address } = useAccount();
  const chainId = useChainId();
  const tx = useTx();
  const meta = chainMeta(chainId);
  const window = Number(PROTOCOL_FALLBACK.disputeWindow);
  const closesAt = triagedAt + window;
  const countdown = untilLabel(closesAt);
  return (
    <Card className="p-5">
      <h2 className="text-sm font-medium text-chalk">Held bond</h2>
      <p className="mt-2 text-[11px] leading-relaxed text-mist">
        The anti-spam bond is held, not taken, until the hunter&apos;s dispute window closes
        {triagedAt > 0 ? ` (${countdown.label})` : ""}. If they don&apos;t appeal to the arbiter in that time, the slash
        can be finalized by anyone.
      </p>
      <Button
        variant="ghost"
        className="mt-3"
        disabled={tx.busy || !meta.bounty || !address || !countdown.lapsed}
        onClick={() =>
          tx.run({
            address: meta.bounty!,
            abi: bountyAbi,
            functionName: "finalizeSpamSlash",
            args: [BigInt(onchainSubmissionId)],
          })
        }
      >
        {tx.busy ? "..." : countdown.lapsed ? "Finalize slash" : "Dispute window still open"}
      </Button>
      {tx.error && <p className="mt-2 text-[11px] text-red-400">{tx.error}</p>}
    </Card>
  );
}

/**
 * Public disclosure: the step after acceptance that turns a private finding into
 * a public credential on the hunter's profile. Reversible; the report body never
 * becomes public here (the chain's reveal is the hunter's own, separate act).
 */
export function DisclosePanel({
  id,
  disclosed,
  slug,
  handle,
}: {
  id: string;
  disclosed: boolean;
  slug: string;
  handle: string;
}) {
  return (
    <form
      action={discloseSubmission}
      className={`rounded-xl border p-5 ${
        disclosed ? "border-violet-500/30 bg-violet-500/[0.06]" : "border-line bg-ink-soft"
      }`}
    >
      <input type="hidden" name="submission_id" value={id} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="handle" value={handle} />
      <input type="hidden" name="disclose" value={disclosed ? "off" : "on"} />
      <h2 className="flex items-center gap-2 text-sm font-medium text-chalk">
        {disclosed && <span className="size-1.5 rounded-full bg-violet-400" />}
        {disclosed ? "Publicly disclosed" : "Public disclosure"}
      </h2>
      <p className="mt-2 text-xs leading-relaxed text-mist">
        {disclosed
          ? "This finding is public. It appears on the hunter's profile and counts toward their track record. The write-up stays private. You can make it private again."
          : "Once the fix has shipped, publish this as a credential. The title, severity and reward appear on the hunter's public profile. The report body stays private."}
      </p>
      <DiscloseButton disclosed={disclosed} />
    </form>
  );
}

function DiscloseButton({ disclosed }: { disclosed: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={
        disclosed
          ? "mt-4 w-full rounded-md border border-line py-2 text-sm text-mist transition-colors hover:text-chalk disabled:opacity-50"
          : "mt-4 w-full rounded-md bg-violet-500/90 py-2.5 text-sm font-medium text-white transition-transform hover:scale-[1.01] disabled:opacity-50"
      }
    >
      {pending ? "Saving..." : disclosed ? "Make private again" : "Disclose publicly"}
    </button>
  );
}
