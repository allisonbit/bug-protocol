import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";

/**
 * The operator guard for the admin surface (Layer 14): ban an agent, flip the
 * kill switch, authorize/freeze a target, read platform metrics. There is no
 * "admin" role in the product (profiles are hunter/client/both), and these are
 * operator actions, not user ones, so they're gated by a shared secret in the
 * environment, exactly like the orchestrator's CRON_SECRET.
 *
 * Unlike the cron (which runs when unset so a fresh deploy still ticks), the
 * admin surface FAILS CLOSED: with no ADMIN_SECRET configured there is no way in
 * at all. An open admin endpoint would be worse than a missing one, and honesty
 * demands we never pretend a control is protected when it isn't.
 *
 * The comparison is constant-time over sha256 digests, so neither the secret's
 * value nor its length leaks through timing.
 */

export type AdminOk = { ok: true; sb: SupabaseClient };
export type AdminErr = { ok: false; res: NextResponse };

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function tokenFrom(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim() || null;
  const x = req.headers.get("x-admin-secret");
  return x?.trim() || null;
}

/**
 * Authorize an admin request and hand back the service-role client. Returns a
 * ready-to-send error response on any failure so routes stay one-liners:
 *   const gate = await requireAdmin(req); if (!gate.ok) return gate.res;
 */
export async function requireAdmin(req: Request): Promise<AdminOk | AdminErr> {
  const secret = process.env.ADMIN_SECRET ?? "";
  if (!secret) {
    return {
      ok: false,
      res: NextResponse.json(
        { error: "Admin actions are disabled: no ADMIN_SECRET is configured on this deployment." },
        { status: 503 },
      ),
    };
  }

  const provided = tokenFrom(req);
  if (!provided) {
    return { ok: false, res: NextResponse.json({ error: "Missing admin secret." }, { status: 401 }) };
  }

  // Constant-time over fixed-length digests (timingSafeEqual throws on length
  // mismatch, which would itself leak length; hashing first avoids that).
  const a = sha256(provided);
  const b = sha256(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, res: NextResponse.json({ error: "Invalid admin secret." }, { status: 403 }) };
  }

  if (!SUPABASE_CONFIGURED) {
    return {
      ok: false,
      res: NextResponse.json({ error: "The swarm backend isn't configured on this deployment yet." }, { status: 503 }),
    };
  }
  const sb = supabaseAdmin();
  if (!sb) {
    return {
      ok: false,
      res: NextResponse.json({ error: "The swarm backend isn't configured on this deployment yet." }, { status: 503 }),
    };
  }

  return { ok: true, sb };
}
