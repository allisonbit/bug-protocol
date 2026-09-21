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
/**
 * Why an artifact is unsigned, when it should have been signed.
 *
 * Absent means signed, or means no key is configured at all. Present means a key
 * IS configured and could not be used, which is the one case a reader should have
 * to act on, and the case that used to be a 500 instead of a sentence.
 */
export const SIGNATURE_STATUS_HEADER = "x-swamp-signature-status";

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

/** The fixed ASN.1 prefixes Ed25519 keys carry. Both are 16 bytes for PKCS8, 12 for SPKI. */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Undo the escaping an env var forces on a pasted PEM.
 *
 * A Vercel environment variable is one line, so an operator who pastes a PEM puts
 * `\n` in as TWO characters and the body arrives as one unbroken base64 line the
 * ASN.1 decoder rejects. The first version of this used a single pattern that
 * required a backslash before both letters and therefore matched neither, which
 * the signing verifier caught by round-tripping a real escaped PEM: the argument
 * for testing the encodings rather than reasoning about them.
 */
const unescapePem = (s: string): string => s.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");

/**
 * WHY THIS READS THE KEY SO SUSPICIOUSLY.
 *
 * The generator hands the operator base64 of the PKCS8 DER, and that is one of
 * about six encodings the same 32-byte seed travels in: PEM pasted whole, PEM
 * pasted with its newlines ESCAPED (an env var is one line, so `\n` arrives as
 * two characters and the ASN.1 decoder rejects the body with "wrong tag"), base64
 * or base64url of the DER, base64 or hex of the bare seed, a libsodium seed with
 * the public half appended, or a JWK object.
 *
 * This used to accept three of those and `createPrivateKey` threw on the rest —
 * FROM A ROUTE. On 2026-09-21 a key set two days earlier was in one of the other
 * forms, and it took four documents down at once: /skill.md, /openapi.json, the
 * agent card and the MCP server card, every one of them a 500 with an empty body
 * and an `ERR_OSSL_ASN1_WRONG_TAG` in the logs. The contract an agent reads first
 * was unreachable while the site's own pages answered perfectly, so the failure
 * looked like nothing at all from the outside.
 *
 * So the shape is: build every plausible reading of the value, return the first
 * one that parses, and REPORT the reason when none does. A misconfigured key
 * degrades a signature (visible, checkable, and reported by the verifier). It
 * never takes the document down, because an unsigned document is worth more than
 * an unreachable one.
 */
type KeyRead = { ok: true; key: KeyObject } | { ok: false; reason: string };

