"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useAccount } from "wagmi";
import { useReadContracts } from "wagmi";
import { bountyAbi, type ProgramView, type SubmissionView } from "@/lib/contract";
import { useProtocolMeta, useBounty } from "@/lib/reads";
import { assetInfo, NATIVE } from "@/lib/chains";
import {
  fmtAmount,
  severityName,
  severityTone,
  statusName,
  statusTone,
  subStatusName,
  subTone,
} from "@/lib/format";
import { Badge, Card, Empty, LinkButton, SectionTitle, Stat } from "@/components/ui";

export default function Dashboard() {
  const { address, isConnected } = useAccount();
  const { address: bounty, isDeployed, chainId } = useBounty();
  const base = { address: bounty ?? undefined, abi: bountyAbi } as const;
  const meta = useProtocolMeta();

  const programIds = useMemo(
    () => range(1, Number(meta.nextProgramId ?? 1n)),
    [meta.nextProgramId],
  );
  const submissionIds = useMemo(
    () => range(1, Number(meta.nextSubmissionId ?? 1n)),
    [meta.nextSubmissionId],
  );

  const programsQ = useReadContracts({
    contracts: programIds.map((id) => ({ ...base, functionName: "getProgram", args: [BigInt(id)] })),
    query: { enabled: !!bounty && programIds.length > 0 },
  });
  const subsQ = useReadContracts({
    contracts: submissionIds.map((id) => ({ ...base, functionName: "getSubmission", args: [BigInt(id)] })),
    query: { enabled: !!bounty && submissionIds.length > 0 },
  });

  // Map programId → reward token so each submission's award formats in the right
  // asset (ETH vs USDC vs custom), not a hardcoded 18-decimal guess.
  const tokenByProgram = useMemo(() => {
    const m = new Map<string, `0x${string}`>();
    (programsQ.data ?? []).forEach((r, i) => {
      if (r.status === "success") m.set(String(programIds[i]), (r.result as ProgramView).rewardToken);
    });
    return m;
  }, [programsQ.data, programIds]);

  const myPrograms = (programsQ.data ?? [])
    .map((r, i) => ({ id: programIds[i], p: r.status === "success" ? (r.result as ProgramView) : null }))
    .filter((x) => x.p && address && x.p.owner.toLowerCase() === address.toLowerCase());

  const mySubs = (subsQ.data ?? [])
    .map((r, i) => ({ id: submissionIds[i], s: r.status === "success" ? (r.result as SubmissionView) : null }))
    .filter((x) => x.s && address && x.s.hunter.toLowerCase() === address.toLowerCase());

  const loading = programsQ.isLoading || subsQ.isLoading;

  return (
    <section className="mx-auto max-w-6xl px-6 py-12">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-2 text-sm text-mist">
            Everything you own or reported, read live from chain.
          </p>
        </div>
        <div className="flex gap-2">
          <LinkButton href="/programs/new" variant="primary">
            + create program
          </LinkButton>
          <LinkButton href="/programs">browse programs</LinkButton>
        </div>
      </div>

      {!isDeployed && (
        <Card className="mt-8 p-6">
          <p className="text-sm text-warn">Protocol not deployed on this network yet.</p>
          <p className="mt-2 text-sm text-mist">
            Every tool on this page is built and wired. Switch networks in the top bar, or the moment
            the contract ships here it fills with your real programs and submissions — no code change.
          </p>
        </Card>
      )}

      {isDeployed && !isConnected && (
        <Empty>Connect a wallet to see your programs and submissions.</Empty>
      )}

      {isDeployed && isConnected && (
        <>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            <Stat label="Programs you run" value={myPrograms.length} />
            <Stat label="Your submissions" value={mySubs.length} />
            <Stat
              label="Accepted findings"
              value={mySubs.filter((x) => x.s!.status === 1 || (x.s!.status === 6 && x.s!.award > 0n)).length}
            />
          </div>

          {loading && <p className="mt-8 text-sm text-mist">reading chain…</p>}

          <div className="mt-12">
            <div className="flex items-center justify-between">
              <SectionTitle>Programs you run</SectionTitle>
              <Link href="/programs/new" className="text-xs text-bug hover:underline">
                + new
              </Link>
            </div>
            {myPrograms.length === 0 ? (
              <div className="mt-4">
                <Empty>You don&apos;t run any programs yet.</Empty>
              </div>
            ) : (
              <ul className="mt-4 grid gap-3 md:grid-cols-2">
                {myPrograms.map(({ id, p }) => {
                  const a = assetInfo(chainId, p!.rewardToken);
                  return (
                    <li key={id}>
                      <Link href={`/programs/${id}`}>
                        <Card className="p-5 transition-colors hover:border-mist">
                          <div className="flex items-center justify-between">
                            <span className="text-chalk">Program #{id}</span>
                            <Badge tone={statusTone[statusName(p!.status)]}>{statusName(p!.status)}</Badge>
                          </div>
                          <dl className="mt-4 grid grid-cols-3 gap-3 text-xs">
                            <div>
                              <dt className="text-mist">escrow</dt>
                              <dd className="mt-0.5 text-chalk">{fmtAmount(p!.pool, a.decimals, a.symbol)}</dd>
                            </div>
                            <div>
                              <dt className="text-mist">bond</dt>
                              <dd className="mt-0.5 text-chalk">{fmtAmount(p!.bond, 18, "$BUG")}</dd>
                            </div>
                            <div>
                              <dt className="text-mist">scope</dt>
                              <dd className="mt-0.5 truncate text-chalk">{p!.scopeURI || "—"}</dd>
                            </div>
                          </dl>
                        </Card>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="mt-12">
            <SectionTitle>Your submissions</SectionTitle>
            {mySubs.length === 0 ? (
              <div className="mt-4">
                <Empty>
                  No submissions yet. Find a Live program and{" "}
                  <Link href="/programs" className="text-bug hover:underline">
                    submit a finding
                  </Link>
                  .
                </Empty>
              </div>
            ) : (
              <ul className="mt-4 grid gap-px overflow-hidden rounded-lg border border-line bg-line">
                {mySubs.map(({ id, s }) => {
                  const a = assetInfo(chainId, tokenByProgram.get(String(s!.programId)) ?? (NATIVE as `0x${string}`));
                  return (
                    <li key={id} className="bg-ink-soft p-4">
                      <Link href={`/submissions/${id}`} className="flex flex-wrap items-center gap-4">
                        <span className="text-sm text-chalk">Submission #{id}</span>
                        <Badge tone={subTone[subStatusName(s!.status)]}>{subStatusName(s!.status)}</Badge>
                        {s!.severity > 0 && (
                          <span className={`text-xs ${severityTone[severityName(s!.severity)]}`}>
                            {severityName(s!.severity)}
                          </span>
                        )}
                        <span className="ml-auto text-xs text-mist">program #{String(s!.programId)}</span>
                        {s!.award > 0n && (
                          <span className="text-xs text-bug">{fmtAmount(s!.award, a.decimals, a.symbol)}</span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function range(start: number, end: number) {
  return Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i);
}
