import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import {
  callerHash,
  oauthConfigured,
  oauthError,
  redirectUriAllowed,
  registerClient,
  throttleClientRegistration,
} from "@/lib/oauth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /oauth/register — dynamic client registration (RFC 7591).
 *
 * The handshake has to start somewhere, and an MCP client that has just been
 * handed a URL has no other way to obtain a client id. So this endpoint is open,
 * which makes it the one place here a stranger could fill a table with rows.
 *
 * WHAT IS ACCEPTED. `redirect_uris` is required and each one is checked: https, or
 * a loopback address, or a native client's custom scheme. Nothing else — a code
 * sent to an http origin that is not this machine could be read off the wire, and
 * an unchecked redirect_uri is the classic open redirect an authorization server
 * gets blamed for. Empty addresses, fragments and non-URLs are refused by name so
 * a client author can see which entry was the problem.
 *
 * WHAT IS NOT ACCEPTED. No scope reaches the client: this server issues one scope
 * and a client cannot ask for more. No registration of an existing agent, no
 * claims, no logo, no policy URI — none of it would be read by anything here, and
 * accepting a field that is ignored is a quiet lie about what was agreed.
 *
 * It is throttled per caller against a salted hash of the address: the count is
 * kept, the address never is, the same rule registration for agents follows.
 */
type RegistrationBody = {
  client_name?: unknown;
  redirect_uris?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  token_endpoint_auth_method?: unknown;
  scope?: unknown;
  software_id?: unknown;
};

export async function POST(req: Request) {
  if (!oauthConfigured()) {
    const { status, body } = oauthError(
      "server_error",
      "This deployment has no backend configured, so it cannot issue client credentials.",
      503,
    );
    return NextResponse.json(body, { status });
  }
  const sb = supabaseAdmin();
  if (!sb) {
    const { status, body } = oauthError("server_error", "This deployment cannot register clients.", 503);
    return NextResponse.json(body, { status });
  }

  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") {
    const { status, body } = oauthError("invalid_client_metadata", "Send a JSON body with `redirect_uris`.", 400);
    return NextResponse.json(body, { status });
  }
  const input = raw as RegistrationBody;

  const uris = Array.isArray(input.redirect_uris)
    ? input.redirect_uris.map((u) => String(u).trim()).filter(Boolean)
    : [];
  if (uris.length === 0) {
    const { status, body } = oauthError(
      "invalid_redirect_uri",
      "At least one redirect_uri is required. It is where the authorization code is sent, and it is matched exactly.",
      400,
    );
    return NextResponse.json(body, { status });
  }
  if (uris.length > 10) {
    const { status, body } = oauthError("invalid_redirect_uri", "At most 10 redirect_uris are accepted.", 400);
    return NextResponse.json(body, { status });
  }
  const refused = uris.filter((u) => !redirectUriAllowed(u));
  if (refused.length > 0) {
    const { status, body } = oauthError(
      "invalid_redirect_uri",
      "A redirect_uri must be https, or an http loopback address (localhost, 127.0.0.1, [::1]), or a native client's own custom scheme. Refused: " +
        refused.join(", "),
      400,
    );
    return NextResponse.json(body, { status });
  }

  const throttle = await throttleClientRegistration(sb, callerHash(req));
  if (!throttle.ok) {
    const { body } = oauthError(
      "temporarily_unavailable",
      "Too many client registrations from here in the last hour. Registration is open, and it is also not a way to obtain a fresh identity to work around a failing call.",
      429,
    );
    return NextResponse.json(body, {
      status: 429,
      headers: { "retry-after": String(throttle.retryAfterSeconds) },
    });
  }

  const name = String(input.client_name ?? "").trim().slice(0, 120) || null;

  try {
    const client = await registerClient(sb, { clientName: name, redirectUris: uris });
    return NextResponse.json(
      {
        client_id: client.client_id,
        // Public client: no secret is issued, and PKCE is the proof instead.
        token_endpoint_auth_method: "none",
        client_name: client.client_name,
        redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "agent",
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    const { status, body } = oauthError(
      "server_error",
      e instanceof Error ? e.message : "The client could not be registered.",
      500,
    );
    return NextResponse.json(body, { status });
  }
}

/**
 * A GET is a person or a probe looking at the endpoint, not a client registering.
 * Answering with the contract costs nothing and is better than a bare 405, which
 * reads as "broken" to whoever is trying to find out how to connect.
 */
export function GET() {
  return NextResponse.json(
    {
      endpoint: "Dynamic client registration (RFC 7591)",
      method: "POST",
      body: {
        client_name: "your client's name",
        redirect_uris: ["https://your-client.example/callback"],
      },
      note:
        "redirect_uris must be https, an http loopback address, or a custom scheme. No client secret is issued: every client here is public and proves itself with PKCE. You do not need this endpoint if you already hold an agent API token — send it as X-Agent-Token.",
      authorization_server_metadata: "/.well-known/oauth-authorization-server",
      protected_resource_metadata: "/.well-known/oauth-protected-resource",
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
