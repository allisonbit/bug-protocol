import "server-only";
import { sha256Hex } from "@/lib/agents/crypto";
import { getFlags } from "@/lib/agents/auth";
import { supabaseAdmin } from "@/lib/supabase";
import type { Machine } from "@/lib/agents/types";

/**
 * THE MACHINE DOORS' SHARED AUTH.
 *
 * This lived inside `app/api/machines/route.ts` until a second device door existed.
 * Two copies of a token check is two places for one of them to drift, and the
 * drift would be silent: a door that resolved a retired machine, or one that
 * skipped the kill switch, would still answer requests. So there is one copy, here,
 * and every machine door imports it.
 *
 * WHAT A MACHINE IS, AS AN AUTHENTICATION FACT. It holds one bearer token, shown
 * once at registration and stored only as a hash, and it may hold Ed25519 public
 * keys for signing. The token says "this request came from the device configured
 * with that secret". A signature over the payload says more: those bytes came from
 * the holder of that private key. The two are checked independently, and a report
 * that has one and not the other is stored with the difference recorded.
 */

/** Pull the machine token from a request: `Authorization: Bearer <t>` or `X-Machine-Token`. */
export function machineToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim() || null;
  const x = req.headers.get("x-machine-token");
  return x?.trim() || null;
}

export type MachineAuth =
  | { ok: true; machine: Machine; sb: NonNullable<ReturnType<typeof supabaseAdmin>> }
  | { ok: false; status: number; code: string; message: string };

/** Resolve a raw token to its live machine, honouring the kill switch. */
export async function machineForToken(token: string | null): Promise<MachineAuth> {
  const sb = supabaseAdmin();
  if (!sb) return { ok: false, status: 503, code: "BACKEND_UNCONFIGURED", message: "The swamp backend isn't configured on this deployment yet." };
  if (!token) return { ok: false, status: 401, code: "NO_TOKEN", message: "Missing machine token. Send it as X-Machine-Token." };
  const flags = await getFlags(sb);
  if (flags.killswitch) {
    return { ok: false, status: 503, code: "KILLSWITCH", message: "The swamp is paused by the platform kill switch. Nothing is accepting writes." };
  }

  const { data: secret } = await sb.from("machine_secrets").select("machine_id").eq("api_token_hash", sha256Hex(token)).maybeSingle();
  if (!secret) return { ok: false, status: 401, code: "BAD_TOKEN", message: "Unrecognized machine token." };
  const { data: machine } = await sb.from("machines").select("*").eq("id", (secret as { machine_id: string }).machine_id).maybeSingle();
  if (!machine) return { ok: false, status: 401, code: "BAD_TOKEN", message: "Token is not linked to a machine." };
  const m = machine as Machine;
  if (m.status === "retired") return { ok: false, status: 403, code: "RETIRED", message: "This machine has been retired by its owner." };
  return { ok: true, machine: m, sb };
}

/** One key row as the doors and the DID document read it. */
export type MachineKeyRow = {
  kid: string;
  public_key: string;
  algo: string;
  created_at: string;
  retired_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
};

/** The keys bound to a machine, newest first. */
export async function keysFor(
  sb: NonNullable<ReturnType<typeof supabaseAdmin>>,
  machineId: string,
): Promise<MachineKeyRow[]> {
  const { data } = await sb
    .from("machine_keys")
    .select("kid, public_key, algo, created_at, retired_at, revoked_at, revoked_reason")
    .eq("machine_id", machineId)
    .order("created_at", { ascending: false });
  return (data as MachineKeyRow[] | null) ?? [];
}

/** A key id: short, stable, and ours to choose, so two devices cannot collide inside a machine. */
export function nextKid(existing: string[]): string {
  const used = new Set(existing);
  for (let i = 1; i <= 999; i++) {
    const kid = `key${i}`;
    if (!used.has(kid)) return kid;
  }
  return `key${Date.now().toString(36)}`;
}
