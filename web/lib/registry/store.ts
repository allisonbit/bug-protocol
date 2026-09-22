import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SITE_URL } from "@/lib/site";
import { REGISTRY_DISCLOSURE, attributionOf } from "./clawhub";
import { rankGaps, uncoveredTopicKeys, type GapRow, type TopicRow } from "./gaps";
import { readRegistryState, type RegistryState } from "./crawl";

/**
 * READING THE MIRROR.
 *
 * Every export here is a read, and every one of them carries three things the registry's
 * own API terms ask for and a reader needs: the canonical page on clawhub.ai, both verdicts
 * with the digest the second one is bound to, and the statement that ClawHub does not
 * endorse any of this. They are attached in one place, `registryView`, because a
 * requirement that is restated per door is a requirement that goes missing from the fourth,
 * and there are more than four doors onto this table.
 *
 * WHAT A READER NEVER GETS. The document text. Not for space, and not to be coy: the audit
 * record holds the bytes, which is what makes a verdict checkable, and this table holds a
 * verdict and a digest. An agent that wants the second is reading a security judgement. An
 * agent that received the first would be following a stranger's instructions, and the whole
 * wave is arranged so that cannot happen by accident.
 */

/** The columns this layer reads. Named rather than `*` so a new column is a decision. */
const COLUMNS =
  "ref, owner_handle, slug, display_name, summary, topics, tags, installs, latest_version, " +
  "registry_created_at, registry_updated_at, canonical_url, clawhub_verdict, clawhub_reason_codes, " +
  "digest, swamp_verdict, audit_id, agreement, audited_at, triage_reason, audit_error, capability, cited_at, blocked";

export type RegistryDbRow = {
  ref: string;
  owner_handle: string;
  slug: string;
  display_name: string | null;
  summary: string | null;
  topics: string[] | null;
  tags: Record<string, string> | null;
  installs: number | string | null;
  latest_version: string | null;
  registry_created_at: string | null;
  registry_updated_at: string | null;
  canonical_url: string;
  clawhub_verdict: string | null;
  clawhub_reason_codes: string[] | null;
  digest: string | null;
  swamp_verdict: string | null;
  audit_id: string | null;
  agreement: string | null;
  audited_at: string | null;
  triage_reason: string | null;
  audit_error: string | null;
  capability: string | null;
  cited_at: string | null;
  blocked: boolean | null;
};

/** One entry as every public door serves it. */
export type RegistryEntry = {
  ref: string;
  name: string;
  attribution: string;
  summary: string;
  topics: string[];
  installs: number;
  version: string | null;
  registry_updated_at: string | null;
  canonical_url: string;
  clawhub: { verdict: string | null; reason_codes: string[]; blocked: boolean };
  swamp: {
    verdict: string | null;
    audit_id: string | null;
    audit_url: string | null;
    digest: string | null;
    agreement: string | null;
    audited_at: string | null;
    why: string | null;
    error: string | null;
  };
  cited: { capability: string; at: string } | null;
  disclosure: string;
};

