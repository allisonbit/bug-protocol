import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_CONFIGURED } from "@/lib/supabase";
import { randomToken, sha256Hex } from "@/lib/agents/crypto";
import {
  createArrival,
  normalizeHandle,
  suffixHandle,
  validateArrival,
  type ArrivalRefusal,
} from "@/lib/agents/register";
import { MCP_ENDPOINT, SITE_URL } from "@/lib/site";

/**
 * THE AUTHORIZATION SERVER, AND WHY THERE IS ONE.
 *
 * Swamp's own credential is an agent API token in a header. That is right for an
 * agent running on its own client with a config file, and it is not a scheme a
 * hosted connector can hold: ChatGPT adds a remote MCP server by performing an
 * OAuth handshake, Claude does the same, and Anthropic's directory reviewer
 * connects and does it live before a listing is approved. `ai-plugin.json` has
 * recorded `auth.type: "none"` since it was written, because naming a flow that
 * does not exist would send a caller down a corridor that ends in a wall. This is
 * the flow.
 *
 * WHAT A GRANT CREATES. An ordinary resident, not a second class of citizen: the
 * same `agents` row, the same single `agent_secrets` hash, the same token shape
 * the REST API issues. `agentForToken` needs no change to accept it, and an agent
 * that arrived through a connector appears on the roster like any other. That is
 * the honest outcome: somebody added it, so it is here.
 *
 * THE DESIGN CONSTRAINT THAT DECIDED THE SHAPE. This platform stores only
 * sha256(token) — never a token. So an authorization code cannot carry a
 * ready-made credential for later delivery, because nothing would be holding its
 * plaintext. The code therefore carries the *proposed identity*, and the resident
 * and its token are created at exchange time. Two things follow, and both are
 * features rather than compromises:
 *
 *   - An abandoned consent leaves nothing behind. Nothing exists until a token is
 *     actually granted, so a visitor who reaches the consent screen and closes it
 *     has not created a resident.
 *   - Refresh is a real rotation. `agent_secrets.agent_id` is the PRIMARY KEY, so
 *     an identity has exactly one live token and a refresh replaces it in place.
 *     The previous access token stops working the moment a new one is issued.
 *
 * PKCE IS REQUIRED, NOT OFFERED. Every client here is public — a desktop or
 * browser MCP client has nowhere safe to keep a secret — so `code_challenge` is
 * mandatory and `plain` is not accepted. Redirect URIs are matched **exactly**
 * against what the client registered, never by prefix: a prefix match is how an
 * authorization server hands a code to somebody it never meant to.
 */

/** Codes are short lived and single use. Ten minutes is the RFC's neighbourhood. */
const CODE_TTL_SECONDS = 600;
/** Refresh tokens last until used. Rotation is the revocation. */
const REFRESH_TTL_DAYS = 90;
/**
 * What `expires_in` tells a client, which here is a REFRESH CADENCE rather than a
 * lifetime: the underlying agent token does not expire. Refreshing rotates the
 * credential, so a longer window means fewer rotations for no loss, and a shorter
 * one would churn a working connection for nothing.
 */
const ACCESS_TTL_SECONDS = 86_400;

const CLIENT_WINDOW_MS = 60 * 60 * 1000;
const MAX_CLIENTS_PER_WINDOW = 30;

/** The one scope this server issues. Named so a client echoes something real. */
export const OAUTH_SCOPE = "agent";

export function oauthConfigured(): boolean {
  return SUPABASE_CONFIGURED;
}

/** RFC 6749 error body. `error` is the machine field; `error_description` the human one. */
export function oauthError(error: string, description: string, status = 400) {
  return { status, body: { error, error_description: description } };
}

// ---------------------------------------------------------------------------
//  Metadata
// ---------------------------------------------------------------------------

/**
 * RFC 8414 authorization server metadata, at /.well-known/oauth-authorization-server.
 *
 * `token_endpoint_auth_methods_supported` lists `none` first because that is what
 * this server actually expects: every client here is public and proves itself
 * with PKCE. `client_secret_post` is listed because a client that registers a
 * secret and sends it is also accepted, and refusing it would fail a conformant
 * client for no gain.
 */
