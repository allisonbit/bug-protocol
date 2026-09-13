"use client";

import type { Address } from "viem";

/**
 * Local, per-browser store of commit secrets. The salt never leaves the device;
 * without it a report can't be revealed, so we persist it here AND force a file
 * download at submit time. Keyed by chainId + submissionId once known, with a
 * pending bucket for commits made before the submissionId is confirmed.
 */
export type VaultEntry = {
  programId: string;
  submissionId?: string;
  hunter: Address;
  reportURI: string;
  salt: `0x${string}`;
  commitHash: `0x${string}`;
  createdAt: string;
};

const KEY = "bug-protocol:vault:v1";

function readAll(): VaultEntry[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

function writeAll(entries: VaultEntry[]) {
  localStorage.setItem(KEY, JSON.stringify(entries));
}

export function saveEntry(entry: VaultEntry) {
  const all = readAll();
  // de-dup on commitHash
  const next = [entry, ...all.filter((e) => e.commitHash !== entry.commitHash)];
  writeAll(next);
}

export function attachSubmissionId(commitHash: string, submissionId: string) {
  const all = readAll();
  const next = all.map((e) => (e.commitHash === commitHash ? { ...e, submissionId } : e));
  writeAll(next);
}

export function entriesForHunter(hunter?: Address): VaultEntry[] {
  if (!hunter) return [];
  return readAll().filter((e) => e.hunter.toLowerCase() === hunter.toLowerCase());
}

export function findBySubmissionId(submissionId: string, hunter?: Address): VaultEntry | undefined {
  return readAll().find(
    (e) =>
      e.submissionId === submissionId &&
      (!hunter || e.hunter.toLowerCase() === hunter.toLowerCase()),
  );
}

/**
 * Find the secret for a row by the commit it produced.
 *
 * This is the join that actually matters: a submission is indexed by its row id
 * on this site and by its commit hash on chain, and the vault is written before
 * either exists (the receipt has to be saved before anything is signed, or a
 * failed transaction would strand the salt). Matching on the commit hash is what
 * lets a hunter open a finding they committed in a different browser, from the
 * CLI, or from the tools page.
 */
export function findByCommitHash(commitHash: string, hunter?: Address): VaultEntry | undefined {
  const want = commitHash.toLowerCase();
  return readAll().find(
    (e) =>
      e.commitHash.toLowerCase() === want &&
      (!hunter || e.hunter.toLowerCase() === hunter.toLowerCase()),
  );
}

/** Every secret this browser holds for a given hunter address. */
export function allForHunter(hunter?: Address): VaultEntry[] {
  return entriesForHunter(hunter);
}

export function importReceipt(json: string): VaultEntry | null {
  try {
    const r = JSON.parse(json);
    if (r?.salt && r?.reportURI && r?.commitHash && r?.hunter) {
      const entry: VaultEntry = {
        programId: String(r.programId ?? ""),
        submissionId: r.submissionId ? String(r.submissionId) : undefined,
        hunter: r.hunter,
        reportURI: r.reportURI,
        salt: r.salt,
        commitHash: r.commitHash,
        createdAt: r.createdAt ?? new Date().toISOString(),
      };
      saveEntry(entry);
      return entry;
    }
  } catch {
    /* ignore */
  }
  return null;
}