function asInt(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * One row as a reader gets it.
 *
 * Two deliberate choices. A missing summary reads as an empty string rather than as a
 * placeholder that looks like content, and a missing verdict reads as null rather than as
 * "clean", because this deployment publishing a verdict nobody reached is the exact failure
 * the whole record exists to prevent.
 */
export function registryView(row: RegistryDbRow): RegistryEntry {
  const installs = asInt(row.installs);
  return {
    ref: row.ref,
    name: row.display_name?.trim() || row.slug,
    attribution: attributionOf(row),
    summary: row.summary?.trim() ?? "",
    topics: row.topics ?? [],
    installs,
    version: row.latest_version,
    registry_updated_at: row.registry_updated_at,
    canonical_url: row.canonical_url,
    clawhub: {
      verdict: row.clawhub_verdict,
      reason_codes: row.clawhub_reason_codes ?? [],
      blocked: row.blocked === true,
    },
    swamp: {
      verdict: row.swamp_verdict,
      audit_id: row.audit_id,
      audit_url: row.audit_id ? `${SITE_URL}/audits/${row.audit_id}` : null,
      digest: row.digest,
      agreement: row.agreement,
      audited_at: row.audited_at,
      why: row.triage_reason,
      error: row.audit_error,
    },
    cited: row.capability && row.cited_at ? { capability: row.capability, at: row.cited_at } : null,
    disclosure: REGISTRY_DISCLOSURE,
  };
}

/** PostgREST reads `,` and parentheses inside `or(...)` as syntax, so they are stripped. */
function searchTerm(q: string): string {
  return q.replace(/[,()*"\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 64);
}

export type RegistrySearch = {
  entries: RegistryEntry[];
  matched: number;
  note: string;
  topic: string | null;
  q: string | null;
  sort: "installs" | "updated" | "name";
};

/**
 * Search the mirrored registry.
 *
 * Ordered by installs by default, which is the order a directory is read in and the one the
 * generated column exists for. Filters are applied in the database rather than after the
 * fact, so the count a caller gets is the count that matched rather than the size of a page.
 */
export async function searchRegistry(
  sb: SupabaseClient,
  params: { q?: string | null; topic?: string | null; verdict?: string | null; agreement?: string | null; minInstalls?: number; sort?: string; limit?: number; offset?: number } = {},
): Promise<RegistrySearch> {
  const limit = Math.min(Math.max(Math.floor(params.limit ?? 40), 1), 200);
  const offset = Math.max(Math.floor(params.offset ?? 0), 0);
  const sort: RegistrySearch["sort"] = params.sort === "updated" ? "updated" : params.sort === "name" ? "name" : "installs";
  const q = params.q ? searchTerm(params.q) : "";

  let query = sb.from("skill_registry").select(COLUMNS, { count: "exact" }).eq("blocked", false);
  if (q) {
    // Across what a directory can usefully match on: the publisher's name for it, the
    // identity, and the summary they wrote. Quotes inside are stripped by searchTerm, so a
    // term cannot close the filter and append its own clause.
    query = query.or(`display_name.ilike.%${q}%,slug.ilike.%${q}%,summary.ilike.%${q}%,owner_handle.ilike.%${q}%`);
  }
  if (params.topic) query = query.contains("topics", [params.topic]);
  if (params.verdict) query = query.eq("swamp_verdict", params.verdict);
  if (params.agreement) query = query.eq("agreement", params.agreement);
  if (params.minInstalls && params.minInstalls > 0) query = query.gte("installs", Math.floor(params.minInstalls));

  query =
    sort === "updated"
      ? query.order("registry_updated_at", { ascending: false, nullsFirst: false })
      : sort === "name"
        ? query.order("slug", { ascending: true })
        : query.order("installs", { ascending: false, nullsFirst: false });

  const { data, error, count } = await query.range(offset, offset + limit - 1);
  if (error) throw new Error(error.message);

  // Cast through `unknown` because the chained filter builder loses the select's shape:
  // the compiler cannot see which rows PostgREST will send after an `or(...)` clause, and
  // guessing is exactly what this cast refuses to do.
  const rows = (data as unknown as RegistryDbRow[] | null) ?? [];
  return {
    entries: rows.map(registryView),
    matched: count ?? rows.length,
    topic: params.topic ?? null,
    q: params.q ?? null,
    sort,
    note:
      "A cached mirror of the public ClawHub registry. Each entry names the canonical page and carries two verdicts: the registry's own moderation, and an independent audit of the same bytes by this deployment, bound to their SHA-256.",
  };
}

/** One mirrored skill by its owner-qualified ref. */
export async function readRegistrySkill(sb: SupabaseClient, ref: string): Promise<RegistryEntry | null> {
  const { data } = await sb.from("skill_registry").select(COLUMNS).eq("ref", ref.trim().toLowerCase()).maybeSingle();
  const row = (data as RegistryDbRow | null) ?? null;
  return row ? registryView(row) : null;
}

/** Every topic the mirror counts, biggest first. */
export async function readTopicRows(sb: SupabaseClient, limit = 500): Promise<TopicRow[]> {
  const { data } = await sb
    .from("skill_registry_topics")
    .select("topic, skill_count, total_installs, audited_count, suspicious_count, reported_at")
    .order("skill_count", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 2000));
  return (data as TopicRow[] | null) ?? [];
}

/** The topics this deployment has no capability for, which is what triage prioritises. */
export async function uncoveredTopics(sb: SupabaseClient): Promise<Set<string>> {
  return uncoveredTopicKeys(await readTopicRows(sb, 2000));
}

/** The gaps, largest first, each with the documents that make it up. */
export async function readGaps(
  sb: SupabaseClient,
  options: { limit?: number; includeReported?: boolean; examples?: number } = {},
): Promise<{ gaps: (GapRow & { examples: RegistryEntry[] })[]; uncovered: number; topics: number }> {
  const rows = await readTopicRows(sb, 2000);
  const gaps = rankGaps(rows, { limit: options.limit ?? 25, includeReported: options.includeReported ?? true });
  const examples = Math.min(Math.max(options.examples ?? 5, 0), 20);

  const withExamples = await Promise.all(
    gaps.map(async (gap) => {
      if (examples === 0) return { ...gap, examples: [] as RegistryEntry[] };
      const { data } = await sb
        .from("skill_registry")
        .select(COLUMNS)
        .eq("blocked", false)
        .contains("topics", [gap.topic])
        .order("installs", { ascending: false, nullsFirst: false })
        .limit(examples);
      return { ...gap, examples: ((data as RegistryDbRow[] | null) ?? []).map(registryView) };
    }),
  );

  return { gaps: withExamples, uncovered: uncoveredTopicKeys(rows).size, topics: rows.length };
}

/** Where the two engines disagree about the same bytes, newest first. */
export async function readDisagreements(sb: SupabaseClient, limit = 20): Promise<RegistryEntry[]> {
  const { data } = await sb
    .from("skill_registry")
    .select(COLUMNS)
    .eq("blocked", false)
    .in("agreement", ["swamp_stricter", "swamp_looser"])
    .order("audited_at", { ascending: false, nullsFirst: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  return ((data as RegistryDbRow[] | null) ?? []).map(registryView);
}

/** The registry skills cited against one of this deployment's own capabilities. */
export async function readCitations(sb: SupabaseClient, capability: string, limit = 10): Promise<RegistryEntry[]> {
  const { data } = await sb
    .from("skill_registry")
    .select(COLUMNS)
    .eq("blocked", false)
    .eq("capability", capability)
    .not("cited_at", "is", null)
    .order("installs", { ascending: false, nullsFirst: false })
    .limit(Math.min(Math.max(limit, 1), 50));
  return ((data as RegistryDbRow[] | null) ?? []).map(registryView);
}

export type RegistryCoverage = {
  mirrored: number;
  blocked: number;
  audited: number;
  unreadable: number;
  agree: number;
  swamp_stricter: number;
  swamp_looser: number;
  sorted_by_registry_flags: number;
  cited: number;
  topics: number;
  /** How fresh the mirror is, which is half of what makes the numbers readable. */
  crawl: Pick<RegistryState, "sort" | "complete" | "pages_seen" | "skills_seen" | "sweeps" | "last_run_at" | "last_error"> | null;
};

/** Every count the registry page reports, plus when the mirror last looked. */
export async function readCoverage(sb: SupabaseClient): Promise<RegistryCoverage> {
  const [{ data }, state] = await Promise.all([sb.rpc("registry_coverage"), readRegistryState(sb).catch(() => null)]);
  const counts = (data as Record<string, number> | null) ?? {};
  const at = (k: string) => Math.max(0, Math.floor(Number(counts[k]) || 0));
  return {
    mirrored: at("mirrored"),
    blocked: at("blocked"),
    audited: at("audited"),
    unreadable: at("unreadable"),
    agree: at("agree"),
    swamp_stricter: at("swamp_stricter"),
    swamp_looser: at("swamp_looser"),
    sorted_by_registry_flags: at("sorted_by_registry_flags"),
    cited: at("cited"),
    topics: at("topics"),
    crawl: state
      ? {
          sort: state.sort,
          complete: state.complete,
          pages_seen: state.pages_seen,
          skills_seen: state.skills_seen,
          sweeps: state.sweeps,
          last_run_at: state.last_run_at,
          last_error: state.last_error,
        }
      : null,
  };
}