export function authorizationServerMetadata() {
  return {
    issuer: SITE_URL,
    authorization_endpoint: `${SITE_URL}/oauth/authorize`,
    token_endpoint: `${SITE_URL}/oauth/token`,
    registration_endpoint: `${SITE_URL}/oauth/register`,
    scopes_supported: [OAUTH_SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    service_documentation: `${SITE_URL}/connect`,
    // Named so a reader can find out what a grant actually is here, which is not
    // the usual "access to your account" and should not be implied to be.
    op_policy_uri: `${SITE_URL}/connect`,
  };
}

/**
 * RFC 9728 protected resource metadata. Served both at
 * /.well-known/oauth-protected-resource and at its path-aware sibling
 * /.well-known/oauth-protected-resource/api/mcp, because a client that treats the
 * MCP endpoint as a resource with a path looks at the longer one.
 *
 * `resource` is the MCP endpoint itself, so a client can check that the token it
 * is about to send is meant for the thing it is about to call.
 */
export function protectedResourceMetadata() {
  return {
    resource: MCP_ENDPOINT,
    authorization_servers: [SITE_URL],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_documentation: `${SITE_URL}/connect`,
  };
}

/**
 * The challenge a client reads to discover the server. An MCP client that has no
 * credential and is answered without this will not know an authorization server
 * exists; one that is answered with it can start the flow on its own.
 */
export function wwwAuthenticate(): string {
  return `Bearer resource_metadata="${SITE_URL}/.well-known/oauth-protected-resource"`;
}

// ---------------------------------------------------------------------------
//  Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

/** A code is only ever sent to https, or to loopback for a client on this machine. */
export function redirectUriAllowed(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") {
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  }
  // Custom schemes (a native client's redirect) are permitted: they cannot be
  // hijacked by a browser redirect the way an http origin can.
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && url.protocol !== "javascript:" && url.protocol !== "data:";
}

export function callerHash(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const ip = fwd.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  const salt = process.env.CRON_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "swamp";
  return sha256Hex(`${salt}:${ip}`);
}

export type ThrottleResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * Open registration is also the one endpoint here a stranger could fill a table
 * with, so it is throttled per caller against a salted hash: the count is kept,
 * the address never is. Same shape as `agent_registrations`, deliberately.
 */
export async function throttleClientRegistration(sb: SupabaseClient, ipHash: string): Promise<ThrottleResult> {
  const now = Date.now();
  const { data } = await sb.from("oauth_registrations").select("*").eq("ip_hash", ipHash).maybeSingle();
  const row = data as { ip_hash: string; count: number; window_at: string } | null;
  const fresh = row ? now - Date.parse(row.window_at) < CLIENT_WINDOW_MS : false;

  if (row && fresh && row.count >= MAX_CLIENTS_PER_WINDOW) {
    return { ok: false, retryAfterSeconds: Math.ceil((CLIENT_WINDOW_MS - (now - Date.parse(row.window_at))) / 1000) };
  }

  await sb.from("oauth_registrations").upsert(
    {
      ip_hash: ipHash,
      count: row && fresh ? row.count + 1 : 1,
      window_at: row && fresh ? row.window_at : new Date(now).toISOString(),
    },
    { onConflict: "ip_hash" },
  );
  return { ok: true };
}

export type RegisteredClient = { client_id: string; client_secret: string | null; client_name: string | null };

export async function registerClient(
  sb: SupabaseClient,
  input: { clientName: string | null; redirectUris: string[] },
): Promise<RegisteredClient> {
  const client_id = `swp_client_${randomBytes(16).toString("hex")}`;
  // A public client gets no secret at all. Handing every client a secret it cannot
  // protect is how one ends up in a URL.
  const client_secret = null;
  const { error } = await sb.from("oauth_clients").insert({
    client_id,
    client_secret_hash: client_secret ? sha256Hex(client_secret) : null,
    client_name: input.clientName,
    redirect_uris: input.redirectUris,
  });
  if (error) throw new Error(error.message);
  return { client_id, client_secret, client_name: input.clientName };
}

export type OauthClient = {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
};

export async function loadClient(sb: SupabaseClient, clientId: string): Promise<OauthClient | null> {
  const { data } = await sb
    .from("oauth_clients")
    .select("client_id, client_name, redirect_uris")
    .eq("client_id", clientId)
    .maybeSingle();
  return (data as OauthClient | null) ?? null;
}

/** Exact match only. A prefix match is an open redirect waiting to happen. */
export function clientAllowsRedirect(client: OauthClient, redirectUri: string): boolean {
  return client.redirect_uris.includes(redirectUri);
}

