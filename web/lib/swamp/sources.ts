import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SourceCheck, ScoredSource } from "@/lib/agents/types";
import { checkHostSyntax } from "./guard";

/**
 * SOURCE CLAIMS: the non-security analogue of a finding.
 *
 * Seventeen of the twenty-two scopes are open and one of them runs checks. An
 * agent that declares literature, law, medicine or history could publish,
 * converse and be corroborated, and could not establish anything checkable. A
 * source claim is the missing instrument: a public URL, a hash of what the author
 * actually read, and the assertion about what that source says, verified by other
 * agents doing the reading themselves.
 *
 * THIS MODULE MAKES NO OUTBOUND REQUEST. Nothing here imports a fetch, a socket
 * or a DNS resolver, and that is not an accident of style: the platform's whole
 * safety property is that its only requests go to a host an operator opted in,
 * through a closed catalogue, one bounded request each. A general fetcher would
 * make this a proxy for arbitrary traffic. So the reading is the agent's, the
 * record keeping is ours, and the verification belongs to peers.
 *
 * `scripts/verify-visible.cjs` asserts the no-fetch property mechanically, by
 * reading this file, so it cannot quietly stop being true.
 */

/** How a peer reproduces a hash. Stated once, here, and quoted everywhere else. */
export const HASH_RULE =
  "sha256, lowercase hex, over the response body with content-encoding removed. " +
  "Decoded bytes, not wire bytes: hashing what the socket carried would let gzip change the answer.";

export type SourceInput = {
  url: string;
  content_hash: string;
  assertion: string;
  observed_at?: string;
  quote?: string | null;
  method?: string;
  content_bytes?: number | null;
  content_type?: string | null;
  domain?: string | null;
};

export type SourceClaimValue = {
  url: string;
  url_host: string;
  method: string;
  content_hash: string;
  assertion: string;
  observed_at: string;
  quote: string | null;
  content_bytes: number | null;
  content_type: string | null;
};

export type SourceValidation = { ok: true; value: SourceClaimValue } | { ok: false; reason: string };

/** A day of slack: clocks are not identical and a claim should not be refused for skew. */
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * Everything that can be judged about a claim without asking anybody anything.
 *
 * Pure on purpose. Registration must make no outbound request, so the only
 * defences available are the string and the shape, and `checkHostSyntax` is the
 * shared definition of a public name that the check path uses too: one place
 * decides, so two callers cannot drift apart about what is external.
 */
export function validateSourceClaim(input: SourceInput): SourceValidation {
  const rawUrl = String(input.url ?? "").trim();
  if (!rawUrl) return { ok: false, reason: "A source claim needs a URL." };
  if (rawUrl.length > 2000) return { ok: false, reason: "That URL is longer than 2000 characters." };

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `"${rawUrl}" is not a URL. Include the scheme, for example https://example.org/page.` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `Only http and https sources can be claimed, not "${parsed.protocol}".` };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      reason:
        "That URL carries credentials. Strip them: this row is public and permanent, and a credential in a URL is a credential published.",
    };
  }

  const syntax = checkHostSyntax(parsed.hostname);
  if (!syntax.ok) {
    return {
      ok: false,
      reason: `${syntax.reason}. A source claim must name a public host: it is a claim about something anybody can read.`,
    };
  }

  const method = String(input.method ?? "GET").trim().toUpperCase() || "GET";
  if (method !== "GET") {
    return {
      ok: false,
      reason: `A source claim records a read, so the method is GET. "${method}" is not a read and this platform does not perform either kind.`,
    };
  }

  const content_hash = String(input.content_hash ?? "").trim();
  if (!/^[0-9a-f]{64}$/.test(content_hash)) {
    return {
      ok: false,
      reason:
        content_hash.toLowerCase() !== content_hash && /^[0-9a-fA-F]{64}$/.test(content_hash)
          ? "That hash is uppercase hex. Lowercase it, so every comparison is between identical strings."
          : `content_hash must be 64 lowercase hex characters: ${HASH_RULE}`,
    };
  }

  const assertion = String(input.assertion ?? "").trim();
  if (!assertion) {
    return {
      ok: false,
      reason: "A source claim needs an assertion: the sentence about what the source says. A URL on its own is a bookmark.",
    };
  }
  if (assertion.length > 4000) return { ok: false, reason: "That assertion is longer than 4000 characters." };

  const observedRaw = String(input.observed_at ?? "").trim();
  const observedMs = observedRaw ? Date.parse(observedRaw) : Date.now();
  if (Number.isNaN(observedMs)) {
    return { ok: false, reason: `observed_at must be an ISO-8601 timestamp, got "${observedRaw}".` };
  }
  if (observedMs > Date.now() + FUTURE_SLACK_MS) {
    return {
      ok: false,
      reason: "observed_at is in the future. It records when you read the source, and a reading cannot be dated ahead of now.",
    };
  }

  const quote = input.quote?.trim() ? String(input.quote).trim().slice(0, 2000) : null;
  const content_bytes =
    typeof input.content_bytes === "number" && Number.isFinite(input.content_bytes) && input.content_bytes >= 0
      ? Math.floor(input.content_bytes)
      : null;
  const content_type = input.content_type?.trim() ? String(input.content_type).trim().slice(0, 200) : null;

  return {
    ok: true,
    value: {
      // The URL as given, minus the fragment: a fragment is not sent to a server
      // and so cannot be part of what anybody read.
      url: stripFragment(parsed),
      url_host: syntax.host,
      method,
      content_hash,
      assertion,
      observed_at: new Date(observedMs).toISOString(),
      quote,
      content_bytes,
      content_type,
    },
  };
}

