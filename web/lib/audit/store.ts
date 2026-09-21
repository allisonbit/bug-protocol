import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AUDIT_ENGINE,
  auditMcpServer,
  auditSkill,
  type AuditKind,
  type AuditResult,
  type Verdict,
} from "./skill-audit";
import { fetchForAudit, selfHosts } from "./fetch";
import { SITE_URL } from "@/lib/site";

/**
 * THE AUDIT RECORD: writing verdicts down, and letting somebody disagree with one.
 *
 * Two things make this more than a scanner. The record is bound by SHA-256 to the
 * exact bytes read, so a verdict cannot silently drift onto different content, and the
 * bytes are kept so a challenge can be settled by RERUNNING the engine over them
 * rather than by argument. The engine is deterministic, so the rerun is evidence, and
 * a challenge is decided by what the engine produces, not by who is louder.
 *
 * The lifecycle is a state transition and not a shared note. A challenge moves from
 * open to under_review by winning an update, so exactly one reviewer can hold it, and
 * the one voice class of bug that has shipped twice in this codebase (a cooldown read
 * from a key nobody wrote) cannot happen here because no key is involved.
 */

export type AuditRow = {
  id: string;
  kind: AuditKind;
  subject: string | null;
  content_digest: string;
  bytes: number;
  content: string;
  verdict: Verdict;
  findings: unknown;
  counts: Record<string, number>;
  engine: string;
  frontmatter: unknown;
  summary: string | null;
  scope: string | null;
  source: "fetched" | "submitted";
  submitted_by: string;
  revisions: { verdict: Verdict; at: string; because: string }[];
  created_at: string;
  updated_at: string;
};

export type ChallengeRow = {
  id: string;
  audit_id: string;
  challenger: string;
  finding_code: string;
  claim: string;
  counter_evidence: string | null;
  status: "open" | "under_review" | "upheld" | "rejected";
  reviewer: string | null;
  rerun_verdict: Verdict | null;
  rerun_finding_found: boolean | null;
  resolution: string | null;
  created_at: string;
  claimed_at: string | null;
  resolved_at: string | null;
};

/** Who an event belongs to, when it belongs to a resident rather than the platform. */
type Actor = { id: string; handle: string } | null;

async function event(
  sb: SupabaseClient,
  e: { topic: string; payload: Record<string, unknown>; agent?: Actor },
): Promise<void> {
  await sb
    .from("events")
    .insert({
      topic: e.topic,
      agent_id: e.agent?.id ?? null,
      agent_handle: e.agent?.handle ?? null,
      payload: e.payload,
      signature: null,
      signed_ok: false,
      // A resident raising a challenge is the runtime acting for a registered agent,
      // which is what runtime means here. The platform's own recording is system.
      provenance: e.agent ? "runtime" : "system",
    })
    .then(undefined, () => null);
}

/**
 * Run the engine over bytes, whichever way they arrived.
 *
 * The bytes may be supplied by the caller, in which case a URL is recorded as a claim
 * about where they came from, or fetched under the guard in `fetch.ts`. The two are
 * stored as different values of `source`, because "we read this at this URL" and "a
 * caller says these bytes came from this URL" are different claims and a reader
 * deciding how much to trust a verdict needs to know which one it is looking at.
 */
export async function runAudit(input: {
  kind: AuditKind;
  url?: string | null;
  content?: string | null;
}): Promise<
  | { ok: true; result: AuditResult; source: "fetched" | "submitted"; url: string | null; text: string }
  | { ok: false; code: string; reason: string }
> {
  const url = input.url?.trim() || null;
  const supplied = typeof input.content === "string" && input.content.length > 0 ? input.content : null;

  if (!supplied && !url) {
    return { ok: false, code: "NO_CONTENT", reason: "Send either `content` with the bytes, or `url` for this deployment to fetch." };
  }

  let text = supplied;
  let source: "fetched" | "submitted" = "submitted";
  if (!text && url) {
    const fetched = await fetchForAudit(url, selfHosts(SITE_URL));
    if (!fetched.ok) return { ok: false, code: fetched.code, reason: fetched.reason };
    text = fetched.text;
    source = "fetched";
  }

  const body = text as string;
  if (input.kind === "skill") {
    return { ok: true, result: auditSkill({ text: body, url }), source, url, text: body };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return {
      ok: false,
      code: "BAD_JSON",
      reason: `An MCP server audit reads a card or a tool catalogue, which is JSON: ${e instanceof Error ? e.message : "not parseable"}.`,
    };
  }
  return { ok: true, result: auditMcpServer({ body: parsed, url }), source, url, text: body };
}

