import type { Address } from "viem";
import { chainMeta, DEFAULT_CHAIN_ID, NATIVE as NATIVE_ZERO } from "./chains";

/**
 * Default-chain (Robinhood) addresses, kept for modules that only need one
 * address. Chain-aware code should use `useBounty()` from ./reads, which
 * resolves the deployment for whatever chain the wallet is connected to.
 * Everything still renders pre-deployment; `isDeployed` gates writes honestly.
 */
export const BOUNTY_ADDRESS: Address | null = chainMeta(DEFAULT_CHAIN_ID).bounty;
export const BUG_TOKEN_ADDRESS: Address | null = chainMeta(DEFAULT_CHAIN_ID).bugToken;

export const isDeployed = BOUNTY_ADDRESS !== null;

export const NATIVE = NATIVE_ZERO;

export const ProgramStatus = ["Draft", "Live", "Paused", "Closed"] as const;
export const SubStatus = [
  "Pending",
  "Accepted",
  "Rejected",
  "Duplicate",
  "Spam",
  "Escalated",
  "Resolved",
] as const;
export const Severity = ["None", "Low", "Medium", "High", "Critical"] as const;

export type ProgramStatusName = (typeof ProgramStatus)[number];
export type SubStatusName = (typeof SubStatus)[number];
export type SeverityName = (typeof Severity)[number];

