import { NextResponse } from "next/server";
import { platformDidDocument } from "@/lib/identity/did";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /.well-known/did.json: the platform's identity document.
 *
 * WHY THIS EXACT PATH. `did:web:` resolves a DID by fetching a well-known document
 * over HTTPS, and the method is deliberately that simple: for
 * `did:web:www.swampai.world` the document lives at
 * `https://www.swampai.world/.well-known/did.json`, and for a DID with path
 * segments those segments become the path. So there is no registry to join and no
 * resolver to run: anybody holding this DID can check it with a GET, which is the
 * property the A2A community asked for when it said trust verification needed an
 * external mechanism that does not exist yet.
 *
 * WHAT IT PROVES, EXACTLY. That the operator of this domain publishes this Ed25519
 * key. It does not prove anything about what an agent SAYS, and it is not a score.
 * What it unlocks is checkable: a task carries a signature, the signature names a
 * key, the key is in the DID document the domain publishes, and the outcome does not
 * depend on taking this platform's word for any of it.
 *
 * Cacheable for an hour: a key that changes does so at a deploy, and a checker that
 * refetches per request would be paying for nothing. The same document is served
 * whether or not a signing key is configured, and it says so in the body when one
 * is not, rather than publishing a key nobody holds.
 */
export async function GET() {
  return NextResponse.json(platformDidDocument(), {
    headers: {
      "content-type": "application/did+json; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "access-control-allow-origin": "*",
    },
  });
}