/** Record one verdict, or return the record that already covers these exact bytes. */
export async function recordAudit(
  sb: SupabaseClient,
  input: {
    result: AuditResult;
    subject: string | null;
    source: "fetched" | "submitted";
    content: string;
    submittedBy: string;
    agent?: Actor;
  },
): Promise<{ ok: true; audit: AuditRow; deduped: boolean } | { ok: false; reason: string }> {
  const r = input.result;
  const existing = await boundLookup(sb, r.kind, r.digest, input.subject);
  const found = existing;
  if (found) return { ok: true, audit: found, deduped: true };

  const { data, error } = await sb
    .from("audits")
    .insert({
      kind: r.kind,
      subject: input.subject,
      content_digest: r.digest,
      bytes: r.bytes,
      content: input.content.slice(0, 1_048_576),
      verdict: r.verdict,
      findings: r.findings,
      counts: r.counts,
      engine: r.engine,
      frontmatter: r.frontmatter,
      summary: r.summary,
      scope: r.scope,
      source: input.source,
      submitted_by: input.submittedBy,
      revisions: [],
    })
    .select("*")
    .single();
  if (error) {
    // 23505 means a concurrent write of the same bytes won the race. Returning the
    // existing record is the honest answer: the audit happened once.
    if (error.code === "23505") {
      const row = await boundLookup(sb, r.kind, r.digest, input.subject);
      if (row) return { ok: true, audit: row, deduped: true };
    }
    return { ok: false, reason: `The audit could not be recorded: ${error.message}` };
  }
  const audit = data as AuditRow;

  await event(sb, {
    topic: "audit.recorded",
    agent: input.agent,
    payload: {
      text: `${r.kind} audit of ${input.subject ?? "submitted bytes"} came back ${r.verdict}${r.findings.length > 0 ? `, ${r.findings.length} finding(s)` : ""}`,
      audit_id: audit.id,
      kind: r.kind,
      subject: input.subject,
      verdict: r.verdict,
      digest: r.digest,
      findings: r.counts,
      source: input.source,
      submitted_by: input.submittedBy,
    },
  });
  return { ok: true, audit, deduped: false };
}

/**
 * Find the record bound to one document, or null.
 *
 * A null subject is matched with `is`, not with an empty string: the unique index
 * coalesces null to '' so the two are one key in the database, while a SELECT on ''
 * matches nothing at all. Getting this wrong would let the same bytes be audited twice
 * with the first record invisible behind the second.
 */
async function boundLookup(sb: SupabaseClient, kind: AuditKind, digest: string, subject: string | null): Promise<AuditRow | null> {
  let query = sb.from("audits").select("*").eq("kind", kind).eq("content_digest", digest);
  query = subject === null ? query.is("subject", null) : query.eq("subject", subject);
  const { data } = await query.maybeSingle();
  return (data as AuditRow | null) ?? null;
}

export async function readAudit(
  sb: SupabaseClient,
  id: string,
): Promise<{ ok: true; audit: AuditRow; challenges: ChallengeRow[] } | { ok: false; reason: string }> {
  const clean = id.trim();
  if (!/^[0-9a-f-]{36}$/i.test(clean)) return { ok: false, reason: "An audit id is a uuid." };
  const { data } = await sb.from("audits").select("*").eq("id", clean).maybeSingle();
  const audit = (data as AuditRow | null) ?? null;
  if (!audit) {
    return { ok: false, reason: `No audit with id ${clean}. Every audit this deployment has run is a row, so an unknown id means it was never run here.` };
  }
  const { data: challenges } = await sb
    .from("audit_challenges")
    .select("*")
    .eq("audit_id", clean)
    .order("created_at", { ascending: true })
    .limit(50);
  return { ok: true, audit, challenges: (challenges as ChallengeRow[] | null) ?? [] };
}

export async function listAudits(
  sb: SupabaseClient,
  input: { limit?: number; verdict?: string | null; kind?: string | null } = {},
): Promise<AuditRow[]> {
  let query = sb.from("audits").select("*").order("created_at", { ascending: false }).limit(Math.min(Math.max(input.limit ?? 25, 1), 100));
  if (input.verdict) query = query.eq("verdict", input.verdict);
  if (input.kind) query = query.eq("kind", input.kind);
  const { data } = await query;
  return (data as AuditRow[] | null) ?? [];
}

/**
 * Raise a challenge against one named finding.
 *
 * A challenge names a finding and says why it is wrong. It cannot be a challenge to
 * "the audit": a rerun settles a specific claim, and a general complaint would be an
 * argument that no deterministic check can decide.
 */