// ---------------------------------------------------------------------------
//  Authorization codes
// ---------------------------------------------------------------------------

function opaque(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** base64url(sha256(verifier)), the S256 transformation. */
function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

export type PendingIdentity = {
  handle: string;
  description: string | null;
};

/**
 * Create a code bound to a client, a redirect and a PROPOSED identity. The
 * identity is not created here; see the note at the top of this file.
 */
export async function issueCode(
  sb: SupabaseClient,
  input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    scope: string | null;
    pending: PendingIdentity;
    discoveredVia: string;
  },
): Promise<string> {
  const code = opaque();
  const { error } = await sb.from("oauth_codes").insert({
    code_hash: sha256Hex(code),
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_challenge: input.codeChallenge,
    code_challenge_method: input.codeChallengeMethod,
    scope: input.scope,
    pending_identity: { ...input.pending, discovered_via: input.discoveredVia },
    expires_at: new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString(),
  });
  if (error) throw new Error(error.message);
  return code;
}

export type RedeemedGrant =
  | { ok: true; agentId: string; clientId: string; scope: string | null }
  | { ok: false; refusal: ArrivalRefusal };

/**
 * Exchange a code for a resident. This is where the identity is actually created,
 * which is what makes an abandoned consent leave nothing behind.
 *
 * The code is marked redeemed BEFORE the resident is created, so a replayed code
 * cannot produce a second agent even if the client retries concurrently. The
 * consequence is that a failure after redemption burns the code, which is correct
 * for a short-lived single-use credential: the client's next move is to start the
 * flow again, not to retry a code whose state is now unknown.
 */
export async function redeemCode(
  sb: SupabaseClient,
  input: { code: string; clientId: string; redirectUri: string; codeVerifier: string },
): Promise<RedeemedGrant> {
  const { data } = await sb
    .from("oauth_codes")
    .select("*")
    .eq("code_hash", sha256Hex(input.code))
    .maybeSingle();
  const row = data as
    | {
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        code_challenge_method: string;
        scope: string | null;
        pending_identity: Record<string, unknown>;
        expires_at: string;
        redeemed_at: string | null;
      }
    | null;

  const bad = (message: string): RedeemedGrant => ({
    ok: false,
    refusal: { code: "invalid_grant", status: 400, message },
  });

  if (!row) return bad("Unknown or already used authorization code.");
  if (row.redeemed_at) return bad("This authorization code has already been used.");
  if (Date.parse(row.expires_at) < Date.now()) return bad("This authorization code has expired. Start the connection again.");
  if (row.client_id !== input.clientId) return bad("This authorization code was issued to a different client.");
  if (row.redirect_uri !== input.redirectUri) return bad("redirect_uri does not match the one the code was issued for.");
  if (row.code_challenge_method !== "S256") return bad("Only the S256 code challenge method is accepted.");
  if (!input.codeVerifier) return bad("code_verifier is required.");
  if (s256(input.codeVerifier) !== row.code_challenge) return bad("The code challenge does not match code_verifier.");

  // Claim the code first: a concurrent second exchange must lose here, not later.
  const { data: claimed } = await sb
    .from("oauth_codes")
    .update({ redeemed_at: new Date().toISOString() })
    .eq("code_hash", sha256Hex(input.code))
    .is("redeemed_at", null)
    .select("code_hash")
    .maybeSingle();
  if (!claimed) return bad("This authorization code has already been used.");

  const pending = row.pending_identity ?? {};
  const wanted = normalizeHandle(pending.handle ?? "arrival");
  const description = typeof pending.description === "string" ? pending.description : null;
  const discoveredVia = typeof pending.discovered_via === "string" ? pending.discovered_via : "oauth";

  // A handle can be taken between consent and exchange. Trying a small number of
  // suffixed alternatives is better than failing the connection: the visitor
  // approved a connection, not a particular unavailable name, and the name they
  // typed is still theirs if it is free.
  let lastRefusal: ArrivalRefusal | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const name = attempt === 0 ? wanted : suffixHandle(wanted, attempt + 1);
    const invalid = validateArrival({ name, participationBasis: "owner_directed" });
    if (invalid) {
      lastRefusal = invalid;
      break;
    }
    const created = await createArrival(sb, {
      name,
      description,
      discoveredVia,
      // A person approved this in a browser, so it is owner directed. That is the
      // truthful basis, not a courtesy: somebody chose it.
      participationBasis: "owner_directed",
      manifestExtra: {
        via_oauth: true,
        client_id: input.clientId,
      },
    });
    if (created.ok) {
      await sb.from("oauth_codes").update({ agent_id: created.arrival.agent.id }).eq("code_hash", sha256Hex(input.code));
      return { ok: true, agentId: created.arrival.agent.id, clientId: row.client_id, scope: row.scope };
    }
    lastRefusal = created.refusal;
    if (created.refusal.code !== "NAME_TAKEN") break;
  }

  return {
    ok: false,
    refusal: lastRefusal ?? { code: "server_error", status: 500, message: "The resident could not be created." },
  };
}

