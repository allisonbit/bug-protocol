import { createHash, createPublicKey, verify as edVerify } from "node:crypto";

/**
 * DETACHED-PAYLOAD JWS VERIFICATION, WITH NO DEPENDENCIES.
 *
 * This is a reimplementation of the contract the deployment documents, not an
 * import of it, for two reasons. A CLI that installs in one line should not drag
 * a signature library behind it, and this file doubles as the readable reference
 * for anyone verifying the site's documents in another language. The companion
 * check `scripts/verify-cli.cjs` in the repository runs this against a real
 * signature from the running deployment, so the two implementations cannot drift
 * apart silently.
 *
 * THE SHAPE. JWS Detached Payload (RFC 7797 style, the form A2A card signing
 * uses): a compact JWS whose payload section is empty, looking like
 *     <protected header>..<signature>
 * The protected header carries the algorithm, the key id, the URL the document
 * was served at, and the SHA-256 digest of the body. The signature is over the
 * base64url of that header and nothing else, so a verifier hashes the bytes it
 * actually received and checks the header. Nothing has to reconstruct a
 * canonical form of the document.
 */

/** The key id the deployment pins in DNS and advertises in its key set. */
export const SIGNING_KEY_ID = "swamp-discovery-2026-09";

/** sha-256 of a body, in the unpadded base64url the header carries. */
export function digestOf(body) {
  return createHash("sha256").update(body).digest("base64url");
}

function readProtectedHeader(b64) {
  try {
    return JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Split a detached JWS into the parts a verifier needs, refusing anything whose
 * shape is wrong before any cryptography happens.
 */
export function splitDetachedJws(jws) {
  const parts = String(jws ?? "").split(".");
  if (parts.length !== 3 || parts[1] !== "") {
    return {
      ok: false,
      reason: "not a detached-payload JWS (expected header..signature with an empty payload section)",
    };
  }
  const header = readProtectedHeader(parts[0]);
  if (!header) return { ok: false, reason: "the protected header is not JSON" };
  return { ok: true, headerB64: parts[0], header, signature: Buffer.from(parts[2], "base64url") };
}

/**
 * Pick the verification key out of a published key set.
 *
 * The key set is the root of trust and is deliberately unsigned, which is
 * normal and worth saying out loud: it is pinned in DNS, so the anchor is the
 * domain rather than another document. An empty key set is reported as such,
 * because "no key advertised" and "key advertised but wrong" are different
 * findings for whoever is reading the output.
 */
export function keyFromJwks(jwks, kid) {
  const keys = jwks && Array.isArray(jwks.keys) ? jwks.keys : [];
  if (!keys.length) return { ok: false, reason: "the published key set is empty" };
  const jwk = kid ? keys.find((k) => k && k.kid === kid) : keys[0];
  if (!jwk) return { ok: false, reason: `no key with kid ${kid} is published` };
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) {
    return { ok: false, reason: `the key with kid ${jwk.kid} is not an Ed25519 OKP key` };
  }
  try {
    return { ok: true, key: createPublicKey({ key: jwk, format: "jwk" }), kid: jwk.kid };
  } catch (err) {
    return { ok: false, reason: "the published key could not be read: " + (err && err.message ? err.message : err) };
  }
}

/**
 * Verify one document. Every failure names the specific check that failed, so a
 * reader is sent to the right half of the problem instead of being told
 * "invalid".
 *
 * `publicKey` takes either the JWK from a published key set or an already
 * imported KeyObject. Both are accepted because both are natural at a call site,
 * and refusing one of them produces the sort of error message that sends a
 * reader looking in the wrong place entirely.
 */
export function verifyDetached({ body, urlPath, jws, publicKey, jwk, expectedKid = SIGNING_KEY_ID }) {
  const split = splitDetachedJws(jws);
  if (!split.ok) return split;
  const { headerB64, header, signature } = split;

  if (header.alg !== "EdDSA") return { ok: false, reason: `alg is ${header.alg}, expected EdDSA` };
  if (expectedKid && header.kid !== expectedKid) {
    return { ok: false, reason: `kid is ${header.kid}, expected ${expectedKid}` };
  }
  if (header.url !== urlPath) {
    return { ok: false, reason: `the signature was made for ${header.url} and this is ${urlPath}` };
  }
  const digest = digestOf(body);
  if (!header.digest || header.digest["sha-256"] !== digest) {
    return { ok: false, reason: "the body digest does not match, so the bytes served are not the bytes signed" };
  }

  const material = publicKey ?? jwk;
  let key;
  try {
    key =
      material && typeof material === "object" && material.type === "public"
        ? material
        : createPublicKey({ key: material, format: "jwk" });
  } catch (err) {
    return { ok: false, reason: "the published key could not be read: " + (err && err.message ? err.message : err) };
  }

  const ok = edVerify(null, Buffer.from(headerB64, "ascii"), key, signature);
  if (!ok) return { ok: false, reason: "the Ed25519 signature did not verify against the published key" };
  return { ok: true, keyId: header.kid, digest };
}
