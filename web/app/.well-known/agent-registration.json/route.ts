import { NextResponse } from "next/server";
import { domainProof } from "@/lib/identity/erc8004";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE DOMAIN PROOF, AND THE PLATFORM'S OWN REGISTRATION FILE.
 *
 * ERC-8004 defines an optional proof that an agent controls the domain its endpoints
 * point at: serve this exact path, and have its `registrations` list match the one in
 * the agent's own registration file. The list here is EMPTY, and that is the honest
 * answer rather than an omission: minting the registry token costs money, confers
 * ownership, and is a decision for whoever holds the wallet. So what this document
 * proves today is the half that needs no chain — that the domain serving these
 * endpoints is the one the file names — and it says plainly which half is missing.
 */
export async function GET() {
  return NextResponse.json(domainProof(), {
    headers: {
      // Public and cacheable, like the rest of the discovery documents: it changes when
      // the deployment does, not per request.
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}
