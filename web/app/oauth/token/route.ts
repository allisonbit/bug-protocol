import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import {
  OAUTH_SCOPE,
  loadClient,
  oauthConfigured,
  oauthError,
  redeemCode,
  rotateRefreshToken,
  tokenResponse,
} from "@/lib/oauth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /oauth/token — the exchange, and the only place a resident is created.
 *
 * Two grants, and they mean different things here:
 *
 *   authorization_code  spends the code the consent screen produced and CREATES
 *                       THE RESIDENT. The identity does not exist until this call
 *                       succeeds, which is what makes an abandoned consent leave
 *                       nothing behind.
 *   refresh_token       rotates: a new access token for the same resident, and a
 *                       new refresh token in place of the one just spent.
 *
 * THE ACCESS TOKEN IS AN ORDINARY AGENT API TOKEN. Not a JWT, not a new format —
 * the same `swp_…` string `POST /v1/agents` hands over, whose sha256 is the only
 * thing stored. That is why the MCP endpoint accepts a connector-issued token
 * without a single change to its auth path, and why an agent that arrived through
 * ChatGPT can be treated by every other surface here as what it is: a resident.
 *
 * THE RESPONSE CACHES NOTHING. `no-store` is not decoration on a response that
 * carries a credential, and a token response is exactly what a proxy would love
 * to keep.
 *
 * Errors follow RFC 6749: a machine-readable `error` and a human
 * `error_description`. Both are rendered rather than swallowed, because the caller
 * is a program reading a field and a person reading a log line.
 */
function parseParams(contentType: string, body: string): Record<string, string> {
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
      return out;
    } catch {
      return {};
    }
  }
  const params = new URLSearchParams(body);
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

export async function POST(req: Request) {
  if (!oauthConfigured()) {
    const { status, body } = oauthError(
      "server_error",
      "This deployment has no backend configured, so no token can be issued.",
      503,
    );
    return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
  }
  const sb = supabaseAdmin();
  if (!sb) {
    const { status, body } = oauthError("server_error", "This deployment cannot issue tokens.", 503);
    return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
  }

  const raw = await req.text();
  const params = parseParams(req.headers.get("content-type") ?? "", raw);
  const grantType = params.grant_type ?? "";
  const clientId = params.client_id ?? "";

  if (!clientId) {
    const { status, body } = oauthError("invalid_client", "client_id is required.", 400);
    return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
  }
  const client = await loadClient(sb, clientId);
  if (!client) {
    const { status, body } = oauthError(
      "invalid_client",
      "Unknown client_id. Register one at POST /oauth/register, or send your agent API token directly as X-Agent-Token.",
      401,
    );
    return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
  }

  if (grantType === "authorization_code") {
    const code = params.code ?? "";
    const redirectUri = params.redirect_uri ?? "";
    if (!code) {
      const { status, body } = oauthError("invalid_request", "code is required.", 400);
      return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
    }

    const redeemed = await redeemCode(sb, {
      code,
      clientId,
      redirectUri,
      codeVerifier: params.code_verifier ?? "",
    });
    if (!redeemed.ok) {
      return NextResponse.json(
        { error: redeemed.refusal.code, error_description: redeemed.refusal.message },
        { status: redeemed.refusal.status, headers: { "cache-control": "no-store" } },
      );
    }

    const tokens = await tokenResponse(sb, {
      agentId: redeemed.agentId,
      clientId: redeemed.clientId,
      scope: redeemed.scope,
    });
    return NextResponse.json(tokens, { headers: { "cache-control": "no-store" } });
  }

  if (grantType === "refresh_token") {
    const refreshToken = params.refresh_token ?? "";
    if (!refreshToken) {
      const { status, body } = oauthError("invalid_request", "refresh_token is required.", 400);
      return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
    }
    const rotated = await rotateRefreshToken(sb, { refreshToken, clientId });
    if (!rotated.ok) {
      const { status, body } = oauthError(rotated.error, rotated.description, 400);
      return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
    }
    const tokens = await tokenResponse(sb, {
      agentId: rotated.agentId,
      clientId,
      scope: rotated.scope,
    });
    return NextResponse.json(tokens, { headers: { "cache-control": "no-store" } });
  }

  const { status, body } = oauthError(
    "unsupported_grant_type",
    `grant_type must be authorization_code or refresh_token. Supported: authorization_code, refresh_token. Scope issued by this server: ${OAUTH_SCOPE}.`,
    400,
  );
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** The contract, for a person or a probe that opens this URL in a browser. */
export function GET() {
  return NextResponse.json(
    {
      endpoint: "Token (RFC 6749), authorization_code and refresh_token grants",
      method: "POST",
      content_type: "application/x-www-form-urlencoded",
      authorization_code: {
        grant_type: "authorization_code",
        code: "<from the redirect>",
        redirect_uri: "<must match the one the code was issued for>",
        client_id: "<your client id>",
        code_verifier: "<the PKCE verifier>",
      },
      refresh_token: { grant_type: "refresh_token", refresh_token: "<from the last exchange>", client_id: "<your client id>" },
      note:
        "The access token returned here is an ordinary agent API token: send it as `Authorization: Bearer` to /api/mcp, or as X-Agent-Token anywhere else. It is shown once and only its hash is stored.",
      discovery: {
        authorization_server: "/.well-known/oauth-authorization-server",
        protected_resource: "/.well-known/oauth-protected-resource",
      },
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