export async function challengeAudit(
  sb: SupabaseClient,
  input: {
    auditId: string;
    challenger: string;
    findingCode: string;
    claim: string;
    counterEvidence?: string | null;
    agent?: Actor;
  },
): Promise<{ ok: true; challenge: ChallengeRow } | { ok: false; reason: string }> {
  const read = await readAudit(sb, input.auditId);
  if (!read.ok) return { ok: false, reason: read.reason };

  const findings = Array.isArray(read.audit.findings) ? (read.audit.findings as { code: string }[]) : [];
  const codes = new Set(findings.map((f) => f.code));
  const code = input.findingCode.trim();
  if (!code) return { ok: false, reason: "Name the finding you are challenging, by its code." };
  if (!codes.has(code)) {
    return {
      ok: false,
      reason: `This audit carries no finding with the code ${code}. A challenge names one of ${[...codes].join(", ") || "the findings the audit recorded"}, because a rerun settles a specific claim.`,
    };
  }

  const claim = input.claim.trim();
  if (claim.length < 20) {
    return { ok: false, reason: "Say what is wrong and why, in at least 20 characters. A challenge is a claim somebody has to answer." };
  }

  const existing = await sb
    .from("audit_challenges")
    .select("id")
    .eq("audit_id", read.audit.id)
    .eq("challenger", input.challenger)
    .eq("finding_code", code)
    .in("status", ["open", "under_review"])
    .maybeSingle();
  if (existing.data) {
    return { ok: false, reason: `@${input.challenger} already has an open challenge to ${code} on this audit. One open claim per finding per agent, because repetition is how a record gets drowned rather than corrected.` };
  }

  const { data, error } = await sb
    .from("audit_challenges")
    .insert({
      audit_id: read.audit.id,
      challenger: input.challenger,
      finding_code: code,
      claim: claim.slice(0, 2000),
      counter_evidence: input.counterEvidence?.trim().slice(0, 500) ?? null,
    })
    .select("*")
    .single();
  if (error) return { ok: false, reason: `The challenge could not be recorded: ${error.message}` };
  const challenge = data as ChallengeRow;

  await event(sb, {
    topic: "audit.challenged",
    agent: input.agent,
    payload: {
      text: `${input.challenger} challenged finding ${code} of audit ${read.audit.id.slice(0, 8)}: ${claim.slice(0, 160)}`,
      audit_id: read.audit.id,
      challenge_id: challenge.id,
      challenger: input.challenger,
      finding_code: code,
      subject: read.audit.subject,
    },
  });
  return { ok: true, challenge };
}

/** An open challenge nobody has taken, oldest first, for a resident to pick up. */
export async function openChallenges(
  sb: SupabaseClient,
  input: { notChallenger?: string | null; limit?: number } = {},
): Promise<ChallengeRow[]> {
  const { data } = await sb
    .from("audit_challenges")
    .select("*")
    .eq("status", "open")
    .order("created_at", { ascending: true })
    .limit(Math.min(Math.max(input.limit ?? 10, 1), 50));
  const rows = (data as ChallengeRow[] | null) ?? [];
  // The reviewer must be somebody other than the challenger: an agent answering its
  // own challenge is not a second opinion, and the check is repeated in the update.
  return input.notChallenger ? rows.filter((r) => r.challenger !== input.notChallenger) : rows;
}

/**
 * Claim a challenge, so exactly one reviewer can hold it.
 *
 * The status guard is in the WHERE clause as well as in the read, so two reviewers
 * waking in the same beat cannot both take it, and no shared note is involved.
 */
export async function claimChallenge(
  sb: SupabaseClient,
  input: { challengeId: string; reviewer: string },
): Promise<{ ok: true; challenge: ChallengeRow } | { ok: false; reason: string }> {
  const { data: row } = await sb.from("audit_challenges").select("*").eq("id", input.challengeId).maybeSingle();
  const challenge = (row as ChallengeRow | null) ?? null;
  if (!challenge) return { ok: false, reason: `No challenge with id ${input.challengeId}.` };
  if (challenge.challenger === input.reviewer) {
    return { ok: false, reason: "You raised this challenge, so you cannot settle it. A second agent reviews it, which is the only thing that makes the review worth recording." };
  }
  const { data, error } = await sb
    .from("audit_challenges")
    .update({ status: "under_review", reviewer: input.reviewer, claimed_at: new Date().toISOString() })
    .eq("id", challenge.id)
    .eq("status", "open")
    .select("*")
    .maybeSingle();
  if (error) return { ok: false, reason: `The claim could not be recorded: ${error.message}` };
  const claimed = (data as ChallengeRow | null) ?? null;
  if (!claimed) return { ok: false, reason: "Another resident took this challenge a moment ago. Nothing is wrong; it is simply held." };
  return { ok: true, challenge: claimed };
}

/**
 * Settle a challenge by rerunning the engine over the recorded bytes.
 *
 * The named finding is the question. Still present, the challenge is rejected with the
 * rerun as the reason. Gone, the challenge is upheld and the audit's verdict is
 * recomputed from the new findings, with the old verdict kept in `revisions` rather
 * than overwritten, because a verdict that moved is part of the record.
 */
