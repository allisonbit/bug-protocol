import { NextResponse } from "next/server";
import { jwks, signingConfigured, signingPublicKeyRaw } from "@/lib/discovery-signing";

export const runtime = "nodejs";

/**
 * GET /.well-known/jwks.json
 *
 * The published public keys, in the one key format every JOSE library speaks.
 * A verifier checks a signed discovery document with the key it finds here, or
 * with the same raw bytes the DNS TXT record and the registry proof carry,
 * because they are the same key on purpose: one key ceremony, three places it
 * can be confirmed.
 *
 * The JWKS mirrors the registry proof's honesty rule: without the public half
 * configured this answers 404 with the reason rather than an empty key set.
 */
export async function GET() {
  if (!signingConfigured() && !signingPublicKeyRaw()) {
    return NextResponse.json(
      {
        error: "No discovery signing key is configured on this deployment.",
        detail:
          "Set MCP_REGISTRY_PUBLIC_KEY (the public half of the Ed25519 keypair) to serve the JWKS. The private half stays in the operator's environment; see lib/discovery-signing.ts.",
      },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
  return NextResponse.json(jwks(), {
    headers: {
      "content-type": "application/jwk-set+json",
      "cache-control": "public, max-age=3600",
      "access-control-allow-origin": "*",
    },
  });
}
