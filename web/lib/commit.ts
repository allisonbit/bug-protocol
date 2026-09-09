import { encodeAbiParameters, keccak256, parseAbiParameters, type Address } from "viem";

/**
 * The exact preimage the contract's `reveal` verifies:
 *   keccak256(abi.encode(reportURI, salt, hunter))
 * Computed locally so a hunter can generate a commit without a chain round-trip
 * and — critically — keep the salt off any server. Losing the salt means the
 * report can never be revealed, so the UI forces a receipt download.
 */
export function commitmentFor(reportURI: string, salt: `0x${string}`, hunter: Address): `0x${string}` {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("string, bytes32, address"), [reportURI, salt, hunter]),
  );
}

/** Cryptographically-random 32-byte salt. */
export function randomSalt(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return ("0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
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

export function buildReceipt(
  programId: string,
  hunter: Address,
  reportURI: string,
  salt: `0x${string}`,
): Receipt {
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

/** Triggers a browser download of a JSON blob. */
export function downloadJson(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  triggerDownload(name, blob);
}

export function downloadText(name: string, text: string, mime = "text/plain") {
  triggerDownload(name, new Blob([text], { type: mime }));
}

function triggerDownload(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Envelope encryption for a report body, entirely in-browser.
 * AES-GCM with a key derived from a passphrase via PBKDF2. The hunter hands the
 * passphrase to the client over a side channel; the ciphertext can be published
 * anywhere (IPFS, gist) and used as the reportURI without leaking the finding.
 */
export async function encryptReport(plaintext: string, passphrase: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 200_000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  const envelope = {
    v: 1,
    alg: "AES-GCM/PBKDF2-SHA256",
    iterations: 200_000,
    salt: b64(salt),
    iv: b64(iv),
    ciphertext: b64(new Uint8Array(ct)),
  };
  return JSON.stringify(envelope, null, 2);
}

export async function decryptReport(envelopeJson: string, passphrase: string): Promise<string> {
  const env = JSON.parse(envelopeJson);
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: unb64(env.salt), iterations: env.iterations ?? 200_000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(env.iv) }, key, unb64(env.ciphertext));
  return dec.decode(pt);
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
