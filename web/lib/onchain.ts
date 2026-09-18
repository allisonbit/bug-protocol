import "server-only";

import { createPublicClient, http, formatUnits, type Address, type PublicClient } from "viem";
import { chainMeta, assetInfo, NATIVE } from "./chains";
import { bountyAbi, CHAIN_SUB_STATUS, INDEX_SEVERITY, type ChainSubStatus } from "./contract";
import type { Severity, SubmissionStatus } from "./db";

/**
 * Server side chain reads.
 *
 * Every write that mirrors a chain action into the database goes through here
 * first. The reason is authorization, not convenience: a browser can claim any
 * transaction hash it likes, so if a route handler trusted the payload it would
 * let a hunter stamp `status: "accepted"` or an `onchain_submission_id` that
 * never existed onto their own row. The chain is the source of truth, so we read
 * it back and derive state from what it actually says.
 */

/** A viem client for whichever chain we're asked about, or null if unwired. */
export function publicClientFor(chainId: number): { client: PublicClient; bounty: Address } | null {
  const meta = chainMeta(chainId);
  if (!meta.bounty) return null;
  const rpc = meta.chain.rpcUrls.default.http[0];
  return {
    client: createPublicClient({ chain: meta.chain, transport: http(rpc) }) as PublicClient,
    bounty: meta.bounty,
  };
}

export type ChainSubmission = {
  id: bigint;
  programId: bigint;
  hunter: Address;
  commitHash: `0x${string}`;
  submittedAt: bigint;
  triagedAt: bigint;
  statusIndex: number;
  status: ChainSubStatus;
  severityIndex: number;
  severity: Severity;
  /** Award in the program's reward token, in base units. */
  award: bigint;
  /** Hunter's spam bond, in base units of $SWARM. */
  bond: bigint;
  dupeOf: bigint;
  reportURI: string;
  /** Last moment the owner may triage before the hunter can escalate. */
  triageDeadline: bigint;
  /** True when the escalation was raised from Pending, so escrow cover is held. */
  escalatedFromPending: boolean;
  embargoWaived: boolean;
};

/** Reads one submission plus the side-mappings the UI needs, or null if unknown. */
export async function readChainSubmission(
  chainId: number,
  submissionId: bigint,
): Promise<ChainSubmission | null> {
  const ctx = publicClientFor(chainId);
  if (!ctx) return null;
  const { client, bounty } = ctx;

  try {
    const s = (await client.readContract({
      address: bounty,
      abi: bountyAbi,
      functionName: "getSubmission",
      args: [submissionId],
    })) as {
      programId: bigint;
      hunter: Address;
      commitHash: `0x${string}`;
      submittedAt: bigint;
      triagedAt: bigint;
      status: number;
      severity: number;
      bond: bigint;
      award: bigint;
      dupeOf: bigint;
      reportURI: string;
    };

    // These three are separate calls in the contract; batching them would save
    // round-trips but the multicall address isn't guaranteed on every chain we
    // support (Robinhood Chain and a local node in particular), so we don't.
    const [triageDeadline, escalatedFromPending, embargoWaived] = await Promise.all([
      client
        .readContract({
          address: bounty,
          abi: bountyAbi,
          functionName: "triageDeadlineOf",
          args: [submissionId],
        })
        .catch(() => 0n) as Promise<bigint>,
      client
        .readContract({
          address: bounty,
          abi: bountyAbi,
          functionName: "escalatedFromPending",
          args: [submissionId],
        })
        .catch(() => false) as Promise<boolean>,
      client
        .readContract({
          address: bounty,
          abi: bountyAbi,
          functionName: "embargoWaived",
          args: [submissionId],
        })
        .catch(() => false) as Promise<boolean>,
    ]);

    const statusIndex = Number(s.status);
    return {
      id: submissionId,
      programId: s.programId,
      hunter: s.hunter,
      commitHash: s.commitHash,
      submittedAt: s.submittedAt,
      triagedAt: s.triagedAt,
      statusIndex,
      status: CHAIN_SUB_STATUS[statusIndex] ?? "pending",
      severityIndex: Number(s.severity),
      severity: (INDEX_SEVERITY[Number(s.severity)] ?? "none") as Severity,
      award: s.award,
      bond: s.bond,
      dupeOf: s.dupeOf,
      reportURI: s.reportURI,
      triageDeadline,
      escalatedFromPending,
      embargoWaived,
    };
  } catch {
    // UnknownSubmission, a bad address, or an unreachable RPC all mean the same
    // thing to a caller: we could not verify it, so we will not mirror it.
    return null;
  }
}

