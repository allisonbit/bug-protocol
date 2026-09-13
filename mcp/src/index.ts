#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, type ZodRawShape } from "zod";
import { isAddress, maxUint256, type Address, type Hash } from "viem";
import { bountyAbi, erc20Abi } from "./abi.js";
import {
  account,
  addressUrl,
  bountyAddress,
  meta,
  publicClient,
  receipt,
  usdcAddress,
  walletClient,
} from "./client.js";
import { NATIVE } from "./chains.js";
import { commitmentFor, decryptReport, encryptReport, randomSalt } from "./crypto.js";
import { severityName, statusName, subStatusName, toJson, Verdict, type VerdictName } from "./format.js";

/* -------------------------------------------------------------------------- */
/* Low-level contract helpers                                                  */
/* -------------------------------------------------------------------------- */

// functionName is a runtime string here, so we bypass viem's literal-union
// inference with a narrow cast. The abi itself stays fully typed.
async function read<T = unknown>(functionName: string, args: readonly unknown[] = []): Promise<T> {
  return publicClient().readContract({
    address: bountyAddress(),
    abi: bountyAbi,
    functionName: functionName as never,
    args: args as never,
  }) as Promise<T>;
}

async function write(functionName: string, args: readonly unknown[], value?: bigint): Promise<Hash> {
  const wc = walletClient();
  return wc.writeContract({
    address: bountyAddress(),
    abi: bountyAbi,
    functionName: functionName as never,
    args: args as never,
    value,
    account: wc.account!,
    chain: meta().chain,
  } as never);
}

