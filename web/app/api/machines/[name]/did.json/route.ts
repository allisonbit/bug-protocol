import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { SITE_URL } from "@/lib/site";
import { keysFor } from "@/lib/machines/auth";
import { machineDidDocument } from "@/lib/machines/did";
import type { Machine } from "@/lib/agents/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/machines/<name>/did.json: one machine's identity document.
 *
 * WHY THE PATH LOOKS LIKE THIS. `did:web:www.swampai.world:machines:atlas` resolves
 * by taking the DID method's host and turning every following segment into a path,
 * so the document lives under the deployment's own /api/machines/<name>/ prefix. A
 * verifier holding a DID therefore needs one GET and no registry, which is the whole
 * reason to use the method.
 *
 * WHAT A READER CAN DO WITH IT. Fetch it, take the key it publishes, verify a
 * reading's signature against that key, and compare the canonical message digest to
 * the one we recorded. None of that requires trusting this page or this store: the
 * document is derived from the key rows, and the key rows are public.
 *
 * WHAT IT DELIBERATELY OMITS. No firmware assertion, no calibration claim, no safety
 * claim. The document says which keys speak for the machine and where its telemetry
 * arrives, and its own `scope` field says that is all it says.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const clean = String(name ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,39}$/.test(clean)) {
    return NextResponse.json(
      { error: { code: "BAD_NAME", message: "A machine name is 3 to 40 characters: lowercase letters, digits, hyphen or underscore." } },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const sb = supabaseAdmin();
  if (!sb || !SUPABASE_CONFIGURED) {
    return NextResponse.json({ error: { code: "BACKEND_UNCONFIGURED", message: "The swamp backend isn't configured on this deployment yet." } }, { status: 503, headers: { "cache-control": "no-store" } });
  }

  const { data } = await sb.from("machines").select("*").eq("name", clean).maybeSingle();
  const machine = data as Machine | null;
  if (!machine) {
    return NextResponse.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `No machine named "${clean}" is registered, so there is no key to publish. An unknown name is a 404 rather than an empty document, because an empty document would look like a machine with no keys.`,
        },
      },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }

  const keys = await keysFor(sb, machine.id);
  const document = machineDidDocument({ machine, keys, siteUrl: SITE_URL });

  return NextResponse.json(document, {
    headers: {
      "content-type": "application/did+json; charset=utf-8",
      // Shorter than the platform document's hour: a machine's keys change on a
      // rotation, which is a device's act at a moment nobody scheduled, and a
      // verifier holding a stale copy would refuse a good report.
      "cache-control": "public, max-age=120",
      "access-control-allow-origin": "*",
    },
  });
}
