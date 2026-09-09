"use client";

import Link from "next/link";
import { use, useState } from "react";
import { useAccount } from "wagmi";
import { bountyAbi } from "@/lib/contract";
import { useProgram, useProtocolMeta, useSubmission, useBounty, useExplorer } from "@/lib/reads";
import { assetInfo } from "@/lib/chains";
import { useTx } from "@/lib/useTx";
import { findBySubmissionId, importReceipt } from "@/lib/vault";
import {
  fmtAmount,
  fmtDate,
  severityName,
  severityTone,
  subStatusName,
  subTone,
  untilLabel,
} from "@/lib/format";
import { Badge, Button, Card, Copyable, Field, Input, Select, SectionTitle, Stat, Textarea } from "@/components/ui";

export default function SubmissionDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const sid = BigInt(id);
  const { address } = useAccount();
  const { address: bounty, isDeployed, chainId } = useBounty();
  const explorer = useExplorer();
  const [key, setKey] = useState(0);
  const refresh = () => setKey((k) => k + 1);

  const meta = useProtocolMeta();
  const { submission } = useSubmission(sid, key);
  const { program } = useProgram(submission ? submission.programId : undefined, key);
  const tx = useTx(refresh);

  if (!isDeployed) {
    return (
      <Shell id={id}>
        <Card className="p-6">
          <p className="text-sm text-warn">Protocol not deployed on this network yet.</p>
          <p className="mt-2 text-sm text-mist">
            Reveal, triage, escalate and arbiter actions are all wired against the live ABI. Switch
            networks in the top bar to act on the chain this submission lives on.
          </p>
        </Card>
      </Shell>
    );
  }
  if (!submission) {
    return (
      <Shell id={id}>
        <p className="text-sm text-mist">reading submission #{id}…</p>
      </Shell>
    );
  }

  const isHunter = !!address && submission.hunter.toLowerCase() === address.toLowerCase();
  const isOwner = !!address && !!program && program.owner.toLowerCase() === address.toLowerCase();
  const isArbiter = !!address && !!meta.arbiter && meta.arbiter.toLowerCase() === address.toLowerCase();
  const status = subStatusName(submission.status);
  const asset = program ? assetInfo(chainId, program.rewardToken) : { symbol: "", decimals: 18 };

  const triageDeadline = program ? Number(submission.submittedAt) + Number(program.triageDeadline) : 0;
  const disclosureAt = program ? Number(submission.triagedAt) + Number(program.disclosureDelay) : 0;

  return (
    <Shell id={id}>
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={subTone[status]}>{status}</Badge>
        {submission.severity > 0 && (
          <span className={`text-sm ${severityTone[severityName(submission.severity)]}`}>{severityName(submission.severity)}</span>
        )}
        {isHunter && <Badge tone="text-bug border-bug-dim">your submission</Badge>}
        {isOwner && <Badge tone="text-bug border-bug-dim">you own this program</Badge>}
        {isArbiter && <Badge tone="text-warn border-warn/50">arbiter</Badge>}
        <Link href={`/programs/${submission.programId}`} className="ml-auto text-xs text-bug hover:underline">
          program #{String(submission.programId)} →
        </Link>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Hunter" value={<a className="text-bug underline" href={explorer.address(submission.hunter)}>{submission.hunter.slice(0, 10)}…</a>} />
        <Stat label="Submitted" value={<span className="text-sm">{fmtDate(submission.submittedAt)}</span>} />
        <Stat label="Award" value={submission.award > 0n ? fmtAmount(submission.award, asset.decimals, asset.symbol) : "—"} />
        <Stat label="Anti-spam bond" value={fmtAmount(submission.bond, 18, "$BUG")} />
      </div>

      <div className="mt-4 rounded border border-line bg-ink p-4 text-xs">
        <span className="text-mist">commitHash </span>
        <Copyable value={submission.commitHash} />
        {submission.reportURI ? (
          <p className="mt-2">
            <span className="text-mist">revealed report </span>
            <a className="text-bug underline underline-offset-4" href={submission.reportURI} target="_blank" rel="noreferrer">
              {submission.reportURI}
            </a>
          </p>
        ) : (
          <p className="mt-2 text-mist">report not yet revealed — body remains private</p>
        )}
      </div>

      {/* Owner triage */}
      {isOwner && submission.status === 0 && (
        <TriagePanel sid={sid} refresh={refresh} deadline={triageDeadline} program={submission.programId} />
      )}

      {/* Owner waive embargo */}
      {isOwner && (submission.status === 1 || submission.status === 6) && !submission.reportURI && (
        <Card className="mt-4 p-5">
          <SectionTitle>Disclosure</SectionTitle>
          <p className="mt-2 text-xs text-mist">
            Embargo lifts {disclosureAt ? untilLabel(disclosureAt).label : "—"}. Fixed already? Waive
            it so the hunter can publish now.
          </p>
          <Button
            className="mt-3"
            variant="ghost"
            disabled={tx.busy || !bounty}
            onClick={() => tx.run({ address: bounty!, abi: bountyAbi, functionName: "waiveEmbargo", args: [sid] })}
          >
            waive embargo
          </Button>
        </Card>
      )}

      {/* Hunter reveal */}
      {isHunter && !submission.reportURI && submission.status !== 0 && (
        <RevealPanel sid={sid} refresh={refresh} disclosureAt={disclosureAt} />
      )}

      {/* Hunter escalate */}
      {isHunter && [0, 2, 3, 4].includes(submission.status) && (
        <Card className="mt-4 p-5">
          <SectionTitle>Escalate to arbiter</SectionTitle>
          <p className="mt-2 text-xs text-mist">
            {submission.status === 0
              ? `If triage lapses (${untilLabel(triageDeadline).label}) you can force review.`
              : "Dispute this verdict within 7 days of triage. Losing in good faith never costs your bond."}
          </p>
          <Button
            className="mt-3"
            variant="ghost"
            disabled={tx.busy || !bounty}
            onClick={() => tx.run({ address: bounty!, abi: bountyAbi, functionName: "escalate", args: [sid] })}
          >
            escalate
          </Button>
        </Card>
      )}

      {/* Anyone: finalize spam slash after window */}
      {submission.status === 4 && (
        <Card className="mt-4 p-5">
          <SectionTitle>Finalize spam slash</SectionTitle>
          <p className="mt-2 text-xs text-mist">After the 7-day dispute window, the flagged bond is slashed to the protocol. Permissionless.</p>
          <Button
            className="mt-3"
            variant="ghost"
            disabled={tx.busy || !bounty}
            onClick={() => tx.run({ address: bounty!, abi: bountyAbi, functionName: "finalizeSpamSlash", args: [sid] })}
          >
            finalize
          </Button>
        </Card>
      )}

      {/* Arbiter resolve */}
      {isArbiter && submission.status === 5 && <ArbiterPanel sid={sid} refresh={refresh} />}

      {(tx.error) && <p className="mt-4 text-xs text-red-400">{tx.error}</p>}
      {tx.hash && (
        <a className="mt-3 block text-xs text-bug underline" href={explorer.tx(tx.hash)}>
          view transaction ↗
        </a>
      )}
    </Shell>
  );
}