type ProgramTuple = {
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

type SubmissionTuple = {
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

const bigintFrom = (label: string, v: string): bigint => {
  try {
    const n = BigInt(v);
    if (n < 0n) throw new Error("negative");
    return n;
  } catch {
    throw new Error(`${label} must be a non-negative integer, got "${v}"`);
  }
};

const requireAddress = (label: string, v: string): Address => {
  if (!isAddress(v)) throw new Error(`${label} is not a valid address: ${v}`);
  return v;
};

/* -------------------------------------------------------------------------- */
/* Tool registration helper                                                    */
/* -------------------------------------------------------------------------- */

const server = new McpServer({ name: "bug-protocol", version: "0.1.0" });

function tool<S extends ZodRawShape>(
  name: string,
  description: string,
  inputSchema: S,
  handler: (args: { [K in keyof S]: z.infer<S[K]> }) => Promise<unknown>,
) {
  const cb = async (args: unknown) => {
    try {
      const out = await handler(args as { [K in keyof S]: z.infer<S[K]> });
      const text = typeof out === "string" ? out : toJson(out);
      return { content: [{ type: "text" as const, text }] };
    } catch (e) {
      const text = `Error: ${e instanceof Error ? e.message : String(e)}`;
      return { content: [{ type: "text" as const, text }], isError: true };
    }
  };
  // The SDK's registerTool overloads don't unify with this generic wrapper, so
  // we cast at this single boundary. Runtime behaviour is unchanged: the server
  // still validates args against `inputSchema` before invoking `cb`.
  (server.registerTool as (n: string, c: unknown, h: unknown) => void)(name, { description, inputSchema }, cb);
}

/* -------------------------------------------------------------------------- */
/* Read-only tools (need only an RPC)                                          */
/* -------------------------------------------------------------------------- */

tool(
  "protocol_info",
  "Read protocol-wide configuration: the $BUG token, arbiter, fee recipient, protocol fee, required bonds, and active chain metadata. Works read-only.",
  {},
  async () => {
    const m = meta();
    const [nextProgramId, nextSubmissionId, bugToken, arbiter, feeRecipient, protocolFeeBps, submissionBond, minProgramBond] =
      await Promise.all([
        read<bigint>("nextProgramId"),
        read<bigint>("nextSubmissionId"),
        read<Address>("bugToken"),
        read<Address>("arbiter"),
        read<Address>("feeRecipient"),
        read<bigint>("protocolFeeBps"),
        read<bigint>("submissionBond"),
        read<bigint>("minProgramBond"),
      ]);
    return {
      chain: { id: m.chain.id, label: m.label, explorer: m.explorer, usdc: usdcAddress() },
      contract: bountyAddress(),
      nextProgramId,
      nextSubmissionId,
      programCount: nextProgramId > 0n ? nextProgramId - 1n : 0n,
      bugToken,
      bugTokenIsSet: bugToken !== NATIVE,
      arbiter,
      feeRecipient,
      protocolFeeBps,
      submissionBond,
      minProgramBond,
    };
  },
);

tool(
  "list_programs",
  "List bounty programs with status, owner, escrow pool, top payout tier, and scope link. Use get_program for full detail on one.",
  {
    includeClosed: z.boolean().optional().describe("Include Closed/Draft programs (default true)."),
  },
  async ({ includeClosed = true }) => {
    const next = await read<bigint>("nextProgramId");
    const last = next > 0n ? Number(next) - 1 : 0;
    const cap = Math.min(last, 500);
    const ids = Array.from({ length: cap }, (_, i) => BigInt(i + 1));
    const rows = await Promise.all(
      ids.map(async (id) => {
        const [p, top] = await Promise.all([
          read<ProgramTuple>("getProgram", [id]),
          read<bigint>("topTier", [id]),
        ]);
        return {
          id,
          status: statusName(p.status),
          statusCode: p.status,
          owner: p.owner,
          rewardToken: p.rewardToken,
          pool: p.pool,
          topTier: top,
          scopeURI: p.scopeURI,
        };
      }),
    );
    const filtered = includeClosed ? rows : rows.filter((r) => r.statusCode === 1 || r.statusCode === 2);
    return { count: filtered.length, programs: filtered };
  },
);

tool(
  "get_program",
  "Full detail for one program: owner, reward token, scope hash/URI, status, escrow pool, locked/free funds, client bond, and the payout tier for each severity.",
  { programId: z.string().describe("Program id, e.g. \"1\".") },
  async ({ programId }) => {
    const id = bigintFrom("programId", programId);
    const [p, top, free, pending, low, med, high, crit] = await Promise.all([
      read<ProgramTuple>("getProgram", [id]),
      read<bigint>("topTier", [id]),
      read<bigint>("freePool", [id]),
      read<bigint>("pendingCount", [id]),
      read<bigint>("payoutOf", [id, 1]),
      read<bigint>("payoutOf", [id, 2]),
      read<bigint>("payoutOf", [id, 3]),
      read<bigint>("payoutOf", [id, 4]),
    ]);
    return {
      id,
      owner: p.owner,
      rewardToken: p.rewardToken,
      rewardIsNative: p.rewardToken === NATIVE,
      scopeHash: p.scopeHash,
      scopeURI: p.scopeURI,
      status: statusName(p.status),
      statusCode: p.status,
      triageDeadlineSeconds: p.triageDeadline,
      disclosureDelaySeconds: p.disclosureDelay,
      pool: p.pool,
      locked: p.locked,
      freePool: free,
      clientBond: p.bond,
      pendingSubmissions: pending,
      topTier: top,
      tiers: { Low: low, Medium: med, High: high, Critical: crit },
    };
  },
);

tool(
  "get_submission",
  "Full detail for one submission: program, hunter, commit hash, status, severity, bond, award, revealed report URI, triage deadline, and embargo state.",
  { submissionId: z.string().describe("Submission id, e.g. \"1\".") },
  async ({ submissionId }) => {
    const id = bigintFrom("submissionId", submissionId);
    const [s, triageDeadline, embargoWaived] = await Promise.all([
      read<SubmissionTuple>("getSubmission", [id]),
      read<bigint>("triageDeadlineOf", [id]),
      read<boolean>("embargoWaived", [id]),
    ]);
    return {
      id,
      programId: s.programId,
      hunter: s.hunter,
      commitHash: s.commitHash,
      status: subStatusName(s.status),
      statusCode: s.status,
      severity: severityName(s.severity),
      severityCode: s.severity,
      bond: s.bond,
      award: s.award,
      dupeOf: s.dupeOf,
      reportURI: s.reportURI || null,
      revealed: Boolean(s.reportURI),
      submittedAt: s.submittedAt,
      triagedAt: s.triagedAt,
      triageDeadline,
      embargoWaived,
    };
  },
);

tool(
  "compute_commit",
  "Compute a commit hash from a report URI + hunter address (+ optional salt). Pure/off-chain. If no salt is given, a random 32-byte salt is generated. SAVE IT, it is required to reveal later and cannot be recovered.",
  {
    reportURI: z.string().describe("Public URI where the (ideally encrypted) report will live."),
    hunter: z.string().describe("The hunter's address; bound into the commit so it can't be front-run."),
    salt: z.string().optional().describe("Optional 0x 32-byte salt. Omit to generate one."),
  },
  async ({ reportURI, hunter, salt }) => {
    const h = requireAddress("hunter", hunter);
    const s = (salt ?? randomSalt()) as `0x${string}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(s)) throw new Error("salt must be a 0x-prefixed 32-byte hex string");
    return {
      reportURI,
      hunter: h,
      salt: s,
      commitHash: commitmentFor(reportURI, s, h),
      note: "Store salt + reportURI privately. You need both (plus this hunter address) to reveal.",
    };
  },
);

tool(
  "encrypt_report",
  "Encrypt a report body in an AES-GCM/PBKDF2 envelope (compatible with the web app). Publish the returned JSON at your reportURI; share the passphrase with the client out-of-band.",
  {
    report: z.string().describe("The full finding: steps to reproduce, impact, PoC."),
    passphrase: z.string().describe("Shared secret; give it to the client over a side channel."),
  },
  async ({ report, passphrase }) => encryptReport(report, passphrase),
);

tool(
  "decrypt_report",
  "Decrypt an AES-GCM/PBKDF2 report envelope produced by encrypt_report or the web app.",
  {
    envelope: z.string().describe("The envelope JSON."),
    passphrase: z.string().describe("The shared passphrase."),
  },
  async ({ envelope, passphrase }) => decryptReport(envelope, passphrase),
);

/* -------------------------------------------------------------------------- */
/* Write tools (need PRIVATE_KEY)                                              */
/* -------------------------------------------------------------------------- */

tool(
  "submit_finding",
  "Submit a commit hash to a program on-chain (posts the $BUG anti-spam bond if the protocol requires one, approving it first if needed). Returns the tx and the assigned submission id. Requires PRIVATE_KEY.",
  {
    programId: z.string().describe("Program id to submit against."),
    commitHash: z.string().describe("The 0x 32-byte commit hash from compute_commit."),
  },
  async ({ programId, commitHash }) => {
    const pid = bigintFrom("programId", programId);
    if (!/^0x[0-9a-fA-F]{64}$/.test(commitHash)) throw new Error("commitHash must be a 0x 32-byte hex string");
    const me = account().address;

    // Ensure the anti-spam bond is approved when the protocol uses a $BUG bond.
    const [bugToken, bond] = await Promise.all([read<Address>("bugToken"), read<bigint>("submissionBond")]);
    if (bugToken !== NATIVE && bond > 0n) {
      const allowance = (await publicClient().readContract({
        address: bugToken,
        abi: erc20Abi,
        functionName: "allowance",
        args: [me, bountyAddress()],
      })) as bigint;
      if (allowance < bond) {
        const wc = walletClient();
        const approveHash = await wc.writeContract({
          address: bugToken,
          abi: erc20Abi,
          functionName: "approve",
          args: [bountyAddress(), maxUint256],
          account: wc.account!,
          chain: meta().chain,
        });
        await publicClient().waitForTransactionReceipt({ hash: approveHash });
      }
    }

    // The id that submit() will assign equals the current nextSubmissionId.
    const assignedSubmissionId = await read<bigint>("nextSubmissionId");
    const hash = await write("submit", [pid, commitHash as `0x${string}`]);
    return { assignedSubmissionId, ...(await receipt(hash)) };
  },
);

tool(
  "reveal_report",
  "Reveal a previously committed report (reportURI + salt) to prove authorship and unlock payout. Requires PRIVATE_KEY.",
  {
    submissionId: z.string(),
    reportURI: z.string().describe("Must exactly match the URI used in the commit."),
    salt: z.string().describe("The 0x 32-byte salt from submit time."),
  },
  async ({ submissionId, reportURI, salt }) => {
    const id = bigintFrom("submissionId", submissionId);
    if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new Error("salt must be a 0x 32-byte hex string");
    const hash = await write("reveal", [id, reportURI, salt as `0x${string}`]);
    return receipt(hash);
  },
);

tool(
  "triage",
  "Program-owner action: record a verdict on a submission. accept pays the hunter from escrow in the same tx; duplicate needs dupeOf. Requires PRIVATE_KEY (must be the program owner).",
  {
    submissionId: z.string(),
    verdict: z.enum(["accept", "reject", "duplicate", "spam"]),
    severity: z.enum(["Low", "Medium", "High", "Critical"]).optional().describe("Required for accept."),
    dupeOf: z.string().optional().describe("Required for duplicate: the earlier accepted submission id."),
  },
  async ({ submissionId, verdict, severity, dupeOf }) => {
    const id = bigintFrom("submissionId", submissionId);
    const verdictCode = Verdict[verdict as VerdictName];
    const sevMap: Record<string, number> = { Low: 1, Medium: 2, High: 3, Critical: 4 };
    const sevCode = verdict === "accept" ? sevMap[severity ?? "High"] : 0;
    if (verdict === "accept" && !severity) throw new Error("severity is required when verdict is accept");
    const dupe = verdict === "duplicate" ? bigintFrom("dupeOf", dupeOf ?? "") : 0n;
    if (verdict === "duplicate" && dupe === 0n) throw new Error("dupeOf is required when verdict is duplicate");
    const hash = await write("triage", [id, verdictCode, sevCode, dupe]);
    return receipt(hash);
  },
);

tool(
  "escalate",
  "Escalate a submission to the arbiter, whether for a lapsed triage deadline or to dispute a reject/duplicate/spam verdict within the dispute window. Requires PRIVATE_KEY.",
  { submissionId: z.string() },
  async ({ submissionId }) => {
    const id = bigintFrom("submissionId", submissionId);
    const hash = await write("escalate", [id]);
    return receipt(hash);
  },
);

tool(
  "resolve_escalation",
  "Arbiter action: rule on an escalated submission. A valid ruling pays out at the given severity; slashHunterBond only for bad faith. Requires PRIVATE_KEY (must be the arbiter).",
  {
    submissionId: z.string(),
    valid: z.boolean(),
    severity: z.enum(["Low", "Medium", "High", "Critical"]).optional().describe("Required when valid."),
    slashHunterBond: z.boolean().optional(),
  },
  async ({ submissionId, valid, severity, slashHunterBond }) => {
    const id = bigintFrom("submissionId", submissionId);
    const sevMap: Record<string, number> = { Low: 1, Medium: 2, High: 3, Critical: 4 };
    if (valid && !severity) throw new Error("severity is required when valid is true");
    const sevCode = valid ? sevMap[severity ?? "High"] : 0;
    const hash = await write("resolveEscalation", [id, valid, sevCode, Boolean(slashHunterBond)]);
    return receipt(hash);
  },
);

tool(
  "claim",
  "Withdraw rewards credited to your account (pull-payment). Defaults to native ETH and your own address. Requires PRIVATE_KEY.",
  {
    token: z.string().optional().describe("Reward token address; omit for native ETH."),
    to: z.string().optional().describe("Recipient; omit to send to yourself."),
  },
  async ({ token, to }) => {
    const me = account().address;
    const tokenAddr = token ? requireAddress("token", token) : NATIVE;
    const dest = to ? requireAddress("to", to) : me;
    const hash = await write("claim", [tokenAddr, dest]);
    return receipt(hash);
  },
);

tool(
  "withdraw_bond",
  "Withdraw your refundable $BUG bond credit (returned anti-spam / good-faith bonds). Requires PRIVATE_KEY.",
  { to: z.string().optional().describe("Recipient; omit to send to yourself.") },
  async ({ to }) => {
    const me = account().address;
    const dest = to ? requireAddress("to", to) : me;
    const hash = await write("withdrawBond", [dest]);
    return receipt(hash);
  },
);

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Never write to stdout: it is the MCP transport. Diagnostics go to stderr.
  console.error(`bug-protocol MCP server ready (chain ${meta().label}, contract ${process.env.BOUNTY_ADDRESS ?? "unset"})`);
}

main().catch((e) => {
  console.error("Fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});

// Referenced so tree-shakers / linters keep the helper available for future tools.
void addressUrl;
