import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AUDIT_ENGINE,
  SEVERITIES,
  auditMcpServer,
  auditSkill,
  type AuditKind,
  type AuditResult,
  type Severity,
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
  /**
   * Every verdict this record has held, oldest first, with the engine that produced the
   * old one when a ruleset change is what moved it. `engine` is absent on a revision
   * written before this was recorded, which is the honest value rather than a guess.
   */
  revisions: { verdict: Verdict; at: string; because: string; engine?: string }[];
  /**
   * Every document a deep scan read, with its digest and its own verdict. Empty for an
   * ordinary one-document audit, which is the honest value rather than a placeholder:
   * nothing here was read from a declaration, so there is no set to report.
   */
  documents: { uri: string; because: string; digest: string; bytes: number; verdict: Verdict; findings: number; error?: string }[];
  /**
   * The x402 receipt for a paid deep scan, or null. Kept on the audit rather than only in
   * the payments table, because a receipt a reader has to join to find is a receipt the
   * record does not carry.
   */
  payment: AuditReceipt | null;
  created_at: string;
  updated_at: string;
};

/** What a paid scan's receipt says, in the shape the record and the page both read. */
export type AuditReceipt = {
  network: string;
  payer: string;
  amount: string;
  /** `verified` and `settled` stay different facts, as everywhere else here. */
  status: "verified" | "settled";
  settlementRef: string | null;
  paymentId: string | null;
  at: string;
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
  if (input.kind === "skill" || input.kind === "instructions") {
    // Two shapes, one set of pattern rules. `instructions` reads an AGENTS.md, a CLAUDE.md
    // or a rules directory: the same sentences do the same things there, and the only
    // rules that do not apply are the frontmatter requirements a non-skill cannot meet.
    return {
      ok: true,
      result: auditSkill({ text: body, url, shape: input.kind === "instructions" ? "instructions" : "skill" }),
      source,
      url,
      text: body,
    };
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
    /**
     * The receipt for a paid deep scan, when one was bought.
     *
     * Passed in rather than looked up, because the payment and the verdict have to land
     * together: a record written with the receipt missing is a record that cannot say
     * what paid for it, and the reader has no way to tell that from a free scan.
     */
    payment?: AuditReceipt | null;
  },
): Promise<{ ok: true; audit: AuditRow; deduped: boolean } | { ok: false; reason: string }> {
  const r = input.result;
  // THE BINDING IS BYTES AND RULESET, and the ruleset half is why this lookup takes an
  // engine. Without it, a document already on the record could never be re-read under
  // changed rules: the submission would be answered with the verdict the old rules
  // produced, presented as the current one, with the staleness visible only to a reader
  // who knows what the `engine` column means. With it, a ruleset change writes a new row
  // and the old verdict stays as the honest historical reading.
  const existing = await boundLookup(sb, r.kind, r.digest, input.subject, r.engine);
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
      // A deep scan's own set of documents, when the result carried one. Read from the
      // result rather than passed separately, so a result that read five documents cannot
      // be recorded as having read one.
      documents: Array.isArray((r as unknown as { documents?: unknown[] }).documents) ? (r as unknown as { documents: unknown[] }).documents : [],
      ...(input.payment ? { payment: input.payment } : {}),
    })
    .select("*")
    .single();
  if (error) {
    // 23505 means a concurrent write of the same bytes won the race. Returning the
    // existing record is the honest answer: the audit happened once.
    if (error.code === "23505") {
      const row = await boundLookup(sb, r.kind, r.digest, input.subject, r.engine);
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
      // Whether a deep scan was bought is on the bus row as well as on the record, so the
      // feed and the page cannot disagree about which scans somebody paid for.
      paid: Boolean(input.payment),
      documents: (r as unknown as { documents?: unknown[] }).documents?.length ?? 0,
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
async function boundLookup(
  sb: SupabaseClient,
  kind: AuditKind,
  digest: string,
  subject: string | null,
  /** The ruleset, which is half of what an audit is bound to. */
  engine: string,
): Promise<AuditRow | null> {
  let query = sb.from("audits").select("*").eq("kind", kind).eq("content_digest", digest).eq("engine", engine);
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
 * The running security record: everything the platform has read, found, and changed its
 * mind about.
 *
 * Assembled from four reads rather than from a summary table, because a summary is a
 * second place for the truth to live and the whole point of this surface is that every
 * line can be traced back to a row. The counts are computed from the ROWS THAT ARE
 * RETURNED, so a page cannot report a total its own list does not add up to.
 *
 * The bounds are said out loud in the returned object rather than hidden, because "no
 * findings" and "nothing loaded" are different facts and a record that blurred them
 * would be worse than no record.
 */
export type SecurityRecord = {
  scanned: {
    total: number;
    byVerdict: Record<string, number>;
    byKind: Record<string, number>;
    /**
     * Per submitter: how many documents it asked about, and the worst finding severity
     * any of them produced. A severity rather than a verdict, because "audited three
     * clean documents" and "audited three, one of them critical" are the two facts a
     * reader wants and a verdict count would blur them.
     */
    bySubmitter: { handle: string; audits: number; worst: Severity }[];
    rows: AuditRow[];
    /** True when more rows exist than were read into the page. */
    truncated: boolean;
  };
  found: {
    byCode: { code: string; severity: Severity; audits: number; findings: number; title: string }[];
    totalFindings: number;
  };
  fixed: {
    upheld: ChallengeRow[];
    /** Verdict moves that a challenge caused, read from the audits' own revision lists. */
    corrections: { auditId: string; subject: string | null; from: Verdict; to: Verdict; because: string; at: string }[];
    settled: number;
    open: number;
  };
  paid: { audits: number; atomic: bigint; rows: AuditRow[]; settled: number };
  limits: { auditsRead: number; auditsTotal: number | null; note: string };
};

/** How many audits the security record reads. Said in the return value, not implied. */
export const SECURITY_WINDOW = 200;

/** Fold findings, challenges and payments into one record. Pure, and takes rows as input. */
export function securityRecord(input: {
  audits: AuditRow[];
  challenges: ChallengeRow[];
  /** Total audits in the table, when the caller knows it. */
  total: number | null;
}): SecurityRecord {
  const { audits, challenges } = input;

  const byVerdict: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  const submitters = new Map<string, { audits: number; worst: Severity }>();
  // THE RANK RUNS MILDER TO WORSE, and this is the one place that reads it, because
  // getting the direction wrong here produces a security page that lists the mildest
  // finding first and calls a submitter's worst rule `info`. `SEVERITIES` is ordered
  // info, low, medium, high, critical, so MORE severe is a HIGHER index, and every
  // comparison below is written that way rather than against an intuition.
  const rankOf = (s: unknown): number => SEVERITIES.indexOf(s as Severity);
  const worstOf = (findings: unknown): Severity => {
    const list = Array.isArray(findings) ? (findings as { severity?: string }[]) : [];
    let worst: Severity = "info";
    let rank = -1;
    for (const f of list) {
      const idx = rankOf(f.severity);
      if (idx > rank) {
        rank = idx;
        worst = f.severity as Severity;
      }
    }
    return worst;
  };

  const codes = new Map<string, { code: string; severity: Severity; audits: Set<string>; findings: number; title: string }>();
  let totalFindings = 0;

  for (const row of audits) {
    byVerdict[row.verdict] = (byVerdict[row.verdict] ?? 0) + 1;
    byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    const clean = row.submitted_by || "anonymous";
    const prior = submitters.get(clean);
    const worst = worstOf(row.findings);
    submitters.set(clean, {
      audits: (prior?.audits ?? 0) + 1,
      worst: prior ? (rankOf(worst) > rankOf(prior.worst) ? worst : prior.worst) : worst,
    });
    const findings = Array.isArray(row.findings) ? (row.findings as { code?: string; severity?: string; title?: string }[]) : [];
    totalFindings += findings.length;
    for (const f of findings) {
      const code = typeof f.code === "string" ? f.code : "UNKNOWN";
      const entry = codes.get(code) ?? {
        code,
        severity: (f.severity as Severity) ?? "info",
        audits: new Set<string>(),
        findings: 0,
        title: typeof f.title === "string" ? f.title : "",
      };
      entry.audits.add(row.id);
      entry.findings += 1;
      // The worst severity seen for a code wins, so a rule that fired as `high` on one
      // document is not reported as `info` because another document tripped it mildly.
      if (rankOf(f.severity) > rankOf(entry.severity)) {
        entry.severity = f.severity as Severity;
      }
      codes.set(code, entry);
    }
  }

  const corrections: SecurityRecord["fixed"]["corrections"] = [];
  for (const row of audits) {
    const revisions = Array.isArray(row.revisions) ? row.revisions : [];
    for (const rev of revisions) {
      corrections.push({ auditId: row.id, subject: row.subject, from: rev.verdict, to: row.verdict, because: rev.because, at: rev.at });
    }
  }
  corrections.sort((a, b) => b.at.localeCompare(a.at));

  const upheld = challenges.filter((c) => c.status === "upheld");
  const settled = challenges.filter((c) => c.status === "upheld" || c.status === "rejected");
  const open = challenges.filter((c) => c.status === "open" || c.status === "under_review");

  const paidRows = audits.filter((a) => a.payment);
  const atomic = paidRows.reduce((sum, a) => {
    try {
      return sum + BigInt(String(a.payment?.amount ?? "0"));
    } catch {
      return sum;
    }
  }, 0n);

  return {
    scanned: {
      total: input.total ?? audits.length,
      byVerdict,
      byKind,
      bySubmitter: [...submitters.entries()]
        .map(([handle, v]) => ({ handle, audits: v.audits, worst: v.worst }))
        .sort((a, b) => b.audits - a.audits),
      rows: audits,
      truncated: input.total !== null && input.total > audits.length,
    },
    found: {
      byCode: [...codes.values()]
        .map((c) => ({ code: c.code, severity: c.severity, audits: c.audits.size, findings: c.findings, title: c.title }))
        // Worst first, then the code that fired on the most documents, then alphabetical
        // so two runs over the same rows produce the same page in the same order.
        .sort((a, b) => rankOf(b.severity) - rankOf(a.severity) || b.audits - a.audits || a.code.localeCompare(b.code)),
      totalFindings,
    },
    fixed: { upheld, corrections, settled: settled.length, open: open.length },
    paid: { audits: paidRows.length, atomic, rows: paidRows, settled: paidRows.filter((a) => a.payment?.status === "settled").length },
    limits: {
      auditsRead: audits.length,
      auditsTotal: input.total,
      note: `The record reads the ${audits.length} most recent audits and every challenge against them. Each line names the row it came from; nothing here is a number without a row behind it.`,
    },
  };
}

/** Read the record: the audits in the window, and every challenge that names one of them. */
export async function readSecurityRecord(sb: SupabaseClient, limit = SECURITY_WINDOW): Promise<SecurityRecord> {
  const bounded = Math.min(Math.max(limit, 1), 500);
  const { data: auditRows, count } = await sb
    .from("audits")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(bounded);
  const audits = (auditRows as AuditRow[] | null) ?? [];
  const ids = audits.map((a) => a.id);
  const challenges: ChallengeRow[] = [];
  if (ids.length > 0) {
    const { data } = await sb
      .from("audit_challenges")
      .select("*")
      .in("audit_id", ids)
      .order("created_at", { ascending: false })
      .limit(200);
    challenges.push(...((data as ChallengeRow[] | null) ?? []));
  }
  return securityRecord({ audits, challenges, total: typeof count === "number" ? count : null });
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
    // THE MOVED VERDICT NAMES THE ENGINE THAT MOVED IT. A rerun runs the CURRENT ruleset,
    // so a record whose verdict changes is a record read by two different rule sets, and
    // the old engine is kept on the revision it produced rather than being overwritten.
    // This is the case the whole ruleset-in-the-key change exists for: the rules themselves
    // moved, and a challenge is what proves it on the record.
    patch.engine = rerun.engine;
    patch.revisions = [
      ...revisions,
      {
        verdict: read.audit.verdict,
        at: new Date().toISOString(),
        because: `challenge ${challenge.id} upheld by @${input.reviewer}, rerun under ${rerun.engine}`,
        engine: read.audit.engine,
      },
    ];
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