function TriagePanel({ sid, refresh, deadline, program }: { sid: bigint; refresh: () => void; deadline: number; program: bigint }) {
  const { address: bounty } = useBounty();
  const tx = useTx(refresh);
  const [verdict, setVerdict] = useState("1"); // Accepted
  const [severity, setSeverity] = useState("3"); // High
  const [dupeOf, setDupeOf] = useState("");
  const d = untilLabel(deadline);

  return (
    <Card className="mt-4 border-warn/40 p-5">
      <div className="flex items-center justify-between">
        <SectionTitle>Triage</SectionTitle>
        <span className={`text-xs ${d.lapsed ? "text-red-400" : "text-mist"}`}>{d.label}</span>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Field label="Verdict">
          <Select value={verdict} onChange={(e) => setVerdict(e.target.value)}>
            <option value="1">Accept &amp; pay</option>
            <option value="2">Reject (bond returned)</option>
            <option value="3">Duplicate</option>
            <option value="4">Spam (bond at risk)</option>
          </Select>
        </Field>
        {verdict === "1" && (
          <Field label="Severity">
            <Select value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="1">Low</option>
              <option value="2">Medium</option>
              <option value="3">High</option>
              <option value="4">Critical</option>
            </Select>
          </Field>
        )}
        {verdict === "3" && (
          <Field label="Duplicate of (submission #)" hint="Must be an earlier accepted report on this program.">
            <Input value={dupeOf} onChange={(e) => setDupeOf(e.target.value)} placeholder="e.g. 4" />
          </Field>
        )}
      </div>
      <Button
        className="mt-4"
        variant="primary"
        disabled={tx.busy || !bounty || (verdict === "3" && !dupeOf)}
        onClick={() =>
          tx.run({
            address: bounty!,
            abi: bountyAbi,
            functionName: "triage",
            args: [sid, Number(verdict), verdict === "1" ? Number(severity) : 0, verdict === "3" ? BigInt(dupeOf || 0) : 0n],
          })
        }
      >
        {tx.busy ? "submitting…" : "record verdict"}
      </Button>
      <p className="mt-3 text-[11px] text-mist">
        Accepting moves the award out of escrow into the hunter&apos;s claim in this same transaction — program #{String(program)}.
      </p>
    </Card>
  );
}

