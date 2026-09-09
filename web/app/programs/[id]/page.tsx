"use client";

import Link from "next/link";
import { use, useMemo, useState } from "react";
import { useAccount, useReadContracts } from "wagmi";
import { bountyAbi, type SubmissionView } from "@/lib/contract";
import { useProgram, useProtocolMeta, useBounty, useExplorer } from "@/lib/reads";
import { assetInfo } from "@/lib/chains";
import {
  fmtAmount,
  fmtDate,
  humanDuration,
  severityName,
  severityTone,
  statusName,
  statusTone,
  subStatusName,
  subTone,
} from "@/lib/format";
import { Badge, Card, Copyable, Empty, LinkButton, SectionTitle, Stat } from "@/components/ui";
import { OwnerPanel } from "./owner-panel";
import { severityTiersLabel } from "./util";

export default function ProgramDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const pid = BigInt(id);
  const { address } = useAccount();
  const { address: bounty, isDeployed, chainId } = useBounty();
  const explorer = useExplorer();
  const [key, setKey] = useState(0);
  const refresh = () => setKey((k) => k + 1);

  const base = { address: bounty ?? undefined, abi: bountyAbi } as const;
  const meta = useProtocolMeta();
  const { program, topTier, freePool, pending, tiers } = useProgram(pid, key);

  // Load submissions belonging to this program by scanning the global range.
  const subIds = useMemo(
    () => Array.from({ length: Math.max(0, Number(meta.nextSubmissionId ?? 1n) - 1) }, (_, i) => i + 1),
    [meta.nextSubmissionId],
  );
  const subsQ = useReadContracts({
    contracts: subIds.map((sid) => ({ ...base, functionName: "getSubmission", args: [BigInt(sid)] })),
    query: { enabled: !!bounty && subIds.length > 0, refetchInterval: 20_000 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scopeKey: `psubs-${id}-${key}` as any,
  });
  const submissions = subIds
    .map((sid, i) => ({
      id: sid,
      s: subsQ.data?.[i]?.status === "success" ? (subsQ.data[i].result as SubmissionView) : null,
    }))
    .filter((x) => x.s && String(x.s.programId) === id);

  const isOwner = !!address && !!program && program.owner.toLowerCase() === address.toLowerCase();

  if (!isDeployed) {
    return (
      <Shell id={id}>
        <Card className="p-6">
          <p className="text-sm text-warn">Protocol not deployed on this network yet.</p>
          <p className="mt-2 text-sm text-mist">
            This page shows the full client control panel and hunter actions against the live ABI.
            Switch networks in the top bar, or it activates when the contract ships here.
          </p>
        </Card>
      </Shell>
    );
  }

  if (!program) {
    return (
      <Shell id={id}>
        <p className="text-sm text-mist">reading program #{id} from chain…</p>
      </Shell>
    );
  }

  const status = statusName(program.status);
  const asset = assetInfo(chainId, program.rewardToken);

  return (
    <Shell id={id}>
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={statusTone[status]}>{status}</Badge>
        <Badge tone="text-mist border-line">{asset.symbol} rewards</Badge>
        {isOwner && <Badge tone="text-bug border-bug-dim">you own this</Badge>}
        <span className="ml-auto text-xs text-mist">
          client{" "}
          <a className="text-bug underline underline-offset-4" href={explorer.address(program.owner)}>
            {program.owner.slice(0, 12)}…
          </a>
        </span>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Escrow pool" value={fmtAmount(program.pool, asset.decimals, asset.symbol)} />
        <Stat label="Free (withdrawable)" value={fmtAmount(freePool ?? 0n, asset.decimals, asset.symbol)} />
        <Stat label="Client bond" value={fmtAmount(program.bond, 18, "$BUG")} />
        <Stat label="Open reports" value={String(pending ?? 0n)} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <SectionTitle>Payout tiers</SectionTitle>
          <ul className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {(["Low", "Medium", "High", "Critical"] as const).map((s, i) => (
              <li key={s} className="rounded border border-line bg-ink p-3">
                <div className={`text-xs ${severityTone[s]}`}>{s}</div>
                <div className="mt-1 text-chalk">{fmtAmount(tiers[i + 1], asset.decimals)} {asset.symbol}</div>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-mist">
            top tier <span className="text-chalk">{fmtAmount(topTier ?? 0n, asset.decimals)} {asset.symbol}</span> ·
            triage window <span className="text-chalk">{humanDuration(program.triageDeadline)}</span> ·
            disclosure embargo <span className="text-chalk">{humanDuration(program.disclosureDelay)}</span>
          </p>
          <p className="mt-3 text-[11px] break-all text-mist">
            scopeHash <Copyable value={program.scopeHash} />
          </p>
          {program.scopeURI && (
            <a
              className="mt-2 inline-block text-xs text-bug underline underline-offset-4"
              href={program.scopeURI}
              target="_blank"
              rel="noreferrer"
            >
              scope document ↗
            </a>
          )}
        </Card>

        <Card className="flex flex-col justify-between p-5">
          <div>
            <SectionTitle>Hunt this program</SectionTitle>
            <p className="mt-3 text-xs leading-relaxed text-mist">
              {status === "Live"
                ? "Commit to a finding without revealing it. Your report stays encrypted and off-chain until after the fix ships."
                : `Submissions open only while Live. This program is ${status}.`}
            </p>
          </div>
          <LinkButton href={`/programs/${id}/submit`} variant={status === "Live" ? "primary" : "ghost"}>
            submit a finding →
          </LinkButton>
        </Card>
      </div>

      {isOwner && (
        <div className="mt-4">
          <OwnerPanel
            programId={pid}
            program={program}
            topTier={topTier ?? 0n}
            freePool={freePool ?? 0n}
            pending={pending ?? 0n}
            tiers={tiers}
            minProgramBond={meta.minProgramBond ?? 0n}
            bugToken={meta.bugToken}
            onDone={refresh}
          />
        </div>
      )}

      <div className="mt-10">
        <div className="flex items-center justify-between">
          <SectionTitle>Submissions ({submissions.length})</SectionTitle>
          <span className="text-xs text-mist">{severityTiersLabel(tiers)}</span>
        </div>
        {submissions.length === 0 ? (
          <div className="mt-4">
            <Empty>No submissions yet.</Empty>
          </div>
        ) : (
          <ul className="mt-4 grid gap-px overflow-hidden rounded-lg border border-line bg-line">
            {submissions.map(({ id: sid, s }) => (
              <li key={sid} className="bg-ink-soft p-4">
                <Link href={`/submissions/${sid}`} className="flex flex-wrap items-center gap-3">
                  <span className="text-sm text-chalk">#{sid}</span>
                  <Badge tone={subTone[subStatusName(s!.status)]}>{subStatusName(s!.status)}</Badge>
                  {s!.severity > 0 && (
                    <span className={`text-xs ${severityTone[severityName(s!.severity)]}`}>
                      {severityName(s!.severity)}
                    </span>
                  )}
                  <span className="text-xs text-mist">
                    hunter {s!.hunter.slice(0, 8)}… · {fmtDate(s!.submittedAt)}
                  </span>
                  {s!.award > 0n && (
                    <span className="ml-auto text-xs text-bug">{fmtAmount(s!.award, asset.decimals, asset.symbol)}</span>
                  )}
                  {isOwner && s!.status === 0 && (
                    <span className="ml-auto rounded border border-warn/50 px-2 py-0.5 text-[11px] text-warn">
                      needs triage
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Shell>
  );
}

function Shell({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <section className="mx-auto max-w-6xl px-6 py-12">
      <Link href="/programs" className="text-xs text-mist hover:text-chalk">
        ← all programs
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Program #{id}</h1>
      <div className="mt-6">{children}</div>
    </section>
  );
}
