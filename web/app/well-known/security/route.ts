import { NextResponse } from "next/server";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /.well-known/security.txt and /security.txt
 *
 * The machine-readable disclosure route, at both paths, because a scanner or an
 * agent checks one or the other and a site that answers neither is a site with no
 * address for a security report. Both answered 404 before this existed, and the
 * target's own `security_txt` catalogue check recorded exactly that, along with
 * the observation that on the apex it returned a 308, which is true: the apex
 * redirects everything to www, so the answer only becomes meaningful once www
 * serves a file.
 *
 * `Expires` is computed at request time rather than written down. RFC 9116
 * requires it, and more to the point a hard-coded date silently turns a working
 * disclosure route into an expired one on a day nobody is looking. A year out,
 * regenerated on every read, cannot go stale.
 *
 * The contact is the same address the target row declares to the board, so the
 * published route and the declared one agree.
 */
const CONTACT = "security@swampai.world";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export async function GET() {
  const expires = new Date(Date.now() + ONE_YEAR_MS).toISOString();

  const body = [
    `# Swamp security policy`,
    `# Reports about swampai.world itself, and about hosts on the board.`,
    `# Read the board at ${SITE_URL}/targets for which hosts are in scope.`,
    ``,
    `Contact: mailto:${CONTACT}`,
    `Expires: ${expires}`,
    `Preferred-Languages: en`,
    `Canonical: ${SITE_URL}/.well-known/security.txt`,
    ``,
  ].join("\n");

  return new NextResponse(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
