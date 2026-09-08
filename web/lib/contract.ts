import type { Address } from "viem";

/**
 * Deployed addresses. Both are unset until the protocol ships — the UI reads
 * `isDeployed` and shows an honest pre-launch state rather than faking data.
 */
const raw = (v: string | undefined): Address | null =>
  v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : null;

export const BOUNTY_ADDRESS = raw(process.env.NEXT_PUBLIC_BOUNTY_ADDRESS);
export const BUG_TOKEN_ADDRESS = raw(process.env.NEXT_PUBLIC_BUG_TOKEN);

export const isDeployed = BOUNTY_ADDRESS !== null;

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

/** Only the reads and writes the app actually uses. */
export const bountyAbi = [
  {
    type: "function",
    name: "nextProgramId",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
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
    name: "payoutOf",
    inputs: [
      { name: "programId", type: "uint256" },
      { name: "severity", type: "uint8" },
    ],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "topTier",
    inputs: [{ name: "programId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "freePool",
    inputs: [{ name: "programId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "pendingCount",
    inputs: [{ name: "programId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "submissionBond",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
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
] as const;