function RevealPanel({ sid, refresh, disclosureAt }: { sid: bigint; refresh: () => void; disclosureAt: number }) {
  const { address } = useAccount();
  const { address: bounty } = useBounty();
  const tx = useTx(refresh);
  const stored = findBySubmissionId(String(sid), address ?? undefined);
  const [reportURI, setReportURI] = useState(stored?.reportURI ?? "");
  const [salt, setSalt] = useState(stored?.salt ?? "");
  const [receipt, setReceipt] = useState("");
  const d = disclosureAt ? untilLabel(disclosureAt) : { label: "—", lapsed: true };

  return (
    <Card className="mt-4 p-5">
      <div className="flex items-center justify-between">
        <SectionTitle>Reveal your report</SectionTitle>
        <span className={`text-xs ${d.lapsed ? "text-bug" : "text-warn"}`}>
          {d.lapsed ? "embargo lifted" : `embargo: ${d.label}`}
        </span>
      </div>
      {stored ? (
        <p className="mt-2 text-xs text-bug">✓ found your saved receipt for this submission</p>
      ) : (
        <div className="mt-3">
          <Field label="Import receipt JSON" hint="Paste the receipt you downloaded at submit time to auto-fill.">
            <Textarea
              rows={3}
              value={receipt}
              onChange={(e) => {
                setReceipt(e.target.value);
                const imported = importReceipt(e.target.value);
                if (imported) {
                  setReportURI(imported.reportURI);
                  setSalt(imported.salt);
                }
              }}
              placeholder='{"salt":"0x…","reportURI":"…"}'
            />
          </Field>
        </div>
      )}
      <div className="mt-4 grid gap-3">
        <Field label="Report URI">
          <Input value={reportURI} onChange={(e) => setReportURI(e.target.value)} />
        </Field>
        <Field label="Salt">
          <Input value={salt} onChange={(e) => setSalt(e.target.value)} placeholder="0x…" />
        </Field>
      </div>
      <Button
        className="mt-4"
        variant="primary"
        disabled={tx.busy || !bounty || !reportURI.trim() || !salt}
        onClick={() =>
          tx.run({
            address: bounty!,
            abi: bountyAbi,
            functionName: "reveal",
            args: [sid, reportURI.trim(), salt as `0x${string}`],
          })
        }
      >
        {tx.busy ? "revealing…" : "reveal"}
      </Button>
    </Card>
  );
}

function ArbiterPanel({ sid, refresh }: { sid: bigint; refresh: () => void }) {
  const { address: bounty } = useBounty();
  const tx = useTx(refresh);
  const [valid, setValid] = useState("true");
  const [severity, setSeverity] = useState("3");
  const [slash, setSlash] = useState(false);
  return (
    <Card className="mt-4 border-warn/40 p-5">
      <SectionTitle>Arbiter ruling</SectionTitle>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Field label="Finding is valid?">
          <Select value={valid} onChange={(e) => setValid(e.target.value)}>
            <option value="true">Valid — pay</option>
            <option value="false">Invalid</option>
          </Select>
        </Field>
        {valid === "true" && (
          <Field label="Severity">
            <Select value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="1">Low</option>
              <option value="2">Medium</option>
              <option value="3">High</option>
              <option value="4">Critical</option>
            </Select>
          </Field>
        )}
        <Field label="Slash hunter bond?" hint="Only for bad faith.">
          <Select value={slash ? "1" : "0"} onChange={(e) => setSlash(e.target.value === "1")}>
            <option value="0">No</option>
            <option value="1">Yes — bad faith</option>
          </Select>
        </Field>
      </div>
      <Button
        className="mt-4"
        variant="primary"
        disabled={tx.busy || !bounty}
        onClick={() =>
          tx.run({
            address: bounty!,
            abi: bountyAbi,
            functionName: "resolveEscalation",
            args: [sid, valid === "true", valid === "true" ? Number(severity) : 0, slash],
          })
        }
      >
        {tx.busy ? "resolving…" : "resolve escalation"}
      </Button>
    </Card>
  );
}

function Shell({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <section className="mx-auto max-w-5xl px-6 py-12">
      <Link href="/dashboard" className="text-xs text-mist hover:text-chalk">
        ← dashboard
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Submission #{id}</h1>
      <div className="mt-6">{children}</div>
    </section>
  );
}
