import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { verifyMessage } from "viem";
import { supabaseAdmin } from "@/lib/supabase";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Wallet sign in, independent of email.
 *
 * A person proves they control an address by signing a challenge; we verify it
 * and then mint them a normal Supabase session. This deliberately does NOT use
 * Supabase's built-in Web3/SIWE provider because that requires a dashboard toggle
 * an operator has to flip. With this, a deployment that has the service key can
 * offer wallet sign in immediately, and the behaviour is identical in dev and
 * prod.
 *
 * The account is keyed by a deterministic, non-deliverable email derived from the
 * address (`0x...@wallet.invalid`), so a wallet identity is its own account and is
 * never entangled with a payout address someone typed into Settings.
 *
 * The nonce is stateless: we seal `ts.nonce` with an HMAC and hand it to the
 * browser in an HttpOnly cookie, so the challenge is single request without a
 * table, and a signed message can't be replayed from another origin.
 */

export const WALLET_NONCE_COOKIE = "sw_wallet_nonce";

const NONCE_TTL_MS = 5 * 60 * 1000;
const STATEMENT = "Sign in to Swamp.";

function secret(): string | null {
  const s = process.env.WALLET_AUTH_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return s.length >= 16 ? s : null;
}

function seal(nonce: string): string {
  const key = secret();
  if (!key) throw new Error("Wallet sign in isn't configured (no server secret).");
  const ts = Date.now().toString(36);
  const mac = createHmac("sha256", key).update(`${ts}.${nonce}`).digest("base64url");
  return `${ts}.${nonce}.${mac}`;
}

/** Validate a sealed nonce and return the raw nonce, or null if forged/expired. */
function open(sealed: string): string | null {
  const key = secret();
  if (!key) return null;
  const parts = sealed.split(".");
  if (parts.length !== 3) return null;
  const [ts, nonce, mac] = parts;
  const expected = createHmac("sha256", key).update(`${ts}.${nonce}`).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const issued = parseInt(ts, 36);
  if (!Number.isFinite(issued) || Date.now() - issued > NONCE_TTL_MS) return null;
  return nonce;
}

/** The EIP-191 message a wallet signs. Human-readable on purpose. */
export function buildMessage(input: {
  address: string;
  chainId: number;
  origin: string;
  nonce: string;
  issuedAt: string;
}): string {
  let host = input.origin;
  try {
    host = new URL(input.origin).host;
  } catch {
    /* keep the raw origin */
  }
  return [
    `${host} wants you to sign in with your Ethereum account:`,
    input.address,
    "",
    STATEMENT,
    "",
    `URI: ${input.origin}`,
    "Version: 1",
    `Chain ID: ${input.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
  ].join("\n");
}

/** Create a fresh challenge: the message to sign plus the sealed nonce cookie value. */
export function createChallenge(input: { address: string; chainId: number; origin: string }): {
  message: string;
  sealed: string;
} {
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date().toISOString();
  return {
    message: buildMessage({ ...input, nonce, issuedAt }),
    sealed: seal(nonce),
  };
}

type Parsed = { address: string; nonce: string; origin: string | null };

/** Pull the fields we need back out of a signed message. */
export function parseMessage(message: string): Parsed | null {
  const lines = message.split("\n");
  const address = (lines[1] ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  const nonce = /^Nonce: (.+)$/m.exec(message)?.[1]?.trim();
  if (!nonce) return null;
  const uri = /^URI: (.+)$/m.exec(message)?.[1]?.trim() ?? null;
  return { address, nonce, origin: uri };
}

export type WalletSignInResult =
  | { ok: true; address: string; userId: string }
  | { ok: false; error: string };

/**
 * Verify a signed challenge and establish a session for that wallet's account.
 * On success the auth cookies are set on the response by `verifyOtp`.
 */
export async function verifyWalletSignature(input: {
  message: string;
  signature: string;
  sealed: string | null;
  origin: string;
}): Promise<WalletSignInResult> {
  const { message, signature, sealed, origin } = input;

  const parsed = parseMessage(message);
  if (!parsed) return { ok: false, error: "That isn't a valid sign in message." };

  // 1) The message must be the challenge we issued, to this origin, unexpired.
  if (!sealed) return { ok: false, error: "Sign in challenge expired. Please try again." };
  const expectedNonce = open(sealed);
  if (!expectedNonce || expectedNonce !== parsed.nonce) {
    return { ok: false, error: "Sign in challenge expired. Please try again." };
  }
  if (parsed.origin && parsed.origin !== origin) {
    return { ok: false, error: "This signature was made for a different site." };
  }

  // 2) The signature must come from the address in the message.
  let valid = false;
  try {
    valid = await verifyMessage({
      address: parsed.address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: "That signature doesn't match the wallet address." };

  // 3) Find or create the account that belongs to this wallet.
  const address = parsed.address;
  const email = `${address.toLowerCase()}@wallet.invalid`;
  const admin = supabaseAdmin();
  if (!admin) return { ok: false, error: "The backend isn't configured on this deployment." };

  // Mint a session for this wallet's account.
  //
  // We rotate an ephemeral random password and sign in with it rather than using
  // an admin-generated magic link: the server client runs the PKCE flow, and a
  // link minted server side carries no code verifier, so that exchange can never
  // complete. The password is never stored, shown or reused; it is replaced on
  // every sign in, so it is not a credential anyone holds.
  const password = randomBytes(24).toString("base64url");
  let userId: string | null = null;

  const created = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    password,
    user_metadata: { wallet: address, wallet_signin: true },
  });
  if (created.data?.user) {
    userId = created.data.user.id;
  } else if (created.error && !/registered|exists/i.test(created.error.message)) {
    return { ok: false, error: created.error.message };
  } else {
    // The account already exists. Resolve it and rotate its password.
    const found = await admin.auth.admin.generateLink({ type: "magiclink", email });
    userId = found.data?.user?.id ?? null;
    if (!userId) return { ok: false, error: "Could not establish a session for this wallet." };
    const rotated = await admin.auth.admin.updateUserById(userId, { password });
    if (rotated.error) return { ok: false, error: rotated.error.message };
  }

  // Signing in on the cookie-bound server client sets the auth cookies on this
  // response, so the browser is signed in the moment it navigates.
  const sb = await supabaseServer();
  if (!sb) return { ok: false, error: "The backend isn't configured on this deployment." };
  const { error: signInErr } = await sb.auth.signInWithPassword({ email, password });
  if (signInErr) return { ok: false, error: signInErr.message };

  // 5) Make the profile legible: record the wallet and a usable name/handle when
  //    the signup trigger left them empty.
  const handle = `w${address.slice(2, 10).toLowerCase()}`;
  const patch: Record<string, string> = { wallet: address };
  const { data: prof } = await admin.from("profiles").select("handle,display_name").eq("id", userId).maybeSingle();
  if (prof && !(prof as { handle: string | null }).handle) patch.handle = handle;
  if (prof && !(prof as { display_name: string | null }).display_name) {
    patch.display_name = `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
  // Best-effort: a handle collision must not fail the sign in the wallet just proved.
  await admin.from("profiles").update(patch).eq("id", userId);

  return { ok: true, address, userId };
}
