import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { agentForToken, agentToken } from "@/lib/agents/auth";
import { isAuditKind, type AuditKind } from "@/lib/audit/skill-audit";
import { listAudits, recordAudit, runAudit, type AuditReceipt, type AuditRow } from "@/lib/audit/store";
import { deepScanRequirements, proofFromBody, runDeepAudit } from "@/lib/audit/deep";
import { acceptPayment } from "@/lib/payments/x402";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE AUDIT DOOR.
 *
 *   POST  run an audit and record it  (public; attributed when a token is sent)
 *   GET   the audits this deployment has run (public)
 *
 * WHY THIS IS PUBLIC AND WHY THE RECORD KEEPS THE BYTES. Two questions decide
 * whether an audit surface is worth anything: can a reader check the verdict, and can
 * anybody dispute it? A reader can check this one by hashing the bytes the record
 * carries and comparing the digest the verdict is bound to, which is why the bytes are
 * published rather than summarised. Anybody can dispute one through the challenge
 * door, and the dispute is settled by running the same deterministic engine over the
 * same bytes in front of a second agent.
 *
 * That is the whole difference between this and a badge. A badge is a claim about a
 * scan; this is a claim about specific bytes, with the bytes attached, that a second
 * party can overturn by doing the work again.
 */

const NO_BACKEND = "The swamp backend is not configured on this deployment, so there is nowhere to record an audit.";

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message }, docs: `${SITE_URL}/audits` }, { status, headers: { "cache-control": "no-store" } });
}

/** The row as a reader gets it: the list view never carries the bytes. */
export function auditView(row: AuditRow, opts: { content?: boolean } = {}) {
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    digest: row.content_digest,
    bytes: row.bytes,
    verdict: row.verdict,
    findings: row.findings,
    counts: row.counts,
    engine: row.engine,
    frontmatter: row.frontmatter,
    summary: row.summary,
    scope: row.scope,
    source: row.source,
    submitted_by: row.submitted_by,
    revisions: row.revisions,
    // What a deep scan read, one entry per document with its own digest and verdict, and
    // what it declined to read. Present on every audit as an empty list rather than
    // omitted, so a reader can tell "read one document" from "the field is missing".
    documents: row.documents ?? [],
    // The receipt, when somebody paid for the scan. A reader can therefore see what was
    // bought and that the verdict was the same engine either way.
    payment: row.payment ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(opts.content ? { content: row.content } : {}),
  };
}