export const bountyAbi = [
  // ---- reads ----
  { type: "function", name: "nextProgramId", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "nextSubmissionId", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "bugToken", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "arbiter", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "feeRecipient", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "protocolFeeBps", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "submissionBond", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "minProgramBond", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    type: "function",
    name: "getProgram",
    inputs: [{ name: "programId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "owner", type: "address" },
          { name: "rewardToken", type: "address" },
          { name: "scopeHash", type: "bytes32" },
          { name: "triageDeadline", type: "uint64" },
          { name: "disclosureDelay", type: "uint64" },
          { name: "status", type: "uint8" },
          { name: "pool", type: "uint256" },
          { name: "locked", type: "uint256" },
          { name: "bond", type: "uint256" },
          { name: "scopeURI", type: "string" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getSubmission",
    inputs: [{ name: "submissionId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "programId", type: "uint96" },
          { name: "hunter", type: "address" },
          { name: "commitHash", type: "bytes32" },
          { name: "submittedAt", type: "uint64" },
          { name: "triagedAt", type: "uint64" },
          { name: "status", type: "uint8" },
          { name: "severity", type: "uint8" },
          { name: "bond", type: "uint256" },
          { name: "award", type: "uint256" },
          { name: "dupeOf", type: "uint256" },
          { name: "reportURI", type: "string" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "payoutOf",
    inputs: [
      { name: "programId", type: "uint256" },
      { name: "severity", type: "uint8" },
    ],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  { type: "function", name: "topTier", inputs: [{ name: "programId", type: "uint256" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "freePool", inputs: [{ name: "programId", type: "uint256" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "pendingCount", inputs: [{ name: "programId", type: "uint256" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "triageDeadlineOf", inputs: [{ name: "submissionId", type: "uint256" }], outputs: [{ type: "uint64" }], stateMutability: "view" },
  { type: "function", name: "embargoWaived", inputs: [{ name: "submissionId", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  // True when a submission reached Escalated straight from Pending. The arbiter
  // console needs it: only then is the escalation's escrow cover still counted in
  // `pendingCount`, which is what makes the ruling payable from the pool.
  { type: "function", name: "escalatedFromPending", inputs: [{ name: "submissionId", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  // The protocol's own bounds. The owner provisioning UI clamps to these rather
  // than letting the user sign a transaction that is certain to revert.
  { type: "function", name: "MIN_TRIAGE_DEADLINE", inputs: [], outputs: [{ type: "uint64" }], stateMutability: "view" },
  { type: "function", name: "MAX_TRIAGE_DEADLINE", inputs: [], outputs: [{ type: "uint64" }], stateMutability: "view" },
  { type: "function", name: "MAX_DISCLOSURE_DELAY", inputs: [], outputs: [{ type: "uint64" }], stateMutability: "view" },
  { type: "function", name: "DISPUTE_WINDOW", inputs: [], outputs: [{ type: "uint64" }], stateMutability: "view" },
  {
    type: "function",
    name: "claimable",
    inputs: [
      { name: "account", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  { type: "function", name: "bondCredit", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    type: "function",
    name: "commitmentFor",
    inputs: [
      { name: "reportURI", type: "string" },
      { name: "salt", type: "bytes32" },
      { name: "hunter", type: "address" },
    ],
    outputs: [{ type: "bytes32" }],
    stateMutability: "pure",
  },
  // ---- client writes ----
  {
    type: "function",
    name: "createProgram",
    inputs: [
      { name: "rewardToken", type: "address" },
      { name: "scopeHash", type: "bytes32" },
      { name: "scopeURI", type: "string" },
      { name: "tiers", type: "uint256[5]" },
      { name: "triageDeadline", type: "uint64" },
      { name: "disclosureDelay", type: "uint64" },
    ],
    outputs: [{ type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "fundProgram",
    inputs: [
      { name: "programId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "bondProgram",
    inputs: [
      { name: "programId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setStatus",
    inputs: [
      { name: "programId", type: "uint256" },
      { name: "next", type: "uint8" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setScope",
    inputs: [
      { name: "programId", type: "uint256" },
      { name: "scopeHash", type: "bytes32" },
      { name: "scopeURI", type: "string" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setPayoutTier",
    inputs: [
      { name: "programId", type: "uint256" },
      { name: "severity", type: "uint8" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "withdrawPool",
    inputs: [
      { name: "programId", type: "uint256" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "triage",
    inputs: [
      { name: "submissionId", type: "uint256" },
      { name: "verdict", type: "uint8" },
      { name: "severity", type: "uint8" },
      { name: "dupeOf", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "function", name: "waiveEmbargo", inputs: [{ name: "submissionId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  {
    type: "function",
    name: "reclaimProgramBond",
    inputs: [
      { name: "programId", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // ---- hunter writes ----
  {
    type: "function",
    name: "submit",
    inputs: [
      { name: "programId", type: "uint256" },
      { name: "commitHash", type: "bytes32" },
    ],
    outputs: [{ type: "uint256" }],
    stateMutability: "nonpayable",
  },
  { type: "function", name: "escalate", inputs: [{ name: "submissionId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "finalizeSpamSlash", inputs: [{ name: "submissionId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  {
    type: "function",
    name: "reveal",
    inputs: [
      { name: "submissionId", type: "uint256" },
      { name: "reportURI", type: "string" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // ---- withdrawals ----
  {
    type: "function",
    name: "claim",
    inputs: [
      { name: "token", type: "address" },
      { name: "to", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
    stateMutability: "nonpayable",
  },
  { type: "function", name: "withdrawBond", inputs: [{ name: "to", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "nonpayable" },
  // ---- arbiter ----
  {
    type: "function",
    name: "resolveEscalation",
    inputs: [
      { name: "submissionId", type: "uint256" },
      { name: "valid", type: "bool" },
      { name: "severity", type: "uint8" },
      { name: "slashHunterBond", type: "bool" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/**
 * The events we decode from receipts. Reading `nextProgramId` before a write and
 * assuming it incremented by one is a race: two creators in the same block both
 * think they own the new id, so the flows that need the id read it out of the
 * log the contract actually emitted.
 */
export const bountyEventsAbi = [
  {
    type: "event",
    name: "ProgramCreated",
    inputs: [
      { indexed: true, name: "programId", type: "uint256" },
      { indexed: true, name: "owner", type: "address" },
      { indexed: false, name: "rewardToken", type: "address" },
      { indexed: false, name: "scopeHash", type: "bytes32" },
      { indexed: false, name: "scopeURI", type: "string" },
    ],
  },
  {
    type: "event",
    name: "SubmissionCreated",
    inputs: [
      { indexed: true, name: "submissionId", type: "uint256" },
      { indexed: true, name: "programId", type: "uint256" },
      { indexed: true, name: "hunter", type: "address" },
      { indexed: false, name: "commitHash", type: "bytes32" },
    ],
  },
  {
    type: "event",
    name: "SubmissionRevealed",
    inputs: [
      { indexed: true, name: "submissionId", type: "uint256" },
      { indexed: false, name: "reportURI", type: "string" },
    ],
  },
  {
    type: "event",
    name: "SubmissionEscalated",
    inputs: [
      { indexed: true, name: "submissionId", type: "uint256" },
      { indexed: true, name: "by", type: "address" },
      { indexed: false, name: "slaLapsed", type: "bool" },
    ],
  },
  {
    type: "event",
    name: "EscalationResolved",
    inputs: [
      { indexed: true, name: "submissionId", type: "uint256" },
      { indexed: false, name: "valid", type: "bool" },
      { indexed: false, name: "severity", type: "uint8" },
      { indexed: false, name: "award", type: "uint256" },
    ],
  },
] as const;

/** Shapes returned by getProgram / getSubmission, after viem decoding. */
export type ProgramView = {
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

export type SubmissionView = {
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

/**
 * The contract's SubStatus enum, by index. Kept beside the ABI so the UI maps a
 * chain verdict to a row status in one place instead of sprinkling magic numbers.
 */
export const CHAIN_SUB_STATUS = [
  "pending",
  "accepted",
  "rejected",
  "duplicate",
  "spam",
  "escalated",
  "resolved",
] as const;

export type ChainSubStatus = (typeof CHAIN_SUB_STATUS)[number];

/** Verdict index the contract expects for each triage outcome. */
export const VERDICT_INDEX: Record<"accepted" | "rejected" | "duplicate" | "spam", number> = {
  accepted: 1,
  rejected: 2,
  duplicate: 3,
  spam: 4,
};

/** Severity index the contract expects (None is deliberately unpayable). */
export const SEVERITY_INDEX: Record<"low" | "medium" | "high" | "critical", number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Inverse of SEVERITY_INDEX, for rendering a chain severity as a row value. */
export const INDEX_SEVERITY = ["none", "low", "medium", "high", "critical"] as const;

/**
 * The contract index for any row severity, including `none`.
 *
 * Rows carry `none` before a verdict assigns a real severity, and passing that
 * straight into `SEVERITY_INDEX` is a type error, which is the compiler doing its
 * job, because `Severity.None` is index 0 and the contract deliberately treats it
 * as unpayable. Mapping it explicitly, rather than casting it away, is what keeps
 * "no severity yet" from ever being mistaken for "low".
 */
export function severityIndexOf(s: "none" | "low" | "medium" | "high" | "critical"): number {
  return s === "none" ? 0 : SEVERITY_INDEX[s];
}

/**
 * Fallbacks for the protocol constants, used only until the chain answers. They
 * mirror the contract's declared values exactly (3d, 30d, 180d, 7d) so a read
 * that hasn't resolved yet can never show a hunter a window the chain would
 * refuse.
 */
export const PROTOCOL_FALLBACK = {
  minTriageDeadline: 3n * 86_400n,
  maxTriageDeadline: 30n * 86_400n,
  maxDisclosureDelay: 180n * 86_400n,
  disputeWindow: 7n * 86_400n,
} as const;
