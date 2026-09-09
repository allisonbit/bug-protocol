"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import { bountyAbi, type ProgramView } from "@/lib/contract";
import { useProtocolMeta, useBounty, useExplorer } from "@/lib/reads";
import { assetInfo } from "@/lib/chains";
import { fmtAmount, statusName, statusTone } from "@/lib/format";
import { Badge, Card, Empty, LinkButton } from "@/components/ui";

export default function Programs() {
  const { address: bounty, isDeployed, chainId, meta: chain } = useBounty();
  const explorer = useExplorer();
  const base = { address: bounty ?? undefined, abi: bountyAbi } as const;
  const meta = useProtocolMeta();
  const ids = useMemo(
    () => Array.from({ length: Math.max(0, Number(meta.nextProgramId ?? 1n) - 1) }, (_, i) => i + 1),
    [meta.nextProgramId],
  );

  const q = useReadContracts({
    contracts: ids.flatMap((id) => [
      { ...base, functionName: "getProgram", args: [BigInt(id)] },
      { ...base, functionName: "topTier", args: [BigInt(id)] },
      { ...base, functionName: "pendingCount", args: [BigInt(id)] },
    ]),
    query: { enabled: !!bounty && ids.length > 0, refetchInterval: 20_000 },
  });

  const rows = ids
    .map((id, i) => {
      const p = q.data?.[i * 3];
      const top = q.data?.[i * 3 + 1];
      const pending = q.data?.[i * 3 + 2];
      if (p?.status !== "success") return null;
      return {
        id,
        p: p.result as ProgramView,
        top: top?.status === "success" ? (top.result as bigint) : 0n,
        pending: pending?.status === "success" ? (pending.result as bigint) : 0n,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return (
    <section className="mx-auto max-w-6xl px-6 py-12">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Programs</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-mist">
            Every row is read live from <span className="text-chalk">{chain.label}</span>. Escrow shown
            is real money locked in the contract — a program can&apos;t go Live without it.
          </p>
        </div>
        <LinkButton href="/programs/new" variant="primary">
          + create program
        </LinkButton>
      </div>

      {!isDeployed && (
        <Card className="mt-8 p-6">
          <p className="text-sm text-warn">Protocol not deployed on {chain.label} yet.</p>
          <p className="mt-2 max-w-xl text-sm text-mist">
            No placeholder data here — an empty list is the honest answer. Switch networks in the top
            bar, or the list fills from chain the moment the contract ships here.
          </p>
        </Card>
      )}

      {isDeployed && q.isLoading && <p className="mt-8 text-sm text-mist">reading chain…</p>}

      {isDeployed && !q.isLoading && rows.length === 0 && (
        <div className="mt-8">
          <Empty>
            No programs yet. The contract is live and waiting for its first client —{" "}
            <Link href="/programs/new" className="text-bug hover:underline">
              create one
            </Link>
            .
          </Empty>
        </div>
      )}

      {rows.length > 0 && (
        <ul className="mt-8 grid gap-3 md:grid-cols-2">
          {rows.map((r) => {
            const a = assetInfo(chainId, r.p.rewardToken);
            return (
              <li key={r.id}>
                <Link href={`/programs/${r.id}`}>
                  <Card className="p-6 transition-colors hover:border-mist">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-base text-chalk">Program #{r.id}</h2>
                      <Badge tone={statusTone[statusName(r.p.status)]}>{statusName(r.p.status)}</Badge>
                    </div>
                    <dl className="mt-5 grid grid-cols-3 gap-4 text-xs">
                      <div>
                        <dt className="text-mist">escrow</dt>
                        <dd className="mt-1 text-chalk">{fmtAmount(r.p.pool, a.decimals, a.symbol)}</dd>
                      </div>
                      <div>
                        <dt className="text-mist">top severity</dt>
                        <dd className="mt-1 text-chalk">{fmtAmount(r.top, a.decimals, a.symbol)}</dd>
                      </div>
                      <div>
                        <dt className="text-mist">open reports</dt>
                        <dd className="mt-1 text-chalk">{String(r.pending)}</dd>
                      </div>
                    </dl>
                    <div className="mt-4 flex items-center justify-between border-t border-line pt-4 text-xs">
                      <span className="text-mist">
                        client{" "}
                        <a
                          className="text-bug underline underline-offset-4"
                          href={explorer.address(r.p.owner)}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {r.p.owner.slice(0, 10)}…
                        </a>
                      </span>
                      {r.p.scopeURI && <span className="truncate text-mist">scope ↗</span>}
                    </div>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
