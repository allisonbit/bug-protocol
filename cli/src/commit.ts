import { encodeAbiParameters, keccak256, parseAbiParameters, type Address } from "viem";
import { webcrypto } from "node:crypto";

/**
 * The exact preimage the contract's `reveal` verifies:
 *   keccak256(abi.encode(reportURI, salt, hunter))
 * Identical to web/lib/commit.ts so receipts interop across the web app and CLI.
 */
export function commitmentFor(reportURI: string, salt: `0x${string}`, hunter: Address): `0x${string}` {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("string, bytes32, address"), [reportURI, salt, hunter]),
  );
}

/** Cryptographically-random 32-byte salt (hex). */
export function randomSalt(): `0x${string}` {
  const bytes = new Uint8Array(32);
  webcrypto.getRandomValues(bytes);
  return ("0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
}

/** Normalise a user-supplied salt to a 0x-prefixed 32-byte hex string. */
export function normalizeSalt(input: string): `0x${string}` {
  const hex = input.startsWith("0x") ? input.slice(2) : input;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("salt must be 32 bytes hex (64 hex chars, optional 0x prefix)");
  }
  return ("0x" + hex.toLowerCase()) as `0x${string}`;
}

export type Receipt = {
  kind: "bug-protocol-commit-receipt";
  version: 1;
  programId: string;
  hunter: Address;
  reportURI: string;
  salt: `0x${string}`;
  commitHash: `0x${string}`;
  createdAt: string;
  note: string;
};

export function buildReceipt(programId: string, hunter: Address, reportURI: string, salt: `0x${string}`): Receipt {
  return {
    kind: "bug-protocol-commit-receipt",
    version: 1,
    programId,
    hunter,
    reportURI,
    salt,
    commitHash: commitmentFor(reportURI, salt, hunter),
    createdAt: new Date().toISOString(),
    note: "Keep this file safe and secret. The salt is required to reveal your report and prove authorship. Anyone with it plus your report can reveal; without it you cannot reveal. Do not upload it anywhere.",
  };
}
