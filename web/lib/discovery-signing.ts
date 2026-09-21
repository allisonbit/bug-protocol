import "server-only";
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";

/**
 * THE DISCOVERY SIGNATURE LAYER.
 *
 * Every discovery document this site serves is a self-assertion until it is
 * signed. A2A v1.0 made signed agent cards the standard (JWS, Detached Payload
 * form for HTTP), and this platform's own research landed on the same conclusion
 * from the other direction: the A2A community explicitly left trust verification
 * to "external mechanisms" that do not exist yet, and the first habitat whose
 * discovery layer is verifiable end to end is the one those mechanisms get built
 * against. So: the agent card, the contract, and the OpenAPI document are all
 * signed by the same key that proves the MCP registry namespace, and the
 * signature travels WITH the artifact, in a header, so one fetch carries both
 * the claim and the proof of who made it.
 *
 * THE KEY. The same Ed25519 keypair the MCP registry proof already uses:
 * MCP_REGISTRY_PUBLIC_KEY is served at /.well-known/mcp-registry-auth and pinned
 * in DNS TXT at the apex, which means the verification path needs no new key
 * ceremony and no new trust anchor. The private half lives only in the
 * deployment's environment as MCP_REGISTRY_PRIVATE_KEY, exactly like the
 * registry signer already does. Without it the site serves unsigned artifacts
 * and SAYS SO in the signature headers, rather than pretending.
 *
 * THE FORMAT. JWS Detached Payload (RFC 7797 style, the shape A2A's card
 * signing uses): a compact JWS whose payload section is empty, with the
 * SHA-256 digest of the body travelling in the protected header. A verifier
 * re-hashes the bytes it actually received and checks the signature over the
 * header; nothing has to reconstruct a canonical form of the document.
 */

export const SIGNATURE_HEADER = "x-swamp-signature";
export const SIGNATURE_INPUT_HEADER = "x-swamp-signature-input";
export const KEY_ID_HEADER = "x-swamp-signature-keyid";

/** The key id the DNS TXT record and the JWKS both advertise. */
export const SIGNING_KEY_ID = "swamp-discovery-2026-09";

/** Whether this deployment holds the private half and can sign at all. */
export function signingConfigured(): boolean {
  return typeof process.env.MCP_REGISTRY_PRIVATE_KEY === "string" && process.env.MCP_REGISTRY_PRIVATE_KEY.length > 0;
}

/** The public half, raw base64 (the same bytes the registry proof carries). */
export function signingPublicKeyRaw(): string {
  return (process.env.MCP_REGISTRY_PUBLIC_KEY ?? "").trim();
}

function privateKey(): KeyObject {
  const raw = process.env.MCP_REGISTRY_PRIVATE_KEY;
  if (!raw) throw new Error("MCP_REGISTRY_PRIVATE_KEY is not set, so this deployment cannot sign its discovery documents.");
  const text = raw.trim();
  if (text.includes("BEGIN")) return createPrivateKey(text);
  const bytes = Buffer.from(text, "base64");
  // The generator stores base64 of the PKCS8 DER (48 bytes for Ed25519), so the
  // decoded bytes ARE the key. Some operators paste base64 of the PEM text
  // instead; that decodes to ASCII with a BEGIN line, so accept that too.
  if (bytes.subarray(0, 5).toString("utf8").includes("BEGIN")) return createPrivateKey(bytes.toString("utf8"));
  return createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
}

function publicKeyObject(): KeyObject {
  const raw = signingPublicKeyRaw();
  if (raw) {
    // The env var holds the raw 32-byte public key, base64. Wrap it as SPKI.
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(raw, "base64")]);
    return createPublicKey({ key: der, format: "der", type: "spki" });
  }
  // Fall back to deriving it from the private half, so a deployment that set
  // only MCP_REGISTRY_PRIVATE_KEY still serves a working JWKS.
  return createPublicKey(privateKey());
}

/** base64url, unsigned and unpadded, as JWS requires. */
function b64u(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

/**
 * Sign a served body.
 *
 * Returns the three headers a verifier reads. The protected header carries the
 * algorithm, the key id, the URL the document is served at (so a signature
 * cannot be replayed at another path), and the sha-256 digest of the body. The
 * signature is over exactly those header bytes, which is what detached means.
 * Empty strings come back when no key is configured, and the route says
 * unsigned rather than inventing a signature.
 */
export function signDiscovery(body: string, urlPath: string): Record<string, string> {
  if (!signingConfigured()) return {};
  const digest = createHash("sha256").update(body, "utf8").digest("base64url");
  const header = {
    alg: "EdDSA",
    kid: SIGNING_KEY_ID,
    typ: "JWS",
    url: urlPath,
    digest: { "sha-256": digest },
  };
  const headerB64 = b64u(Buffer.from(JSON.stringify(header), "utf8"));
  const sig = edSign(null, Buffer.from(headerB64, "ascii"), privateKey());
  return {
    [SIGNATURE_HEADER]: `${headerB64}..${b64u(sig)}`,
    [SIGNATURE_INPUT_HEADER]: JSON.stringify(header),
    [KEY_ID_HEADER]: SIGNING_KEY_ID,
  };
}

/**
 * Verify a signed body, for the verifier script and for anyone reading this
 * repository to reimplement. Returns the reason on failure, because a check
 * that only says "invalid" sends people looking in the wrong half.
 */
export function verifyDiscovery(
  body: string,
  urlPath: string,
  jws: string,
  publicKeyRaw: string,
): { ok: true; keyId: string } | { ok: false; reason: string } {
  const parts = jws.split(".");
  if (parts.length !== 3 || parts[1] !== "") return { ok: false, reason: "not a detached-payload JWS (expected header..payload..signature with empty payload)" };
  const [headerB64, , sigB64] = parts;
  let header: { alg?: string; kid?: string; url?: string; digest?: { "sha-256"?: string } };
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "protected header is not JSON" };
  }
  if (header.alg !== "EdDSA") return { ok: false, reason: `alg is ${header.alg}, expected EdDSA` };
  if (header.kid !== SIGNING_KEY_ID) return { ok: false, reason: `kid is ${header.kid}, expected ${SIGNING_KEY_ID}` };
  if (header.url !== urlPath) return { ok: false, reason: `signature was made for ${header.url}, fetched ${urlPath}` };
  const expectedDigest = createHash("sha256").update(body, "utf8").digest("base64url");
  if (header.digest?.["sha-256"] !== expectedDigest) {
    return { ok: false, reason: "body digest mismatch: the bytes served are not the bytes signed" };
  }
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyRaw, "base64")]);
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  const okSig = edVerify(null, Buffer.from(headerB64, "ascii"), key, Buffer.from(sigB64, "base64url"));
  if (!okSig) return { ok: false, reason: "Ed25519 verification failed against the published public key" };
  return { ok: true, keyId: SIGNING_KEY_ID };
}

/**
 * The JWKS document, served so a verifier needs nothing but standard tooling.
 * Ed25519 keys in JWK form carry the raw public key in `x` with the OKP kty.
 */
export function jwks(): { keys: { kty: string; crv: string; x: string; kid: string; use: string; alg: string }[] } {
  const raw = signingPublicKeyRaw() || (() => {
    const spki = publicKeyObject().export({ format: "der", type: "spki" }) as Buffer;
    return spki.subarray(spki.length - 32).toString("base64url");
  })();
  return {
    keys: [
      {
        kty: "OKP",
        crv: "Ed25519",
        x: raw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
        kid: SIGNING_KEY_ID,
        use: "sig",
        alg: "EdDSA",
      },
    ],
  };
}
