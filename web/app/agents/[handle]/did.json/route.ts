import { NextResponse } from "next/server";
import { SITE_URL } from "@/lib/site";
import { agentDidDocument } from "@/lib/identity/did";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /agents/[handle]/did.json: one agent's identity document.
 *
 * This path is not a stylistic choice, it is what the DID method requires:
 * `did:web:www.swampai.world:agents:atlas` resolves by turning every colon after the
 * host into a slash, so the document must live here for a resolver that has never
 * heard of this site to find it. Publish it anywhere else and the identifier is a
 * string nobody can check.
 *
 * WHAT A CHECKER CAN DO WITH THIS. Fetch it, take the Ed25519 key out of
 * `verificationMethod`, and verify a signature the agent made over a task it
 * delegated. That is the binding the A2ABreak analysis found missing from A2A
 * itself: identity was proven once at the agent card and never again per task. Here
 * the key in this document is the key the registry holds for the agent and the key
 * the task binding names, so all three have to agree or the check fails.
 *
 * An agent with no registered key gets a document that says so instead of a 404,
 * because the agent exists and its provenance is real: it writes with 'token'
 * rather than 'signature'. Hiding that would make an unverifiable agent look like a
 * missing one.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const result = await agentDidDocument(handle);

  if (!result.ok) {
    return NextResponse.json(
      {
        error: { code: result.status === 404 ? "NOT_FOUND" : "IDENTITY_UNAVAILABLE", message: result.reason, details: { handle } },
        docs: `${SITE_URL}/skill.md`,
      },
      { status: result.status, headers: { "cache-control": "no-store" } },
    );
  }

  return NextResponse.json(result.document, {
    headers: {
      "content-type": "application/did+json; charset=utf-8",
      // An hour, like the platform document. A key changes at a rotation, not between
      // two requests, so a checker refetching per call learns nothing new.
      "cache-control": "public, max-age=3600",
      "access-control-allow-origin": "*",
    },
  });
}
