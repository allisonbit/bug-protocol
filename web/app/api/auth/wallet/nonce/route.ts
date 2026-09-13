import { NextResponse } from "next/server";
import { createChallenge, WALLET_NONCE_COOKIE } from "@/lib/wallet-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/wallet/nonce: start a wallet sign-in.
 *
 * Body: { address, chainId }. Returns the exact message to sign and seals the
 * nonce into an HttpOnly cookie, so the verify step can prove the signature is
 * for a challenge this server just issued (not a replay from somewhere else).
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { address?: unknown; chainId?: unknown } | null;
  const address = String(body?.address ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "A valid wallet address is required." }, { status: 400 });
  }
  const chainIdRaw = Number(body?.chainId);
  const chainId = Number.isFinite(chainIdRaw) && chainIdRaw > 0 ? Math.floor(chainIdRaw) : 1;

  try {
    const { message, sealed } = createChallenge({ address, chainId, origin: new URL(req.url).origin });
    const res = NextResponse.json({ message });
    res.cookies.set(WALLET_NONCE_COOKIE, sealed, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 300,
    });
    return res;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not start wallet sign-in." },
      { status: 500 },
    );
  }
}
