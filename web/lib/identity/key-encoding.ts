/**
 * KEY ENCODINGS, IN ONE PLACE.
 *
 * An Ed25519 public key is 32 raw bytes, and three documents on this deployment
 * publish one: the platform's DID, every agent's DID, and every machine's DID. A
 * consumer that understands did:web expects a JWK for a JsonWebKey2020 method, and
 * the did:key convention additionally uses a multibase string. Computing those
 * encodings in three modules would be three chances for one of them to drift, and a
 * key that encodes differently in one document than another is a key a resolver
 * cannot match. So the encoders live here and every document calls them.
 *
 * The base58btc encoder is twenty lines below rather than an undeclared dependency
 * on a transitive package: an identity document that breaks because a hoisting
 * change moved a package is not an identity document.
 */

/** The multibase prefix for an Ed25519 public key: 0xed01, then the raw key. */
const ED25519_MULTICODEC = Buffer.from([0xed, 0x01]);

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base58btc, the encoding multibase identifiers use. */
export function base58btc(bytes: Buffer): string {
  let n = BigInt("0x" + (bytes.toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    const rem = Number(n % 58n);
    out = BASE58_ALPHABET[rem] + out;
    n = n / 58n;
  }
  // Every leading zero byte is a leading "1", which is what keeps fixed-width keys
  // fixed-width after a round trip.
  for (const byte of bytes) {
    if (byte === 0) out = "1" + out;
    else break;
  }
  return out;
}

/** `z` prefixed base58btc over the ed25519 multicodec header and the raw key. */
export function ed25519Multibase(raw: Buffer): string {
  return `z${base58btc(Buffer.concat([ED25519_MULTICODEC, raw]))}`;
}

/** The JWK every DID-aware consumer understands for an Ed25519 public key. */
export function ed25519Jwk(raw: Buffer, label?: string): { kty: string; crv: string; x: string; kid?: string } {
  return {
    kty: "OKP",
    crv: "Ed25519",
    // base64url without padding, which is what JWK and JWS both want.
    x: raw.toString("base64url"),
    ...(label ? { kid: label } : {}),
  };
}
