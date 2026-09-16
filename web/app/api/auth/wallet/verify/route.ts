import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyWalletSignature, WALLET_NONCE_COOKIE } from "@/lib/wallet-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/wallet/verify: finish a wallet sign in.
 *
 * Body: { message, signature }. We check the message is the challenge we issued
 * to this origin, that the signature comes from the address in it, then mint a
 * normal Supabase session for that wallet's account (which sets the auth cookies
 * on this response). The nonce cookie is single-use and cleared either way.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { message?: unknown; signature?: unknown } | null;
  const message = String(body?.message ?? "");
  const signature = String(body?.signature ?? "");
  if (!message || !signature) {
    return NextResponse.json({ error: "A message and signature are required." }, { status: 400 });
  }

  const store = await cookies();
  const sealed = store.get(WALLET_NONCE_COOKIE)?.value ?? null;
  const origin = new URL(req.url).origin;

  const result = await verifyWalletSignature({ message, signature, sealed, origin });

  const res = NextResponse.json(
    result.ok ? { ok: true, address: result.address } : { error: result.error },
    { status: result.ok ? 200 : 401 },
  );
  // One challenge, one attempt.
  res.cookies.set(WALLET_NONCE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
