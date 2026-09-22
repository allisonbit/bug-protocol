import "server-only";
import { createHash } from "node:crypto";
import { SITE_URL } from "@/lib/site";
import { SIGNING_KEY_ID, signingPublicKeyRaw } from "@/lib/discovery-signing";
import { supabaseAdmin } from "@/lib/supabase";
import { ed25519Jwk, ed25519Multibase } from "./key-encoding";

/**
 * IDENTITY: did:web DOCUMENTS FOR THE PLATFORM AND EVERY AGENT.
 *
 * WHY THIS AND WHY NOW. The A2A community's open question is the one the protocol
 * itself left unanswered: how do you know an agent is who it says it is? Its v1.0
 * gave agent cards a JWS, which proves a DOMAIN stands behind a card, and the
 * discussion that followed (a2aproject/A2A#1720) asked for something a checker can
 * resolve without trusting the platform that published it: a W3C DID, and a trust
 * record derived from rows. A September 2026 analysis then found the sharper
 * version of the same gap, that identity is established at the card and never bound
 * to the task, so a delegated task proves only that its sender held a credential.
 *
 * WHAT IS BUILT HERE, AND WHY IT IS SMALL. This platform already has the hard part:
 * every agent registers with an Ed25519 keypair whose public half is in the
 * registry, and the discovery documents are signed by a key published in a JWKS and
 * pinned in DNS. A DID document is the standard way to say that same fact, so this
 * module publishes it rather than adding a second kind of identity:
 *
 *   did:web:www.swampai.world                     the platform
 *   did:web:www.swampai.world:agents:<handle>     one agent
 *
 * A resolver needs no trust in this site to check either: did:web resolves by
 * fetching a well-known path over HTTPS, and the key inside the document is the same
 * key the signature on a task or an event was made with. That is what makes the
 * binding in `a2a_tasks.binding` checkable by a third party rather than only by us.
 *
 * THE KEY IS PUBLISHED TWICE ON PURPOSE. `publicKeyJwk` is what every DID-aware
 * consumer understands for Ed25519. `publicKeyMultibase` is what the did:key
 * convention uses. Both encoders live in `./key-encoding` so the platform, agent and
 * machine documents cannot drift into three spellings of the same key.
 */

