import { maxUint256, type Address, type Hex } from "viem";
import { bountyAbi, erc20Abi, type ProgramView, type SubmissionView } from "./abi.js";
import { NATIVE } from "./chains.js";
import { commitmentFor } from "./commit.js";
import { requireBounty, requireSigner, type Ctx } from "./config.js";

// ---- low-level helpers -------------------------------------------------------
// functionName/args are cast to `never` to sidestep viem's strict per-call
// literal inference; the ABI is const so runtime shape is still guaranteed.

async function read<T>(ctx: Ctx, functionName: string, args: readonly unknown[] = []): Promise<T> {
  return (await ctx.publicClient.readContract({
    address: requireBounty(ctx),
    abi: bountyAbi,
    functionName: functionName as never,
    args: args as never,
  })) as T;
}

async function write(ctx: Ctx, functionName: string, args: readonly unknown[], value?: bigint): Promise<Hex> {
  const { account, walletClient } = requireSigner(ctx);
  const hash = await walletClient.writeContract({
    address: requireBounty(ctx),
    abi: bountyAbi,
    functionName: functionName as never,
    args: args as never,
    account,
    chain: ctx.meta.chain,
    value,
  });
  await ctx.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

async function ensureAllowance(ctx: Ctx, token: Address, owner: Address, spender: Address, amount: bigint): Promise<void> {
  const current = (await ctx.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  })) as bigint;
  if (current >= amount) return;
  const { account, walletClient } = requireSigner(ctx);
  const hash = await walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, maxUint256],
    account,
    chain: ctx.meta.chain,
  });
  await ctx.publicClient.waitForTransactionReceipt({ hash });
}

// ---- reads -------------------------------------------------------------------

export type ProtocolMeta = {
  nextProgramId: bigint;
  nextSubmissionId: bigint;
  bugToken: Address;
  arbiter: Address;
  submissionBond: bigint;
  minProgramBond: bigint;
  protocolFeeBps: bigint;
};

export async function protocolMeta(ctx: Ctx): Promise<ProtocolMeta> {
  const [nextProgramId, nextSubmissionId, bugToken, arbiter, submissionBond, minProgramBond, protocolFeeBps] =
    await Promise.all([
      read<bigint>(ctx, "nextProgramId"),
      read<bigint>(ctx, "nextSubmissionId"),
      read<Address>(ctx, "bugToken"),
      read<Address>(ctx, "arbiter"),
      read<bigint>(ctx, "submissionBond"),
      read<bigint>(ctx, "minProgramBond"),
      read<bigint>(ctx, "protocolFeeBps"),
    ]);
  return { nextProgramId, nextSubmissionId, bugToken, arbiter, submissionBond, minProgramBond, protocolFeeBps };
}

export async function getProgram(ctx: Ctx, id: bigint): Promise<ProgramView> {
  return read<ProgramView>(ctx, "getProgram", [id]);
}

export type ProgramFull = {
  id: bigint;
  program: ProgramView;
  topTier: bigint;
  freePool: bigint;
  pending: bigint;
  tiers: readonly [bigint, bigint, bigint, bigint, bigint];
};

export async function getProgramFull(ctx: Ctx, id: bigint): Promise<ProgramFull> {
  const [program, topTier, freePool, pending, low, med, high, crit] = await Promise.all([
    read<ProgramView>(ctx, "getProgram", [id]),
    read<bigint>(ctx, "topTier", [id]),
    read<bigint>(ctx, "freePool", [id]),
    read<bigint>(ctx, "pendingCount", [id]),
    read<bigint>(ctx, "payoutOf", [id, 1]),
    read<bigint>(ctx, "payoutOf", [id, 2]),
    read<bigint>(ctx, "payoutOf", [id, 3]),
    read<bigint>(ctx, "payoutOf", [id, 4]),
  ]);
  return { id, program, topTier, freePool, pending, tiers: [0n, low, med, high, crit] };
}

export async function listPrograms(ctx: Ctx): Promise<ProgramFull[]> {
  const n = await read<bigint>(ctx, "nextProgramId");
  const ids = Array.from({ length: Number(n) }, (_, i) => BigInt(i));
  return Promise.all(ids.map((id) => getProgramFull(ctx, id)));
}

export async function getSubmission(ctx: Ctx, id: bigint): Promise<SubmissionView> {
  return read<SubmissionView>(ctx, "getSubmission", [id]);
}

export async function getClaims(ctx: Ctx, account: Address): Promise<{ claimableNative: bigint; bondCredit: bigint }> {
  const [claimableNative, bondCredit] = await Promise.all([
    read<bigint>(ctx, "claimable", [account, NATIVE]),
    read<bigint>(ctx, "bondCredit", [account]),
  ]);
  return { claimableNative, bondCredit };
}

// ---- writes ------------------------------------------------------------------

export async function submitFinding(
  ctx: Ctx,
  programId: bigint,
  reportURI: string,
  salt: `0x${string}`,
): Promise<{ submissionId: bigint; commit: `0x${string}`; hash: Hex }> {
  const { account } = requireSigner(ctx);
  const bounty = requireBounty(ctx);
  const commit = commitmentFor(reportURI, salt, account.address);

  const [bond, bugToken] = await Promise.all([
    read<bigint>(ctx, "submissionBond"),
    read<Address>(ctx, "bugToken"),
  ]);
  if (bond > 0n && bugToken.toLowerCase() !== NATIVE) {
    await ensureAllowance(ctx, bugToken, account.address, bounty, bond);
  }

  // The id assigned by submit() is the current nextSubmissionId.
  const submissionId = await read<bigint>(ctx, "nextSubmissionId");
  const hash = await write(ctx, "submit", [programId, commit]);
  return { submissionId, commit, hash };
}

export async function revealFinding(ctx: Ctx, submissionId: bigint, reportURI: string, salt: `0x${string}`): Promise<Hex> {
  return write(ctx, "reveal", [submissionId, reportURI, salt]);
}

export async function triageSubmission(
  ctx: Ctx,
  submissionId: bigint,
  verdict: number,
  severity: number,
  dupeOf: bigint,
): Promise<Hex> {
  return write(ctx, "triage", [submissionId, verdict, severity, dupeOf]);
}

export async function claimRewards(ctx: Ctx, token: Address, to: Address): Promise<Hex> {
  return write(ctx, "claim", [token, to]);
}

export async function withdrawBond(ctx: Ctx, to: Address): Promise<Hex> {
  return write(ctx, "withdrawBond", [to]);
}
