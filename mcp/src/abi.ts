/**
 * BugBounty ABI, copied verbatim from web/lib/contract.ts so the MCP server and
 * the web app speak to the same contract surface. Do not edit one without the
 * other. Plus the minimal ERC-20 slice needed to post the $BUG submission bond.
 */
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

/** Minimal ERC-20 slice: enough to approve the $BUG submission bond. */
export const erc20Abi = [
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;