function readPrivateKey(): KeyRead {
  const raw = process.env.MCP_REGISTRY_PRIVATE_KEY;
  if (!raw || !raw.trim()) {
    return { ok: false, reason: "MCP_REGISTRY_PRIVATE_KEY is not set, so this deployment serves unsigned artifacts." };
  }
  const text = raw.trim();
  const attempts: { what: string; make: () => KeyObject }[] = [];
  const asPem = (pem: string, what: string) =>
    attempts.push({ what, make: () => createPrivateKey({ key: pem, format: "pem" }) });
  const asSeed = (seed: Buffer, what: string) =>
    attempts.push({
      what,
      make: () => createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" }),
    });
  const asDer = (der: Buffer, what: string) =>
    attempts.push({ what, make: () => createPrivateKey({ key: der, format: "der", type: "pkcs8" }) });

  // 1. A JWK object, which is what a browser tool or the registry CLI hands out.
  if (text.startsWith("{")) {
    attempts.push({
      what: "a JWK object",
      make: () => {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const inner = (parsed.privateKey ?? parsed.private_key ?? parsed) as Record<string, unknown>;
        return createPrivateKey({ key: inner as JsonWebKey, format: "jwk" });
      },
    });
  }

  // 2. PEM, whole or with its newlines escaped into literal backslash-n.
  for (const [what, pem] of [
    ["PEM", text],
    ["PEM with escaped newlines", unescapePem(text)],
    ["PEM wrapped in quotes", unescapePem(text.replace(/^["']|[\"']$/g, ""))],
  ] as [string, string][]) {
    if (pem.includes("BEGIN")) asPem(pem, what);
  }

  // 3. Base64, base64url and hex of whatever the operator encoded. A base64 decoder
  //    in node reads both alphabets and ignores padding, so one branch covers them.
  const packed: { what: string; bytes: Buffer }[] = [];
  if (/^[A-Za-z0-9+/\-_=]+$/.test(text)) packed.push({ what: "base64", bytes: Buffer.from(text, "base64") });
  if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0) {
    packed.push({ what: "hex", bytes: Buffer.from(text, "hex") });
  }
  for (const { what, bytes } of packed) {
    if (bytes.length === 0) continue;
    // Base64 of the PEM TEXT rather than of the DER: the BEGIN line survives.
    if (bytes.subarray(0, 32).toString("utf8").includes("BEGIN")) {
      asPem(unescapePem(bytes.toString("utf8")), `base64 of ${what === "hex" ? "a hex" : "a"} PEM`);
    }
    if (bytes.length === 32) asSeed(bytes, `${what} of the raw 32-byte seed`);
    // libsodium's shape: the seed with its public half appended.
    if (bytes.length === 64) asSeed(bytes.subarray(0, 32), `${what} of a seed with its public half appended`);
    asDer(bytes, `${what} of a PKCS8 DER`);
  }

  const reasons: string[] = [];
  for (const attempt of attempts) {
    try {
      return { ok: true, key: attempt.make() };
    } catch (e) {
      reasons.push(`${attempt.what}: ${e instanceof Error ? e.message : "failed"}`);
    }
  }
  return {
    ok: false,
    reason: raw.trim()
      ? `MCP_REGISTRY_PRIVATE_KEY could not be read in any known form (${attempts.length} attempt(s) tried). ${reasons.slice(0, 3).join("; ")}`
      : "MCP_REGISTRY_PRIVATE_KEY is empty, so this deployment serves unsigned artifacts.",
  };
}

function privateKey(): KeyObject {
  const read = readPrivateKey();
  if (!read.ok) throw new Error(read.reason);
  return read.key;
}

function publicKeyObject(): KeyObject {
  const raw = signingPublicKeyRaw();
  if (raw) {
    // The env var holds the raw 32-byte public key, base64 or base64url.
    const bytes = Buffer.from(raw, "base64");
    if (bytes.length === 32) return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, bytes]), format: "der", type: "spki" });
  }
  // Fall back to deriving it from the private half, so a deployment that set
  // only MCP_REGISTRY_PRIVATE_KEY still serves a working JWKS.
  return createPublicKey(privateKey());
}

/**
 * What this deployment can actually do, said out loud.
 *
 * `broken` is the state that used to be indistinguishable from `signed` until a
 * request arrived, which is why it is a named state rather than an exception.
 */
export function signingStatus(): { state: "signed" | "unsigned" | "broken"; reason: string } {
  if (!signingConfigured()) {
    return { state: "unsigned", reason: "No signing key is configured on this deployment, so artifacts are served unsigned and say so." };
  }
  const read = readPrivateKey();
  return read.ok
    ? { state: "signed", reason: `Signing with ${SIGNING_KEY_ID}.` }
    : { state: "broken", reason: read.reason };
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
  try {
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
  } catch (e) {
    // A key this deployment cannot read is a signature it cannot make. The
    // document still has to answer: a 500 here takes the agent contract off the
    // internet, which is a much larger failure than an unsigned document. The
    // reason goes to the logs and to the response headers, so a misconfiguration
    // is still visible from outside rather than silently swallowed.
    const reason = e instanceof Error ? e.message : "the signing key could not be read";
    console.warn(`discovery signing skipped for ${urlPath}: ${reason}`);
    return { [SIGNATURE_STATUS_HEADER]: `unsigned: ${reason.slice(0, 300)}` };
  }
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
  const raw =
    signingPublicKeyRaw() ||
    (() => {
      try {
        const spki = publicKeyObject().export({ format: "der", type: "spki" }) as Buffer;
        return spki.subarray(spki.length - 32).toString("base64url");
      } catch {
        // Neither half is readable. An empty key set is the truthful answer, and
        // it makes the verifier say a key is advertised with nothing behind it
        // rather than failing the whole document with a 500.
        return "";
      }
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