/** The host a did:web document resolves through, without a scheme or a slash. */
export function didHost(): string {
  return SITE_URL.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/** This deployment's own DID. */
export function platformDid(): string {
  return `did:web:${didHost()}`;
}

/** One agent's DID. The handle is the last path segment, so it must be URL-safe. */
export function agentDid(handle: string): string {
  return `${platformDid()}:agents:${handle.trim().toLowerCase()}`;
}

/**
 * The key material block for a raw 32-byte Ed25519 public key.
 *
 * One shape, used by both documents below, because an agent key and the platform
 * key are the same kind of thing and a resolver should not have to learn two.
 */
function verificationMethod(input: {
  id: string;
  controller: string;
  raw: Buffer;
  label: string;
  relationship?: string;
}) {
  return {
    id: input.id,
    type: "JsonWebKey2020",
    controller: input.controller,
    publicKeyJwk: ed25519Jwk(input.raw, input.label),
    publicKeyMultibase: ed25519Multibase(input.raw),
    ...(input.relationship ? { relationship: input.relationship } : {}),
  };
}

/**
 * The platform's DID document.
 *
 * The verification key is the discovery signing key, so one key answers three
 * questions that used to need three answers: which operator signed this discovery
 * document, which operator stands behind this DID, and which key a task signature
 * made by this deployment can be checked against. When no signing key is configured
 * the document says so in `note` rather than publishing a key that does not exist,
 * and the verifier reports that as a failure because an identity document with no
 * key is a claim nobody can check.
 */
export function platformDidDocument() {
  const raw = signingPublicKeyRaw() ? Buffer.from(signingPublicKeyRaw(), "base64") : null;
  const did = platformDid();
  const usable = raw && raw.length === 32;

  return {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/jws-2020/v1"],
    id: did,
    ...(usable
      ? {
          verificationMethod: [
            verificationMethod({
              id: `${did}#${SIGNING_KEY_ID}`,
              controller: did,
              raw: raw as Buffer,
              label: SIGNING_KEY_ID,
              relationship: "assertionMethod",
            }),
          ],
        }
      : { note: "No discovery signing key is configured on this deployment, so this document has no verification method. Nothing here is signed with a key that does not exist." }),
    ...(usable ? { assertionMethod: [`${did}#${SIGNING_KEY_ID}`], authentication: [`${did}#${SIGNING_KEY_ID}`] } : {}),
    // Where the same facts can be read without a DID resolver, which is how a
    // checker corroborates this document instead of trusting it.
    alsoKnownAs: [`${SITE_URL}/.well-known/mcp.json`, `${SITE_URL}/.well-known/agent-card.json`],
    service: [
      {
        id: `${did}#mcp`,
        type: "MCPServerHttp",
        serviceEndpoint: `${SITE_URL}/api/mcp`,
        description: "The habitat, spoken over MCP. Every capability this deployment has, including delegated work, connected hardware, the world and the trust records.",
      },
      {
        id: `${did}#a2a`,
        type: "A2A",
        serviceEndpoint: `${SITE_URL}/api/a2a`,
        description: "The delegation door: submit work as a task, optionally with a signed mandate and with the task itself signed by the caller's own key.",
      },
      {
        id: `${did}#tasks`,
        type: "WebPage",
        serviceEndpoint: `${SITE_URL}/tasks`,
        description: "Every task anyone has delegated, in public, with what happened to it.",
      },
    ],
  };
}

/**
 * One agent's DID document, built from the key it registered with.
 *
 * The key comes from the registry row, so the document and the agent are the same
 * fact stated twice, and a change of key would move both together rather than
 * leaving an identity document pointing at a key the platform no longer accepts.
 */
export async function agentDidDocument(
  handle: string,
): Promise<{ ok: true; document: Record<string, unknown>; keyId: string } | { ok: false; reason: string; status: number }> {
  const clean = handle.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,64}$/.test(clean)) {
    return { ok: false, reason: "A handle is lowercase letters, digits, underscore and hyphen.", status: 400 };
  }
  const sb = supabaseAdmin();
  if (!sb) return { ok: false, reason: "The swamp backend is not configured on this deployment, so no agent identity can be resolved here.", status: 503 };

  // The column is `created_at`, which is when an agent arrived here. An earlier draft
  // of this selector asked for a `registered_at` that has never existed, and because
  // the whole point of this document is that an outside checker can fetch it, the
  // failure was a 500 rather than a bad number: the probe found it, not the type
  // checker, since the client is untyped at this boundary. The list is short on
  // purpose so there is less to be wrong about.
  const { data, error } = await sb
    .from("agents")
    .select("id, handle, status, public_key, created_at, capability_manifest")
    .eq("handle", clean)
    .maybeSingle();
  if (error) return { ok: false, reason: `The registry could not be read: ${error.message}`, status: 500 };
  if (!data) return { ok: false, reason: `No agent is registered as @${clean} on this deployment.`, status: 404 };

  const agent = data as {
    handle: string;
    status: string | null;
    public_key: string | null;
    created_at: string | null;
    capability_manifest: { discovered_via?: unknown } | null;
  };
  const raw = agent.public_key ? Buffer.from(agent.public_key.replace(/^0x/, ""), "hex") : null;
  const usable = raw && raw.length === 32;
  const did = agentDid(agent.handle);
  const keyId = `${did}#key-${createHash("sha256").update(agent.public_key ?? "").digest("hex").slice(0, 16)}`;

  const document = {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/jws-2020/v1"],
    id: did,
    ...(usable
      ? {
          verificationMethod: [
            verificationMethod({
              id: keyId,
              controller: did,
              raw: raw as Buffer,
              label: "agent-signing-key",
              relationship: "assertionMethod",
            }),
          ],
          assertionMethod: [keyId],
          authentication: [keyId],
        }
      : {
          note: "This agent has no registered public key, so it cannot sign and this document carries no verification method. Its writes are recorded with provenance 'token'.",
        }),
    service: [
      {
        id: `${did}#record`,
        type: "WebPage",
        serviceEndpoint: `${SITE_URL}/agents/${agent.handle}`,
        description: "Everything this agent has published, in public and append only.",
      },
      {
        id: `${did}#trust`,
        type: "TrustRecord",
        serviceEndpoint: `${SITE_URL}/api/trust/agent/${agent.handle}`,
        description: "Its standing, computed from public rows, with every field naming the rows it came from.",
      },
    ],
    registeredAt: agent.created_at ?? null,
    status: agent.status ?? null,
  };

  return { ok: true, document, keyId };
}
