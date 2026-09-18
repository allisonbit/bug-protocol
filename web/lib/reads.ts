"use client";

import { useReadContract, useReadContracts, useAccount, useChainId } from "wagmi";
import {
  bountyAbi,
  PROTOCOL_FALLBACK,
  type ProgramView,
  type SubmissionView,
} from "./contract";
import { chainMeta, txUrlOn, addressUrlOn, NATIVE } from "./chains";

/**
 * The BugBounty deployment for the chain the wallet is connected to. Falls back
 * to the default chain's registry entry so reads still resolve before connect.
 * `address` is null on chains where we haven't deployed yet; callers gate on
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

/**
 * Everything the connected account is owed, for the wallet drawer.
 *
 * `extraTokens` lets a submission page pull in the *program's* reward token: a
 * program can escrow ETH, USDC or $SWARM, and the drawer alone only ever knew
 * about the first two. Without this a hunter paid in a USDC-denominated program
 * saw the award as claimable but had no button that loaded it.
 */
export function useMyBalances(refetchKey = 0, extraTokens: `0x${string}`[] = []) {
  const { address } = useAccount();
  const { address: bounty, meta } = useBounty();
  const base = { address: bounty ?? undefined, abi: bountyAbi } as const;
  const usdc = meta.usdc;

  // Native first, then USDC (when known), then any program reward token that
  // isn't already covered; de-duped case-insensitively by address.
  const seen = new Set<string>([NATIVE.toLowerCase()]);
  const tokens: `0x${string}`[] = [NATIVE];
  for (const t of [usdc, ...extraTokens]) {
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push(t);
  }

  const q = useReadContracts({
    contracts: address
      ? [
          { ...base, functionName: "bondCredit", args: [address] },
          ...tokens.map((token) => ({ ...base, functionName: "claimable" as const, args: [address, token] })),
        ]
      : [],
    query: { enabled: !!bounty && !!address, refetchInterval: 15_000 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scopeKey: `bal-${address}-${refetchKey}-${tokens.join(",")}` as any,
  });
  const ok = <T,>(i: number) => (q.data?.[i]?.status === "success" ? (q.data[i].result as T) : undefined);

  /** Per-token claimable amounts, in the same order as `tokens`. */
  const claimable = tokens.map((token, i) => ({
    token,
    amount: ok<bigint>(i + 1) ?? 0n,
  }));

  return {
    bondCredit: ok<bigint>(0),
    claimable,
    tokens,
    // Convenience accessors kept for the drawer's existing layout.
    claimableNative: claimable.find((c) => c.token === NATIVE)?.amount,
    claimableUsdc: usdc ? claimable.find((c) => c.token.toLowerCase() === usdc.toLowerCase())?.amount : undefined,
    usdc,
    bugToken: meta.bugToken,
    refetch: q.refetch,
  };
}

/**
 * The protocol's own bounds (clamped windows + the dispute period), read once.
 * Forms use these instead of hardcoding, and fall back to the contract's declared
 * constants so a not-yet-resolved read can never suggest an invalid value.
 */
export function useProtocolBounds() {
  const { address: bounty } = useBounty();
  const base = { address: bounty ?? undefined, abi: bountyAbi } as const;
  const q = useReadContracts({
    contracts: [
      { ...base, functionName: "MIN_TRIAGE_DEADLINE" },
      { ...base, functionName: "MAX_TRIAGE_DEADLINE" },
      { ...base, functionName: "MAX_DISCLOSURE_DELAY" },
      { ...base, functionName: "DISPUTE_WINDOW" },
    ],
    query: { enabled: !!bounty },
  });
  const ok = <T,>(i: number) => (q.data?.[i]?.status === "success" ? (q.data[i].result as T) : undefined);
  return {
    minTriageDeadline: ok<bigint>(0) ?? PROTOCOL_FALLBACK.minTriageDeadline,
    maxTriageDeadline: ok<bigint>(1) ?? PROTOCOL_FALLBACK.maxTriageDeadline,
    maxDisclosureDelay: ok<bigint>(2) ?? PROTOCOL_FALLBACK.maxDisclosureDelay,
    disputeWindow: ok<bigint>(3) ?? PROTOCOL_FALLBACK.disputeWindow,
  };
}

/**
 * One read bundle for the whole hunter side of a submission: the submission
 * itself, when its triage SLA lapses, whether the embargo is waived, and whether
 * an escalation still holds escrow cover. Splitting these into four hooks would
 * have meant four independent 15s polls on a page that needs them together.
 */
export function useSubmissionChain(id: bigint | undefined, refetchKey = 0) {
  const { address: bounty } = useBounty();
  const base = { address: bounty ?? undefined, abi: bountyAbi } as const;
  const q = useReadContracts({
    contracts: id
      ? [
          { ...base, functionName: "getSubmission", args: [id] },
          { ...base, functionName: "triageDeadlineOf", args: [id] },
          { ...base, functionName: "embargoWaived", args: [id] },
          { ...base, functionName: "escalatedFromPending", args: [id] },
        ]
      : [],
    query: { enabled: !!bounty && !!id, refetchInterval: 15_000 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scopeKey: `sub-chain-${id}-${refetchKey}` as any,
  });
  const ok = <T,>(i: number) => (q.data?.[i]?.status === "success" ? (q.data[i].result as T) : undefined);
  return {
    ...q,
    submission: ok<SubmissionView>(0),
    triageDeadline: ok<bigint>(1),
    embargoWaived: ok<boolean>(2) ?? false,
    escalatedFromPending: ok<boolean>(3) ?? false,
    refetch: q.refetch,
  };
}
