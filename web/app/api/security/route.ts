import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { ENGINE, readSecurityRecord, SECURITY_WINDOW } from "@/lib/audit/store";
import { deepScanAmountAtomic, deepScanResource } from "@/lib/audit/deep";
import { payTo } from "@/lib/payments/x402";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE SECURITY RECORD AS JSON: the same facts /security renders, for a machine.
 *
 * WHY IT EXISTS SEPARATELY FROM THE PAGE. Two audiences want this and they want different
 * shapes. A person wants the sections in an order that reads. A monitoring script wants
 * one object it can diff against yesterday's, and it should not have to scrape HTML to
 * find out whether anything this deployment read has changed. So the numbers are computed
 * once, in `readSecurityRecord`, and both surfaces read the same call.
 *
 * WHAT IT DELIBERATELY INCLUDES. The window it read and the total that exists, side by
 * side, because a consumer that cannot tell "no findings" from "nothing loaded" will
 * report the wrong thing. Each row carries the audit id and the digest of the bytes its
 * verdict is bound to, so a client can go and check rather than trust this response.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It publishes no score. There is no single number here
 * that says whether this deployment is secure, because such a number would hide which
 * rule produced it, and the audit record's whole position is that a claim is only worth
 * what the evidence under it is.
 */
export async function GET(req: Request) {
  const sb = supabaseAdmin();
  if (!sb || !SUPABASE_CONFIGURED) {
    return NextResponse.json(
      {
        error: {
          code: "UNCONFIGURED",
          message: "The swamp backend is not configured on this deployment, so there is no audit record to read.",
        },
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? SECURITY_WINDOW);
  const record = await readSecurityRecord(sb, Number.isFinite(limit) ? limit : SECURITY_WINDOW);

  return NextResponse.json(
    {
      engine: ENGINE,
      // Atomic units as a string, not a number: a JSON number cannot carry a uint256, and
      // the same rule applies here as in the payment proof.
      scanned: {
        total: record.scanned.total,
        read: record.scanned.rows.length,
        truncated: record.scanned.truncated,
        by_verdict: record.scanned.byVerdict,
        by_kind: record.scanned.byKind,
        by_submitter: record.scanned.bySubmitter,
        rows: record.scanned.rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          subject: row.subject,
          digest: row.content_digest,
          bytes: row.bytes,
          verdict: row.verdict,
          findings: row.findings,
          counts: row.counts,
          engine: row.engine,
          source: row.source,
          submitted_by: row.submitted_by,
          revisions: row.revisions,
          documents: row.documents ?? [],
          payment: row.payment ?? null,
          // No `content` here: the bytes are on the single-audit endpoint, where a reader
          // has asked for them by id. A list that carried every document's text would be
          // megabytes of other people's content in one response.
          read: `${SITE_URL}/api/audits/${row.id}`,
          created_at: row.created_at,
        })),
      },
      found: {
        total_findings: record.found.totalFindings,
        by_code: record.found.byCode.map((c) => ({
          code: c.code,
          severity: c.severity,
          title: c.title,
          audits: c.audits,
          findings: c.findings,
        })),
      },
      fixed: {
        settled: record.fixed.settled,
        open: record.fixed.open,
        corrections: record.fixed.corrections.map((c) => ({
          audit_id: c.auditId,
          subject: c.subject,
          from: c.from,
          to: c.to,
          because: c.because,
          at: c.at,
          read: `${SITE_URL}/api/audits/${c.auditId}`,
        })),
        upheld: record.fixed.upheld.map((c) => ({
          challenge_id: c.id,
          audit_id: c.audit_id,
          challenger: c.challenger,
          reviewer: c.reviewer,
          finding_code: c.finding_code,
          rerun_verdict: c.rerun_verdict,
          rerun_finding_found: c.rerun_finding_found,
          resolution: c.resolution,
        })),
      },
      paid: {
        audits: record.paid.audits,
        atomic_usdc: record.paid.atomic.toString(),
        settled: record.paid.settled,
        verified_only: record.paid.audits - record.paid.settled,
        price_atomic_usdc: deepScanAmountAtomic(),
        resource: deepScanResource(),
        configured: Boolean(payTo()),
      },
      limits: record.limits,
      how_to_read: {
        verdict: "Bound to the SHA-256 of the exact bytes read; the bytes are kept on the single-audit endpoint.",
        scope: "The engine reads a document and does not run it. A clean verdict means the patterns were not found.",
        dispute: `POST ${SITE_URL}/api/audits/<id>/challenges with { finding_code, claim }. A second agent settles it, and settlement is a rerun of the same engine over the same bytes.`,
        audit_free: `POST ${SITE_URL}/api/audits with { kind, url } audits one document at no cost.`,
        audit_deep: `POST ${SITE_URL}/api/audits with { kind, url, deep: true, payment: <x402 proof> } reads the document and everything it declares; ${SITE_URL}/api/audits returns the terms when the proof is missing.`,
      },
      page: `${SITE_URL}/security`,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
