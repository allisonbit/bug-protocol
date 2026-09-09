import type { Address } from "viem";

/**
 * Pure, framework-free ToolRegistry ABI + enums + types. No "use client" here,
 * so both server route handlers (for on-chain verification of mirror writes)
 * and the client hooks in ./toolRegistry can import it. The client module
 * re-exports everything, so existing `@/lib/toolRegistry` imports keep working.
 */

// Enum label arrays — index-aligned with ToolRegistry.sol.
export const Platform = [
  "Unspecified",
  "Android",
  "Windows",
  "macOS",
  "Linux",
  "Terminal",
  "Browser",
  "MCP",
  "Web",
  "Other",
] as const;

export const Category = [
  "Unspecified",
  "Recon",
  "Scanning",
  "Fuzzing",
  "Exploitation",
  "Forensics",
  "Monitoring",
  "Reversing",
  "Reporting",
  "Other",
] as const;

export const ToolStatus = ["Active", "Flagged", "Slashed", "Delisted"] as const;

export type PlatformName = (typeof Platform)[number];
export type CategoryName = (typeof Category)[number];
export type ToolStatusName = (typeof ToolStatus)[number];

/** Selectable platforms/categories for the publish form (drops `Unspecified`). */
export const PLATFORM_OPTIONS = Platform.map((label, value) => ({ value, label })).slice(1);
export const CATEGORY_OPTIONS = Category.map((label, value) => ({ value, label })).slice(1);

export const toolRegistryAbi = [
  // ---- reads ----
  { type: "function", name: "nextToolId", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "minStake", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "flagRewardBps", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "bugToken", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "arbiter", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "feeRecipient", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  {
    type: "function",
    name: "getTool",
    inputs: [{ name: "toolId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "publisher", type: "address" },
          { name: "status", type: "uint8" },
          { name: "platform", type: "uint8" },
          { name: "category", type: "uint8" },
          { name: "createdAt", type: "uint64" },
          { name: "delistedAt", type: "uint64" },
          { name: "stake", type: "uint256" },
          { name: "downloads", type: "uint256" },
          { name: "flagCount", type: "uint32" },
          { name: "latestVersion", type: "uint32" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getVersion",
    inputs: [
      { name: "toolId", type: "uint256" },
      { name: "index", type: "uint256" },
    ],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "checksum", type: "bytes32" },
          { name: "publishedAt", type: "uint64" },
          { name: "metadataURI", type: "string" },
          { name: "semver", type: "string" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "latestVersion",
    inputs: [{ name: "toolId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "checksum", type: "bytes32" },
          { name: "publishedAt", type: "uint64" },
          { name: "metadataURI", type: "string" },
          { name: "semver", type: "string" },
        ],
      },
    ],
    stateMutability: "view",
  },
  { type: "function", name: "versionCount", inputs: [{ name: "toolId", type: "uint256" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "unstakeWindow", inputs: [{ name: "toolId", type: "uint256" }], outputs: [{ type: "uint64" }], stateMutability: "view" },
  { type: "function", name: "bondCredit", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  // ---- publisher writes ----
  {
    type: "function",
    name: "publish",
    inputs: [
      { name: "platform", type: "uint8" },
      { name: "category", type: "uint8" },
      { name: "metadataURI", type: "string" },
      { name: "checksum", type: "bytes32" },
      { name: "semver", type: "string" },
      { name: "stakeAmount", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "addVersion",
    inputs: [
      { name: "toolId", type: "uint256" },
      { name: "metadataURI", type: "string" },
      { name: "checksum", type: "bytes32" },
      { name: "semver", type: "string" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "increaseStake",
    inputs: [
      { name: "toolId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "function", name: "delist", inputs: [{ name: "toolId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  {
    type: "function",
    name: "withdrawStake",
    inputs: [
      { name: "toolId", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "function", name: "withdrawCredit", inputs: [{ name: "to", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "nonpayable" },
  // ---- moderation (anyone / arbiter) ----
  { type: "function", name: "recordDownload", inputs: [{ name: "toolId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  {
    type: "function",
    name: "flag",
    inputs: [
      { name: "toolId", type: "uint256" },
      { name: "reasonURI", type: "string" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "resolveFlag",
    inputs: [
      { name: "toolId", type: "uint256" },
      { name: "malicious", type: "bool" },
      { name: "slashBps", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // ---- events (decoded client-side to learn the assigned toolId) ----
  {
    type: "event",
    name: "ToolPublished",
    inputs: [
      { name: "toolId", type: "uint256", indexed: true },
      { name: "publisher", type: "address", indexed: true },
      { name: "platform", type: "uint8", indexed: false },
      { name: "category", type: "uint8", indexed: false },
      { name: "checksum", type: "bytes32", indexed: false },
      { name: "stake", type: "uint256", indexed: false },
      { name: "metadataURI", type: "string", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ToolDownloaded",
    inputs: [
      { name: "toolId", type: "uint256", indexed: true },
      { name: "downloads", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ToolFlagged",
    inputs: [
      { name: "toolId", type: "uint256", indexed: true },
      { name: "flagger", type: "address", indexed: true },
      { name: "reasonURI", type: "string", indexed: false },
    ],
    anonymous: false,
  },
] as const;

/** Shape returned by getTool, after viem decoding. */
export type ToolView = {
  publisher: Address;
  status: number;
  platform: number;
  category: number;
  createdAt: bigint;
  delistedAt: bigint;
  stake: bigint;
  downloads: bigint;
  flagCount: number;
  latestVersion: number;
};

export type VersionView = {
  checksum: `0x${string}`;
  publishedAt: bigint;
  metadataURI: string;
  semver: string;
};
