"use client";

import { useReadContract, useReadContracts, useAccount, useChainId } from "wagmi";
import { bountyAbi, type ProgramView, type SubmissionView } from "./contract";
import { chainMeta, txUrlOn, addressUrlOn, NATIVE } from "./chains";

/**
 * The BugBounty deployment for the chain the wallet is connected to. Falls back
 * to the default chain's registry entry so reads still resolve before connect.
 * `address` is null on chains where we haven't deployed yet — callers gate on
 * `isDeployed`.
 */
export function useBounty() {
  const chainId = useChainId();
  const meta = chainMeta(chainId);
  return { chainId, meta, address: meta.bounty, isDeployed: meta.bounty !== null };
}

/** Explorer links that follow the connected chain. */
export function useExplorer() {
  const chainId = useChainId();
  return {
    tx: (hash: string) => txUrlOn(chainId, hash),
    address: (a: string) => addressUrlOn(chainId, a),
  };
}

export function useProtocolMeta() {
  const { address: bounty } = useBounty();
  const base = { address: bounty ?? undefined, abi: bountyAbi } as const;
  const { data } = useReadContracts({
    contracts: [
      { ...base, functionName: "nextProgramId" },
      { ...base, functionName: "nextSubmissionId" },
      { ...base, functionName: "submissionBond" },
      { ...base, functionName: "minProgramBond" },
      { ...base, functionName: "protocolFeeBps" },
      { ...base, functionName: "bugToken" },
      { ...base, functionName: "arbiter" },
    ],
    query: { enabled: !!bounty },
  });
  const val = <T,>(i: number) => (data?.[i]?.status === "success" ? (data[i].result as T) : undefined);
  return {
    nextProgramId: val<bigint>(0),
    nextSubmissionId: val<bigint>(1),
    submissionBond: val<bigint>(2),
    minProgramBond: val<bigint>(3),
    protocolFeeBps: val<bigint>(4),
    bugToken: val<`0x${string}`>(5),
    arbiter: val<`0x${string}`>(6),
  };
}

export function useProgram(id: bigint | undefined, refetchKey = 0) {
  const { address: bounty } = useBounty();
  const base = { address: bounty ?? undefined, abi: bountyAbi } as const;
  const q = useReadContracts({
    contracts: id
      ? [
          { ...base, functionName: "getProgram", args: [id] },
          { ...base, functionName: "topTier", args: [id] },
          { ...base, functionName: "freePool", args: [id] },
          { ...base, functionName: "pendingCount", args: [id] },
          { ...base, functionName: "payoutOf", args: [id, 1] },
          { ...base, functionName: "payoutOf", args: [id, 2] },
          { ...base, functionName: "payoutOf", args: [id, 3] },
          { ...base, functionName: "payoutOf", args: [id, 4] },
        ]
      : [],
    query: { enabled: !!bounty && !!id, refetchInterval: 15_000 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scopeKey: `program-${id}-${refetchKey}` as any,
  });
  const d = q.data;
  const ok = <T,>(i: number) => (d?.[i]?.status === "success" ? (d[i].result as T) : undefined);
  const program = ok<ProgramView>(0);
  return {
    ...q,
    program,
    topTier: ok<bigint>(1),
    freePool: ok<bigint>(2),
    pending: ok<bigint>(3),
    tiers: [0n, ok<bigint>(4) ?? 0n, ok<bigint>(5) ?? 0n, ok<bigint>(6) ?? 0n, ok<bigint>(7) ?? 0n] as const,
  };
}

export function useSubmission(id: bigint | undefined, refetchKey = 0) {
  const { address: bounty } = useBounty();
  const q = useReadContract({
    address: bounty ?? undefined,
    abi: bountyAbi,
    functionName: "getSubmission",
    args: id ? [id] : undefined,
    query: { enabled: !!bounty && !!id, refetchInterval: 15_000 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scopeKey: `sub-${id}-${refetchKey}` as any,
  });
  return { ...q, submission: q.data as SubmissionView | undefined };
}

/** Everything the connected account is owed, for the wallet drawer. */
export function useMyBalances(refetchKey = 0) {
  const { address } = useAccount();
  const { address: bounty, meta } = useBounty();
  const base = { address: bounty ?? undefined, abi: bountyAbi } as const;
  const usdc = meta.usdc;
  const q = useReadContracts({
    contracts: address
      ? [
          { ...base, functionName: "bondCredit", args: [address] },
          { ...base, functionName: "claimable", args: [address, NATIVE] },
          ...(usdc ? [{ ...base, functionName: "claimable", args: [address, usdc] }] : []),
        ]
      : [],
    query: { enabled: !!bounty && !!address, refetchInterval: 15_000 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scopeKey: `bal-${address}-${refetchKey}` as any,
  });
  const ok = <T,>(i: number) => (q.data?.[i]?.status === "success" ? (q.data[i].result as T) : undefined);
  return {
    bondCredit: ok<bigint>(0),
    claimableNative: ok<bigint>(1),
    claimableUsdc: usdc ? ok<bigint>(2) : undefined,
    usdc,
    bugToken: meta.bugToken,
    refetch: q.refetch,
  };
}
