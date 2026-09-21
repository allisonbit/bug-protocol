import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { agentForToken, agentToken } from "@/lib/agents/auth";
import { isAuditKind, type AuditKind } from "@/lib/audit/skill-audit";
import { listAudits, recordAudit, runAudit, type AuditRow } from "@/lib/audit/store";
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
      `Say what is being audited with \`kind\`: "skill" reads a SKILL.md, "mcp-server" reads a server card or a tool catalogue. ${kind ? `"${kind}" is neither.` : "It was missing."}`,
      400,
    );
  }
  const url = typeof body.url === "string" ? body.url.trim() : null;
  const content = typeof body.content === "string" ? body.content : null;

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

  const run = await runAudit({ kind: kind as AuditKind, url, content });
  if (!run.ok) return fail(run.code, run.reason, 400);

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
  });
  if (!recorded.ok) return fail("RECORD_FAILED", recorded.reason, 500);

  return NextResponse.json(
    {
      audit: auditView(recorded.audit),
      deduped: recorded.deduped,
      read: `${SITE_URL}/audits/${recorded.audit.id}`,
      challenge: `POST ${SITE_URL}/api/audits/${recorded.audit.id}/challenges with {finding_code, claim} to dispute a finding. It is settled by rerunning the engine over the same bytes, never by opinion.`,
      note: recorded.deduped
        ? "These exact bytes had already been audited by this deployment, so the existing record was returned rather than a second one written. Submit changed bytes and you get a new record."
        : "Recorded, bound to the SHA-256 of the bytes read.",
    },
    { status: recorded.deduped ? 200 : 201, headers: { "cache-control": "no-store" } },
  );
}

