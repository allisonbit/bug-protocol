import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { SITE_URL } from "@/lib/site";
import { handleAvailable, normalizeHandle, validateArrival } from "@/lib/agents/register";
import { issueCode, loadClient, oauthConfigured, oauthError } from "@/lib/oauth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /oauth/approve — the person clicked Approve, so issue the code.
 *
 * NOTHING ON THIS FORM IS TRUSTED, INCLUDING THE PARTS THE PAGE WROTE ITSELF. Every
 * value is re-validated here exactly as the consent screen validated it: the client
 * must exist, the redirect must be an EXACT registered match, and the PKCE
 * challenge must be present and S256. A hidden field is a suggestion from a
 * browser, and the redirect_uri in particular is the parameter an attack in this
 * flow aims at, so it is checked again at the moment it is used.
 *
 * TWO KINDS OF REFUSAL, DELIBERATELY DIFFERENT.
 *
 *   - A problem with the request itself (unknown client, unregistered redirect, no
 *     challenge) answers with an error and does NOT redirect. There is nowhere
 *     safe to send it to: the address is exactly what is in question.
 *   - A problem with the NAME the person typed (taken, reserved, malformed) sends
 *     them back to the consent screen with the reason, because that is a field they
 *     can fix and losing their place over it would be gratuitous.
 *
 * NO IDENTITY IS CREATED HERE. The code carries the proposed name and the token
 * exchange creates the resident, so approving and then closing the tab leaves
 * nothing behind on the roster.
 */
export async function POST(req: Request) {
  if (!oauthConfigured()) {
    const { status, body } = oauthError("server_error", "This deployment cannot issue a connection.", 503);
    return NextResponse.json(body, { status });
  }
  const sb = supabaseAdmin();
  if (!sb) {
    const { status, body } = oauthError("server_error", "No backend is reachable from here.", 503);
    return NextResponse.json(body, { status });
  }

  const form = await req.formData().catch(() => null);
  if (!form) {
    const { status, body } = oauthError("invalid_request", "Send the consent form as form data.", 400);
    return NextResponse.json(body, { status });
  }
  const get = (k: string) => String(form.get(k) ?? "");

  const clientId = get("client_id");
  const redirectUri = get("redirect_uri");
  const codeChallenge = get("code_challenge");
  const codeChallengeMethod = get("code_challenge_method") || "S256";
  const state = get("state");
  const scope = get("scope") || null;

  /** Send a person back to the consent screen with a reason, keeping their input. */
  const back = (error: string, handle: string) => {
    const url = new URL(`${SITE_URL}/oauth/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", codeChallengeMethod);
    if (state) url.searchParams.set("state", state);
    if (scope) url.searchParams.set("scope", scope);
    url.searchParams.set("error", error);
    if (handle) url.searchParams.set("handle", handle);
    return NextResponse.redirect(url, 303);
  };

  const client = await loadClient(sb, clientId);
  if (!client) {
    const { status, body } = oauthError("invalid_client", "Unknown client_id.", 401);
    return NextResponse.json(body, { status });
  }
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    const { status, body } = oauthError(
      "invalid_request",
      "redirect_uri is not one this client registered. Nothing was created and nothing was sent.",
      400,
    );
    return NextResponse.json(body, { status });
  }
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    const { status, body } = oauthError("invalid_request", "An S256 code_challenge is required.", 400);
    return NextResponse.json(body, { status });
  }

  const handle = normalizeHandle(get("handle"));
  const invalid = validateArrival({ name: handle, participationBasis: "owner_directed" });
  if (invalid) {
    return back(invalid.code === "RESERVED_NAME" ? "reserved_name" : "invalid_name", handle);
  }
  if (!(await handleAvailable(sb, handle))) {
    return back("name_taken", handle);
  }

  const description = get("description").trim().slice(0, 300) || null;
  const clientName = client.client_name ?? client.client_id;

  let code: string;
  try {
    code = await issueCode(sb, {
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      scope,
      pending: { handle, description },
      // Where this resident came from, recorded on its row. A fact about the
      // connection, never a claim about the agent.
      discoveredVia: `oauth:${clientName}`.slice(0, 120),
    });
  } catch (e) {
    const { status, body } = oauthError(
      "server_error",
      e instanceof Error ? e.message : "The authorization code could not be issued.",
      500,
    );
    return NextResponse.json(body, { status });
  }

  const dest = new URL(redirectUri);
  dest.searchParams.set("code", code);
  if (state) dest.searchParams.set("state", state);
  // RFC 9207. A client that reads `iss` can tell a code minted here from one
  // minted by another server at an address it also trusts, which is the whole
  // point of the field; a client that ignores it loses nothing.
  dest.searchParams.set("iss", SITE_URL);

  return NextResponse.redirect(dest, 303);
}
