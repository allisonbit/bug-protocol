import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/reports/<sha256>: the content-addressed home of an encrypted report.
 *
 * `reportURI` is part of the commit preimage, so it has to be fixed *before* the
 * commit is sent, but the ciphertext can't be stored until the commit exists
 * (there's no row to attach it to yet). Hashing the envelope locally and using
 * that hash as the URI breaks the deadlock: the hunter computes
 * `sha256(envelope)` in the browser, commits to `/api/reports/<hash>`, and this
 * route serves those exact bytes afterwards.
 *
 * Two consequences worth stating plainly:
 *
 *  - **The envelope is ciphertext.** Serving it is not a disclosure; the report
 *    is sealed with AES-GCM under a passphrase only the hunter and the owner
 *    have. What leaks, at worst, is the size of the report.
 *
 *  - **The hash is a capability.** The URI is never published pre-reveal, only
 *    `keccak256(uri, salt, hunter)` goes on chain, and that is preimage-resistant
 *    so possession of the hash is what grants access. After `reveal` the URI is
 *    public on purpose, and this route is how a third party reads it. The owner
 *    also needs it before triage, which is why this can't be gated on triage
 *    status.
 *
 * Served with an immutable cache header, because the bytes at a given hash can
 * never change. That's the entire point of addressing by hash.
 */
const HASH_RE = /^[0-9a-f]{64}$/;

export async function GET(_req: Request, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  const normalized = hash.toLowerCase();

  if (!HASH_RE.test(normalized)) {
    return NextResponse.json({ error: "A sha256 hash is required." }, { status: 400 });
  }
  if (!SUPABASE_CONFIGURED) {
    return NextResponse.json({ error: "This deployment has no report store." }, { status: 503 });
  }

  const sb = supabaseAdmin();
  if (!sb) return NextResponse.json({ error: "This deployment has no report store." }, { status: 503 });

  // The row's RLS keeps reports private to the hunter and the program owner, but
  // this read has to be able to serve a disclosed finding to anyone, so it runs
  // as the service role and returns the envelope, never the surrounding row.
  const { data, error } = await sb
    .from("submissions")
    .select("report")
    .eq("report_sha256", normalized)
    .limit(1)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const report = (data as { report: string | null } | null)?.report;
  if (!report) return NextResponse.json({ error: "No report at that hash." }, { status: 404 });

  return new NextResponse(report, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Addressed by hash, so the response can never legitimately change.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
