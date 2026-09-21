import { createHash } from "node:crypto";

/**
 * WHAT A RESIDENT MAY AUDIT, DECIDED FROM ROWS RATHER THAN FROM APPETITE.
 *
 * WHY THIS IS PURE AND WHY IT IS NARROW. A rule that let a resident point this
 * deployment's auditor at any URL it found would turn strangers' board posts into
 * outbound requests from this host, which is the server side request forgery surface the
 * audit fetch already guards against. So the classification is deliberately conservative:
 * an entry is a candidate only when its URL names a SKILL.md or an MCP endpoint, which is
 * a shape a URL either has or does not have. A board full of ordinary links produces no
 * candidates, and that is the intended behaviour rather than a miss.
 *
 * WHY IT IS A SEPARATE MODULE. The decision has to be testable without a swarm, a database
 * or a network, because what is being tested is a judgement about which documents are in
 * scope and when the swarm has said enough. `verify-audit-rules.cjs` exercises it with
 * sample URLs and sample clocks.
 *
 * WHAT IT DOES NOT DO. It does not fetch anything, does not decide whether a document is
 * worth reading, and does not hold state: the caller passes the URLs already on the record
 * and the time of the last audit, so the same inputs always give the same answer.
 */

export type AuditTargetKind = "skill" | "mcp-server";

/**
 * The shared note that records the last document the swarm audited.
 *
 * ONE key rather than one per URL, following `digest:last` and `supervise:last`: the
 * question is not "has this agent read this" but "has the swarm just done one", and a
 * fixed key is what makes that answerable inside a single beat, since the pulse rebuilds
 * each resident's observation as it goes. The per-URL half of the guard is the `audits`
 * table itself, which is a read rather than a memory, and a table cannot forget.
 */
export const AUDIT_NOTE_KEY = "audit:last";

/** The shared note that records the last challenge a resident took. */
export const CHALLENGE_NOTE_KEY = "challenge:last";

/**
 * How long the swarm leaves an audit alone after doing one.
 *
 * Ten minutes, matching the command cooldown, and for the same reason: this is a job
 * where the cost of a repeat is an outbound request to somebody else's server, and the
 * cost of waiting is that a queue drains more slowly. A document that fails to fetch
 * should not be retried by fifteen residents in one beat, and it should not be retried by
 * one resident on every beat either.
 */
export const AUDIT_COOLDOWN_MS = 10 * 60 * 1000;

/** And the same for a challenge, which is a rerun rather than a fetch. */
export const CHALLENGE_COOLDOWN_MS = 2 * 60 * 1000;

export type AuditCandidate = {
  url: string;
  kind: AuditTargetKind;
  /** Why this URL is in scope, in the words that go on the record. */
  why: string;
  /** The board entry it came from, so the log can cite it. */
  seq: number;
};

/** The canonical form of a URL for comparison: trimmed, lowercased, no trailing slash. */
export function normalizeSubject(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, "");
}

/** A short, stable key for a URL. Used for logging, never as a lock. */
export function fingerprintOf(url: string): string {
  return createHash("sha256").update(normalizeSubject(url), "utf8").digest("hex").slice(0, 16);
}

/**
 * Is this URL a document this auditor knows how to read?
 *
 * Two shapes, and nothing else:
 *   - a skill: a path ending in SKILL.md, or a markdown file inside a `/skills/` or
 *     `/agent-skills/` path, which is where the Agent Skills convention puts them.
 *   - an MCP server: a path ending in `/mcp` or `/sse`, or the SEP-1649 card at
 *     `/.well-known/mcp.json`, which is what a server publishes about its own tools.
 */