export type ChainProgram = {
  id: bigint;
  owner: Address;
  rewardToken: Address;
  scopeHash: `0x${string}`;
  scopeURI: string;
  status: number;
  pool: bigint;
  locked: bigint;
  bond: bigint;
  triageDeadline: bigint;
  disclosureDelay: bigint;
  pending: bigint;
  topTier: bigint;
  freePool: bigint;
  /** Reward per severity, indexed 1..4 (Low..Critical). Index 0 is unused and
   *  deliberately unpayable, matching the contract's `Severity.None`. */
  tiers: [bigint, bigint, bigint, bigint, bigint];
};

/** Reads one program with its escrow position, or null if it isn't deployed there. */
export async function readChainProgram(chainId: number, programId: bigint): Promise<ChainProgram | null> {
  const ctx = publicClientFor(chainId);
  if (!ctx) return null;
  const { client, bounty } = ctx;

  try {
    const p = (await client.readContract({
      address: bounty,
      abi: bountyAbi,
      functionName: "getProgram",
      args: [programId],
    })) as {
      owner: Address;
      rewardToken: Address;
      scopeHash: `0x${string}`;
      triageDeadline: bigint;
      disclosureDelay: bigint;
      status: number;
      pool: bigint;
      locked: bigint;
      bond: bigint;
      scopeURI: string;
    };

    const [pending, topTier, freePool] = await Promise.all([
      client
        .readContract({
          address: bounty,
          abi: bountyAbi,
          functionName: "pendingCount",
          args: [programId],
        })
        .catch(() => 0n) as Promise<bigint>,
      client
        .readContract({
          address: bounty,
          abi: bountyAbi,
          functionName: "topTier",
          args: [programId],
        })
        .catch(() => 0n) as Promise<bigint>,
      client
        .readContract({
          address: bounty,
          abi: bountyAbi,
          functionName: "freePool",
          args: [programId],
        })
        .catch(() => 0n) as Promise<bigint>,
    ]);

    const payout = await Promise.all(
      [1, 2, 3, 4].map((i) =>
        client
          .readContract({
            address: bounty,
            abi: bountyAbi,
            functionName: "payoutOf",
            args: [programId, i],
          })
          .catch(() => 0n) as Promise<bigint>,
      ),
    );

    return {
      id: programId,
      owner: p.owner,
      rewardToken: p.rewardToken,
      scopeHash: p.scopeHash,
      scopeURI: p.scopeURI,
      status: Number(p.status),
      pool: p.pool,
      locked: p.locked,
      bond: p.bond,
      triageDeadline: p.triageDeadline,
      disclosureDelay: p.disclosureDelay,
      pending,
      topTier,
      freePool,
      tiers: [0n, payout[0], payout[1], payout[2], payout[3]],
    };
  } catch {
    return null;
  }
}

/** The highest submission id that exists on this deployment (ids start at 1). */
export async function readNextSubmissionId(chainId: number): Promise<bigint | null> {
  const ctx = publicClientFor(chainId);
  if (!ctx) return null;
  try {
    return (await ctx.client.readContract({
      address: ctx.bounty,
      abi: bountyAbi,
      functionName: "nextSubmissionId",
    })) as bigint;
  } catch {
    return null;
  }
}

/**
 * Converts a chain award (base units of the program's reward token) into the
 * human number the offchain rows, tiers and reputation trigger all speak. Getting
 * this wrong by a factor of 10^12 is the difference between a $5,000 payout and a
 * $5,000,000,000 one, so it is done in exactly one place.
 */
export function toHumanAmount(chainId: number, token: Address, amount: bigint): number {
  if (amount === 0n) return 0;
  const { decimals } = assetInfo(chainId, token);
  return Number(formatUnits(amount, decimals));
}

/**
 * Bonds are always denominated in $SWARM, which is fixed at 18 decimals, so they
 * don't need the asset registry consulted. Kept separate from `toHumanAmount` so
 * a program that forgot to record its `reward_token` can never mis-scale a bond.
 */
export const toBugAmount = (amount: bigint): number => Number(formatUnits(amount, 18));

/** Maps a chain verdict onto the row status, without ever downgrading `disclosed`. */
export function chainStatusToRowStatus(
  chain: ChainSubStatus,
  current: SubmissionStatus | undefined,
): SubmissionStatus {
  // Disclosure is an offchain, coordinated step (publish once the fix ships). It
  // sits on top of an accepted verdict, so a chain read must never undo it.
  if (current === "disclosed" && chain === "accepted") return "disclosed";
  return chain;
}

export { NATIVE };
