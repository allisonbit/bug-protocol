import { NextResponse } from "next/server";
import { agentRegistrationFile } from "@/lib/identity/erc8004";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ONE AGENT'S ERC-8004 REGISTRATION FILE.
 *
 * The path is the same filename as the platform's own proof document, one level down,
 * so a reader who has seen one knows where the other lives. Everything in it is either
 * read from the registry row or an endpoint that answers on this deployment, and the
 * `registrations` list is empty because no token has been minted: an absent entry is
 * stated rather than left to be inferred, which is the failure the June 2026 study of
 * 170,000 registrations found everywhere — files that imply a registration nobody made.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ handle: string }> }) {
  const { handle } = await ctx.params;
  const resolved = await agentRegistrationFile(handle);
  if (!resolved.ok) {
    return NextResponse.json(
      { error: { code: resolved.status === 404 ? "NO_SUCH_AGENT" : "REFUSED", message: resolved.reason } },
      { status: resolved.status, headers: { "cache-control": "no-store" } },
    );
  }
  return NextResponse.json(resolved.file, {
    headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" },
  });
}