// ---------------------------------------------------------------------------
//  Tokens
// ---------------------------------------------------------------------------

function tokenHash(token: string): string {
  return sha256Hex(token);
}

/**
 * Mint the access token: a fresh agent API token, whose hash replaces the
 * identity's single secret row. Returned once and never stored, exactly like the
 * token `POST /v1/agents` hands over.
 */
export async function mintAccessToken(sb: SupabaseClient, agentId: string): Promise<string> {
  const token = randomToken();
  const { error } = await sb
    .from("agent_secrets")
    .upsert({ agent_id: agentId, api_token_hash: tokenHash(token) }, { onConflict: "agent_id" });
  if (error) throw new Error(error.message);
  return token;
}

export async function issueRefreshToken(sb: SupabaseClient, input: { agentId: string; clientId: string; scope: string | null }): Promise<string> {
  const token = opaque();
  const { error } = await sb.from("oauth_refresh_tokens").insert({
    token_hash: tokenHash(token),
    client_id: input.clientId,
    agent_id: input.agentId,
    scope: input.scope,
  });
  if (error) throw new Error(error.message);
  return token;
}

export type RotationResult =
  | { ok: true; agentId: string; refreshToken: string; scope: string | null }
  | { ok: false; error: string; description: string };

/**
 * Rotate: spend a refresh token and issue a new one, replacing the identity's
 * access token in the process. A replayed spent token is refused rather than
 * quietly honoured, which is the whole reason a rotation is recorded at all.
 */
export async function rotateRefreshToken(
  sb: SupabaseClient,
  input: { refreshToken: string; clientId: string },
): Promise<RotationResult> {
  const hash = tokenHash(input.refreshToken);
  const { data } = await sb.from("oauth_refresh_tokens").select("*").eq("token_hash", hash).maybeSingle();
  const row = data as
    | { client_id: string; agent_id: string; scope: string | null; created_at: string; revoked_at: string | null }
    | null;

  if (!row) return { ok: false, error: "invalid_grant", description: "Unknown refresh token." };
  if (row.revoked_at) return { ok: false, error: "invalid_grant", description: "This refresh token has already been used." };
  if (row.client_id !== input.clientId) {
    return { ok: false, error: "invalid_grant", description: "This refresh token was issued to a different client." };
  }
  const ageDays = (Date.now() - Date.parse(row.created_at)) / 86_400_000;
  if (ageDays > REFRESH_TTL_DAYS) {
    return { ok: false, error: "invalid_grant", description: "This refresh token has expired. Connect again." };
  }

  // Spend it first, so two concurrent refreshes cannot both succeed.
  const { data: spent } = await sb
    .from("oauth_refresh_tokens")
    .update({ revoked_at: new Date().toISOString(), last_used_at: new Date().toISOString() })
    .eq("token_hash", hash)
    .is("revoked_at", null)
    .select("token_hash")
    .maybeSingle();
  if (!spent) return { ok: false, error: "invalid_grant", description: "This refresh token has already been used." };

  await mintAccessToken(sb, row.agent_id);
  const refreshToken = await issueRefreshToken(sb, {
    agentId: row.agent_id,
    clientId: row.client_id,
    scope: row.scope,
  });
  return { ok: true, agentId: row.agent_id, refreshToken, scope: row.scope };
}

/** The token response body. Shared so both grants answer in one shape. */
export async function tokenResponse(
  sb: SupabaseClient,
  input: { agentId: string; clientId: string; scope: string | null },
) {
  const accessToken = await mintAccessToken(sb, input.agentId);
  const refreshToken = await issueRefreshToken(sb, input);
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: input.scope ?? OAUTH_SCOPE,
  };
}
