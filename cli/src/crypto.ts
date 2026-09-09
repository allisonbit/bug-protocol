import { webcrypto } from "node:crypto";

/**
 * Report-body envelope encryption, byte-for-byte compatible with the web app's
 * lib/commit.ts. AES-GCM with a key derived from a passphrase via PBKDF2
 * (SHA-256, 200k iterations). The ciphertext envelope is safe to publish as the
 * reportURI; the passphrase is shared with the client over a side channel.
 *
 * We use Node's webcrypto.subtle (same primitives the browser uses) and Buffer
 * for base64 (identical output to the browser's btoa on binary), so a file
 * encrypted in the browser decrypts here and vice-versa.
 */
const subtle = webcrypto.subtle;

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

export async function encryptReport(plaintext: string, passphrase: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = new Uint8Array(16);
  const iv = new Uint8Array(12);
  webcrypto.getRandomValues(salt);
  webcrypto.getRandomValues(iv);

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