export async function GET(req: Request) {
  const sb = supabaseAdmin();
  if (!sb || !SUPABASE_CONFIGURED) return fail("UNCONFIGURED", NO_BACKEND, 503);
  const url = new URL(req.url);
  const rows = await listAudits(sb, {
    limit: Number(url.searchParams.get("limit") ?? 25),
    verdict: url.searchParams.get("verdict"),
    kind: url.searchParams.get("kind"),
  });
  return NextResponse.json(
    {
      audits: rows.map((r) => auditView(r)),
      count: rows.length,
      // Said out loud rather than left for a reader to notice: this is a page of the
      // newest audits, not the whole record.
      note: "The newest audits, newest first. Each is bound to the SHA-256 of the exact bytes it read; read one by id to check the hash yourself.",
      docs: `${SITE_URL}/audits`,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const sb = supabaseAdmin();
  if (!sb || !SUPABASE_CONFIGURED) return fail("UNCONFIGURED", NO_BACKEND, 503);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail("BAD_JSON", "Send a JSON body: {\"kind\":\"skill\",\"url\":\"https://...\"} or {\"kind\":\"mcp-server\",\"content\":\"{...}\"}.", 400);
  }

  const kind = typeof body.kind === "string" ? body.kind.trim() : "";
  if (!isAuditKind(kind)) {
    return fail(
      "BAD_KIND",
      `Say what is being audited with \`kind\`: "skill" reads a SKILL.md, "instructions" reads an AGENTS.md, a CLAUDE.md or a rules directory, and "mcp-server" reads a server card or a tool catalogue. ${kind ? `"${kind}" is none of the three.` : "It was missing."}`,
      400,
    );
  }
  const url = typeof body.url === "string" ? body.url.trim() : null;
  const content = typeof body.content === "string" ? body.content : null;
  const deep = body.deep === true;

  // Attribution, never authorization: an audit is a public act, and a caller with a
  // token gets its name on the row. A bad token is refused rather than downgraded to
  // anonymous, because a caller who believes it signed something must not be quietly
  // recorded as nobody.
  let submittedBy = "anonymous";
  let agent: { id: string; handle: string } | null = null;
  const token = agentToken(req);
  if (token) {
    const auth = await agentForToken(token);
    if (!auth.ok) return fail("BAD_TOKEN", auth.message, auth.status);
    submittedBy = auth.agent.handle;
    agent = { id: auth.agent.id, handle: auth.agent.handle };
  }

  // THE ONE PAID PART OF THE AUDIT SURFACE, AND WHY IT IS NOT THE VERDICT.
  //
  // An ordinary audit reads one document and stays free, because a verdict that only
  // people with a card can obtain is a verdict that is not public. A deep scan reads the
  // document AND everything it declares, or asks a live server for its catalogue rather
  // than reading a card the submitter chose — several outbound requests on this
  // deployment's account, which is the thing being paid for.
  //
  // The order is forced: the payment is verified before any of that work starts, so a
  // refusal costs a stranger's server nothing and this deployment cannot be made to scan
  // a target by somebody who never paid. A refusal is a 402 carrying the terms.
  let receipt: AuditReceipt | null = null;
  if (deep) {
    const terms = deepScanRequirements();
    if (!terms.configured) {
      return NextResponse.json(
        {
          ...terms,
          error: {
            code: "PAYMENTS_UNCONFIGURED",
            message:
              "A deep scan costs money and this deployment has no address to settle to, so it cannot sell one. X402_PAY_TO is not set. An ordinary audit of one document is free and unchanged.",
          },
        },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    const proof = proofFromBody(body);
    if (!proof) {
      return NextResponse.json(
        {
          ...terms,
          error: {
            code: "PAYMENT_REQUIRED",
            message:
              "A deep scan is paid for. Send the same body with `payment` set to an x402 `exact` proof for the terms below, or drop `deep` and audit the one document for free.",
          },
        },
        { status: 402, headers: { "cache-control": "no-store" } },
      );
    }
    const paid = await acceptPayment({
      proof,
      sb,
      resource: terms.accepts[0] ? String((terms.accepts[0] as { resource: string }).resource) : undefined,
      description: "A deep audit scan through /api/audits.",
    });
    if (!paid.ok) {
      return NextResponse.json(
        { ...terms, error: { code: paid.code, message: paid.reason } },
        { status: paid.status, headers: { "cache-control": "no-store" } },
      );
    }
    receipt = {
      network: paid.network,
      payer: paid.payer,
      amount: paid.amount,
      // `verified` and `settled` are different facts and stay different here: a verified
      // proof is an authorization this deployment checked, and only a facilitator moves
      // funds. A reader of the receipt can tell which one happened.
      status: paid.status,
      settlementRef: paid.settlementRef,
      paymentId: paid.id,
      at: new Date().toISOString(),
    };
  }

  const run = deep ? await runDeepAudit({ kind: kind as AuditKind, url, content }) : await runAudit({ kind: kind as AuditKind, url, content });
  if (!run.ok) {
    // The payment already landed, and it is NOT refunded here or hidden. It is recorded
    // against no audit, in `x402_payments`, because the proof was checked and accepted
    // before the scan was attempted: the money bought the attempt, and a record that
    // pretended otherwise would be the kind of receipt that lies. The refusal says so.
    return NextResponse.json(
      {
        error: {
          code: run.code,
          message: `${run.reason}${receipt ? ` The payment was verified and recorded against no audit: payment ${receipt.paymentId ?? "(unrecorded)"} on ${receipt.network}. A deep scan is bought before it is attempted, so a target that refuses to serve costs you the attempt, and this deployment does not pretend otherwise.` : ""}`,
        },
        // The same field name the accepted path uses, because a caller reading a refusal
        // should not have to learn a second shape to find out what it was charged.
        paid: receipt,
        docs: `${SITE_URL}/audits`,
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const recorded = await recordAudit(sb, {
    result: run.result,
    subject: run.result.subject,
    source: run.source,
    // The bytes the engine actually read, handed to the record rather than fetched
    // again: a second read could return different bytes, and a record whose digest
    // describes the first read while its content is the second would be a record that
    // cannot be re-audited truthfully.
    content: run.text,
    submittedBy,
    agent,
    payment: receipt,
  });
  if (!recorded.ok) return fail("RECORD_FAILED", recorded.reason, 500);

  return NextResponse.json(
    {
      audit: auditView(recorded.audit),
      deduped: recorded.deduped,
      read: `${SITE_URL}/audits/${recorded.audit.id}`,
      challenge: `POST ${SITE_URL}/api/audits/${recorded.audit.id}/challenges with {finding_code, claim} to dispute a finding. It is settled by rerunning the engine over the same bytes, never by opinion.`,
      paid: receipt,
      deep,
      note: recorded.deduped
        ? `These exact bytes had already been audited by this deployment, so the existing record was returned rather than a second one written.${receipt ? " The scan was paid for and the existing record already carries its own receipt; this one is attached to the payment row rather than duplicated onto the record." : ""} Submit changed bytes and you get a new record.`
        : deep
          ? "Recorded, bound to the SHA-256 of the document set. Every document the scan read is listed on the record with its own digest and verdict, and the receipt is on the record rather than left in a payments table a reader would have to find."
          : "Recorded, bound to the SHA-256 of the bytes read.",
    },
    { status: recorded.deduped ? 200 : 201, headers: { "cache-control": "no-store" } },
  );
}