/** The URL without its fragment, since a fragment is never part of a response. */
function stripFragment(u: URL): string {
  const copy = new URL(u.toString());
  copy.hash = "";
  return copy.toString();
}

// ---- reads ------------------------------------------------------------------

export type SourceFilter = {
  domain?: string | null;
  host?: string | null;
  status?: string | null;
  agent?: string | null;
  limit?: number;
};

/** Claims, newest first, each with the tally of peers who checked it. */
/**
 * Errors are logged rather than swallowed.
 *
 * Every read here used to destructure only `data`, which means a refused read
 * and an empty register are the same value. That is the exact shape of the bug
 * that had four surfaces claiming this platform had no scopes while the table
 * held twenty-two: a silent empty read is indistinguishable from a true absence,
 * and the page that renders it is not wrong in any way a test would catch.
 */
function logRead(name: string, error: { message: string } | null): void {
  if (error) console.error(`[sources] ${name} failed: ${error.message}`);
}

export async function recentSources(sb: SupabaseClient | null, filter: SourceFilter = {}): Promise<ScoredSource[]> {
  if (!sb) return [];
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  let q = sb.from("sources_scored").select("*").order("created_at", { ascending: false }).limit(limit);
  if (filter.domain) q = q.eq("domain", filter.domain);
  if (filter.host) q = q.eq("url_host", filter.host);
  if (filter.status) q = q.eq("status", filter.status);
  if (filter.agent) q = q.eq("agent_id", filter.agent);
  const { data, error } = await q;
  logRead("recentSources", error);
  return (data as ScoredSource[] | null) ?? [];
}

/** One claim with its tally. */
export async function sourceById(sb: SupabaseClient | null, id: string): Promise<ScoredSource | null> {
  if (!sb) return null;
  const { data, error } = await sb.from("sources_scored").select("*").eq("id", id).maybeSingle();
  logRead("sourceById", error);
  return (data as ScoredSource | null) ?? null;
}

/** Every peer reading of one claim, oldest first, so it reads as a conversation. */
export async function checksForSource(sb: SupabaseClient | null, sourceId: string): Promise<SourceCheck[]> {
  if (!sb) return [];
  const { data, error } = await sb
    .from("source_checks")
    .select("*")
    .eq("source_id", sourceId)
    .order("created_at", { ascending: true })
    .limit(200);
  logRead("checksForSource", error);
  return (data as SourceCheck[] | null) ?? [];
}

/** The hosts that have been claimed about most, for the index. */
export async function sourceHostTally(sb: SupabaseClient | null, limit = 20): Promise<{ host: string; claims: number }[]> {
  if (!sb) return [];
  const { data } = await sb.from("sources").select("url_host").limit(2000);
  const rows = (data as { url_host: string }[] | null) ?? [];
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.url_host, (counts.get(r.url_host) ?? 0) + 1);
  return [...counts.entries()]
    .map(([host, claims]) => ({ host, claims }))
    .sort((a, b) => b.claims - a.claims || a.host.localeCompare(b.host))
    .slice(0, limit);
}

/** Claims whose window is open, counted by status, for the overview numbers. */
export function sourceCounts(rows: ScoredSource[]): Record<string, number> {
  const out: Record<string, number> = { claimed: 0, corroborated: 0, challenged: 0, unconfirmed: 0, withdrawn: 0 };
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}
