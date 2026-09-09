import { webcrypto } from "node:crypto";
import { encodeAbiParameters, keccak256, parseAbiParameters, type Address } from "viem";

/**
 * Commit derivation + report encryption, byte-compatible with web/lib/commit.ts.
 * Uses Node's webcrypto (same WebCrypto API the browser uses) and Buffer-based
 * base64 (identical output to the browser's btoa(String.fromCharCode(...))), so
 * a report encrypted in the web app decrypts here and vice-versa.
 */
const subtle = webcrypto.subtle;

/** keccak256(abi.encode(reportURI, salt, hunter)) — the preimage `reveal` checks. */
export function commitmentFor(reportURI: string, salt: `0x${string}`, hunter: Address): `0x${string}` {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("string, bytes32, address"), [reportURI, salt, hunter]),
  );
}

/** Cryptographically-random 32-byte salt. */
export function randomSalt(): `0x${string}` {
  const bytes = new Uint8Array(32);
  webcrypto.getRandomValues(bytes);
  return ("0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
}

export async function encryptReport(plaintext: string, passphrase: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const keyMaterial = await subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 200_000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
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
  const keyMaterial = await subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "PBKDF2", salt: unb64(env.salt), iterations: env.iterations ?? 200_000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64(env.iv) }, key, unb64(env.ciphertext));
  return dec.decode(pt);
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
