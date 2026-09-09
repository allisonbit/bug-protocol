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