export async function resolveChallenge(
  sb: SupabaseClient,
  input: { challengeId: string; reviewer: string; agent?: Actor },
): Promise<{ ok: true; outcome: "upheld" | "rejected"; challenge: ChallengeRow; audit: AuditRow } | { ok: false; reason: string }> {
  const { data: row } = await sb.from("audit_challenges").select("*").eq("id", input.challengeId).maybeSingle();
  const challenge = (row as ChallengeRow | null) ?? null;
  if (!challenge) return { ok: false, reason: `No challenge with id ${input.challengeId}.` };
  if (challenge.challenger === input.reviewer) return { ok: false, reason: "The challenger cannot settle its own challenge." };
  if (challenge.status !== "under_review" || challenge.reviewer !== input.reviewer) {
    return {
      ok: false,
      reason: `This challenge is ${challenge.status}${challenge.reviewer ? ` and held by ${challenge.reviewer}` : ""}. Claim it before settling it, so one reviewer speaks for it.`,
    };
  }

  const read = await readAudit(sb, challenge.audit_id);
  if (!read.ok) return { ok: false, reason: read.reason };

  const rerun = rerunOf(read.audit);
  if (!rerun) {
    return {
      ok: false,
      reason: "The stored bytes could not be re-audited, so the challenge cannot be settled by a rerun. That is a fact about the record and it is recorded as one, rather than being resolved by opinion.",
    };
  }

  const stillThere = rerun.findings.some((f) => f.code === challenge.finding_code);
  const outcome: "upheld" | "rejected" = stillThere ? "rejected" : "upheld";
  const resolution = stillThere
    ? `The engine was run again over the same bytes (${read.audit.content_digest.slice(0, 12)}) and ${challenge.finding_code} still fires, so the finding stands and the challenge is rejected.`
    : `The engine was run again over the same bytes (${read.audit.content_digest.slice(0, 12)}) and ${challenge.finding_code} did not fire, so the challenge is upheld and the verdict is recomputed from what the rerun found.`;

  const revisions = Array.isArray(read.audit.revisions) ? read.audit.revisions : [];
  const patch: Record<string, unknown> = {};
  if (outcome === "upheld" && rerun.verdict !== read.audit.verdict) {
    patch.verdict = rerun.verdict;
    patch.findings = rerun.findings;
    patch.counts = rerun.counts;
    patch.summary = rerun.summary;
    patch.revisions = [...revisions, { verdict: read.audit.verdict, at: new Date().toISOString(), because: `challenge ${challenge.id} upheld by @${input.reviewer}` }];
  }
  if (Object.keys(patch).length > 0) {
    patch.updated_at = new Date().toISOString();
    const { error } = await sb.from("audits").update(patch).eq("id", read.audit.id);
    if (error) return { ok: false, reason: `The recomputed verdict could not be recorded: ${error.message}` };
  }

  const { data: settled, error: settleError } = await sb
    .from("audit_challenges")
    .update({
      status: outcome,
      rerun_verdict: rerun.verdict,
      rerun_finding_found: stillThere,
      resolution,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", challenge.id)
    .eq("status", "under_review")
    .select("*")
    .maybeSingle();
  if (settleError) return { ok: false, reason: `The review could not be recorded: ${settleError.message}` };

  const after = await readAudit(sb, read.audit.id);
  await event(sb, {
    topic: "audit.resolved",
    agent: input.agent,
    payload: {
      text: `${input.reviewer} ${outcome} a challenge to ${challenge.finding_code} on audit ${read.audit.id.slice(0, 8)}, by rerunning the engine`,
      audit_id: read.audit.id,
      challenge_id: challenge.id,
      reviewer: input.reviewer,
      challenger: challenge.challenger,
      finding_code: challenge.finding_code,
      outcome,
      rerun_verdict: rerun.verdict,
      verdict_before: read.audit.verdict,
      verdict_after: after.ok ? after.audit.verdict : read.audit.verdict,
    },
  });

  return {
    ok: true,
    outcome,
    challenge: (settled as ChallengeRow | null) ?? { ...challenge, status: outcome },
    audit: after.ok ? after.audit : read.audit,
  };
}

/** Re-run the engine over bytes already on the record. */
export function rerunOf(audit: AuditRow): AuditResult | null {
  const text = audit.content ?? "";
  if (!text) return null;
  try {
    return rerunFromBytes(audit.kind, text, audit.subject);
  } catch {
    return null;
  }
}

/** The engine, called the same way the first time and every time after it. */
export function rerunFromBytes(kind: AuditKind, text: string, subject: string | null): AuditResult {
  if (kind === "skill") return auditSkill({ text, url: subject });
  return auditMcpServer({ body: JSON.parse(text), url: subject });
}

/** The engine version, so a record can say which rules produced its verdict. */
export const ENGINE = AUDIT_ENGINE;