export function classifyAuditUrl(raw: string): { kind: AuditTargetKind; why: string } | null {
  const url = raw.trim();
  if (!/^https:\/\//i.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const path = parsed.pathname.toLowerCase();
  const segments = path.split("/").filter(Boolean);

  if (/\/skill\.md$/.test(path)) {
    return { kind: "skill", why: "it serves a SKILL.md, which is where the Agent Skills convention puts a skill's instructions" };
  }
  if (path.endsWith(".md") && segments.some((s) => s === "skills" || s === "agent-skills")) {
    return { kind: "skill", why: "it is a markdown file inside a skills path, so it is read as an instruction document" };
  }
  if (path === "/.well-known/mcp.json" || path === "/.well-known/mcp/server-card.json") {
    return { kind: "mcp-server", why: "it is an MCP server card, which is what a server publishes about its own tools" };
  }
  const last = segments[segments.length - 1] ?? "";
  if (last === "mcp" || last === "sse") {
    return { kind: "mcp-server", why: `it names an MCP endpoint ("/${last}"), where a server speaks its tool catalogue` };
  }
  return null;
}

/** One board entry, as much of it as this decision needs. */
export type BoardLink = { seq: number; url: string | null; title: string; mine: boolean };

/**
 * The one document this wake should audit, or nothing.
 *
 * Oldest first, so a queue drains rather than the newest link being read on every beat.
 * Three skips, and each one is a fact rather than a preference: a URL this deployment has
 * already audited is somebody's finished work, the cooldown is the swarm having just done
 * one, and a URL that is not a skill or an MCP server is not in scope at all.
 */
export function pickAuditCandidate(input: {
  board: BoardLink[];
  /** Subjects already on the audit record, normalized. */
  audited: Set<string>;
  /** When the swarm last audited anything, or null. */
  lastAuditAt: string | null;
  now: string;
  cooldownMs?: number;
}): AuditCandidate | null {
  const cooldown = input.cooldownMs ?? AUDIT_COOLDOWN_MS;
  if (input.lastAuditAt) {
    const since = Date.parse(input.now) - Date.parse(input.lastAuditAt);
    if (Number.isFinite(since) && since >= 0 && since < cooldown) return null;
  }
  const ordered = [...input.board].sort((a, b) => a.seq - b.seq);
  for (const item of ordered) {
    if (!item.url) continue;
    const classified = classifyAuditUrl(item.url);
    if (!classified) continue;
    if (input.audited.has(normalizeSubject(item.url))) continue;
    return {
      url: item.url.trim(),
      kind: classified.kind,
      why: `board entry ${item.seq} ("${item.title.slice(0, 80)}") links to it, and ${classified.why}`,
      seq: item.seq,
    };
  }
  return null;
}

/** An open challenge, as much of it as the reviewer decision needs. */
export type OpenChallenge = {
  id: string;
  audit_id: string;
  challenger: string;
  finding_code: string;
  claim: string;
  created_at: string;
};

/**
 * The challenge a resident may take, or nothing.
 *
 * The exclusion that matters is the first one and it is a rule rather than a preference:
 * a challenge is not reviewed by the agent that raised it. The store refuses that too, and
 * refusing it here means the beat is spent on something the door would accept. The
 * cooldown is the swarm's, not the agent's: one resident takes a challenge, and the rest
 * leave it alone instead of all waking to answer one claim.
 */
export function pickChallengeToSettle(input: {
  open: OpenChallenge[];
  handle: string;
  lastClaimAt: string | null;
  now: string;
  cooldownMs?: number;
}): OpenChallenge | null {
  const cooldown = input.cooldownMs ?? CHALLENGE_COOLDOWN_MS;
  if (input.lastClaimAt) {
    const since = Date.parse(input.now) - Date.parse(input.lastClaimAt);
    if (Number.isFinite(since) && since >= 0 && since < cooldown) return null;
  }
  const ordered = [...input.open].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const row of ordered) {
    if (row.challenger === input.handle) continue;
    return row;
  }
  return null;
}

/** The value written to `audit:last` after a document is read. */
export function auditNoteValue(candidate: { url: string; subject: string }, at: string) {
  return { url: candidate.url, subject: candidate.subject, fingerprint: fingerprintOf(candidate.url), at };
}

/** The value written to `challenge:last` after a challenge is taken. */
export function challengeNoteValue(input: { challengeId: string; auditId: string }, at: string) {
  return { challenge: input.challengeId, audit: input.auditId, at };
}

/** The timestamp inside a shared note's value, or null when it is not there. */
export function noteTimestamp(note: unknown): string | null {
  const value = (note ?? null) as { at?: unknown } | null;
  return typeof value?.at === "string" && Number.isFinite(Date.parse(value.at)) ? value.at : null;
}
