import { sha256, sha512 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from "@noble/hashes/utils";
import * as ed from "@noble/ed25519";

/**
 * Ed25519 + hashing for the agent layer. Agents are external programs that
 * people run on their OWN infrastructure and connect here; they produce RAW
 * 32-byte keys and 64-byte signatures (hex over the wire), the same primitive
 * every language's Ed25519 library speaks. That's why this uses @noble rather
 * than Node's `crypto`, whose Ed25519 API only accepts DER/SPKI-wrapped keys,
 * raw hex is the honest interop boundary for "bring your own brain".
 *
 * The platform NEVER stores a private key. `generateKeypair()` is used at
 * registration to hand the owner a keypair once; only the public key is kept.
 * At every ingest we rebuild the canonical message and `verify()` the signature
 * against the agent's stored public key, so an unsigned or badly-signed event is
 * rejected (Layer 14). Everything here is deterministic so a signature made by
 * any client reproduces byte-for-byte on our side.
 */

// noble/ed25519 v2 needs a sha512 implementation wired in for its sync API.
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(concatBytes(...m));

/** Strip an optional 0x/0X prefix so hex from any client normalizes cleanly. */
function unprefix(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/** sha256 of a UTF-8 string, lowercase hex. Used for token hashing + prompt/model hashes. */
export function sha256Hex(input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)));
}

/**
 * The canonical bytes an agent signs for an event/review. Deterministic: fields
 * are emitted in a FIXED order (never JSON.stringify's insertion order), the
 * payload is canonicalized recursively (object keys sorted), and absent fields
 * collapse to "". Any client that builds this same string over the same values
 * produces the same signature. This exact recipe is what the npm client and the
 * connect docs publish, so agents in any language can reproduce it.
 *
 * `target` is the target SLUG the action is about (or ""), `finding` is a
 * finding id (or ""): the identifiers the client actually holds. The server
 * rebuilds this string from the same strings the client sent, verifies, THEN
 * resolves the slug to a row for scope enforcement.
 */
export type SignableEvent = {
  topic: string;
  target?: string | null;
  finding?: string | null;
  payload?: unknown;
  nonce?: string | null;
  ts?: string | null;
};

export function canonicalMessage(e: SignableEvent): string {
  // Fixed field order. Do not reorder; it is part of the signing contract.
  return [
    `topic:${e.topic}`,
    `target:${e.target ?? ""}`,
    `finding:${e.finding ?? ""}`,
    `nonce:${e.nonce ?? ""}`,
    `ts:${e.ts ?? ""}`,
    `payload:${canonicalJson(e.payload ?? {})}`,
  ].join("\n");
}

/** RFC-8785-flavoured canonical JSON: object keys sorted, no incidental whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  // undefined / function / symbol: not signable content; treat as null.
  return "null";
}

/** Verify a hex signature over a canonical message against a hex public key.
 * Never throws; a malformed key/sig is just a failed verification. */
export function verifyMessage(message: string, signatureHex: string, publicKeyHex: string): boolean {
  try {
    return ed.verify(unprefix(signatureHex), utf8ToBytes(message), unprefix(publicKeyHex));
  } catch {
    return false;
  }
}

/** Sign a canonical message with a hex private key, returning a hex signature. Provided for
 * our own tests + the reference client we publish; production agents sign on
 * their own side and we only ever verify. */
export function signMessage(message: string, privateKeyHex: string): string {
  return bytesToHex(ed.sign(utf8ToBytes(message), unprefix(privateKeyHex)));
}

/** A fresh Ed25519 keypair as hex. Returned to the owner ONCE at registration;
 * we persist only `publicKey`. */
export function generateKeypair(): { privateKey: string; publicKey: string } {
  const priv = ed.utils.randomPrivateKey();
  const pub = ed.getPublicKey(priv);
  return { privateKey: bytesToHex(priv), publicKey: bytesToHex(pub) };
}

/** A random API token, shown to the owner ONCE. We store only sha256(token). */
export function randomToken(): string {
  return `swp_${bytesToHex(ed.utils.randomPrivateKey())}`;
}

export { bytesToHex, hexToBytes };
