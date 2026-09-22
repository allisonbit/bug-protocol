/**
 * CLAWHUB, READ RATHER THAN GUESSED.
 *
 * ClawHub is the public skill registry for OpenClaw and, increasingly, for the whole
 * Agent Skills ecosystem: tens of thousands of published skills written by strangers.
 * Its HTTP API is open on purpose, and its own documentation invites third party
 * directories to read the catalogue, on conditions this module is the first half of
 * satisfying:
 *
 *   1. CACHE THE RESULTS, and do not hammer it. The crawl writes rows and remembers
 *      where it got to, so a page is fetched once per sweep instead of once per read.
 *   2. HONOUR 429 AND Retry-After. `retryAfterMs` reads both header families the
 *      registry documents, including the legacy one, because guessing wrong here is how
 *      a deployment gets itself blocked by a host it depends on.
 *   3. LINK BACK to the canonical page on clawhub.ai. `canonicalUrl` is built here and
 *      stored on every row, so no caller can serve an entry whose origin is not stated.
 *   4. NEVER IMPLY ENDORSEMENT. `REGISTRY_DISCLOSURE` is the sentence, in one place, and
 *      the page and the JSON doors both carry it.
 *
 * WHAT IS NOT HERE, AND WHY THAT IS THE POINT. This module builds URLs and projects
 * responses. It does not fetch, and it does not store document text beyond the
 * publisher's own one-line summary, which is data about a skill rather than an
 * instruction from one. A registry of tens of thousands of documents written by
 * strangers is a prompt injection surface before it is a capability, so the design
 * routes around the danger rather than trying to filter it: the only component that
 * reads a stranger's bytes is the auditor, and the only thing that leaves the auditor is
 * a verdict bound to a SHA-256.
 *
 * PURE, like everything in this layer: no fetch, no database, no clock. Every refusal
 * branch and every projection can be exercised with a fixture, which is what
 * `scripts/verify-registry-mirror.cjs` does.
 */

/** Where the registry's API lives. Overridable so a verifier can point somewhere else. */
export const REGISTRY_API = (process.env.CLAWHUB_REGISTRY || "https://clawhub.ai").replace(/\/+$/, "");

/**
 * Where the registry's human pages live, which is a different thing from its API.
 *
 * Kept separate because the CLI itself separates them (`CLAWHUB_SITE` versus
 * `CLAWHUB_REGISTRY`), and because the link-back requirement is about the page a reader
 * lands on rather than the endpoint this deployment calls. A mirror that linked to
 * `/api/v1/...` would satisfy the letter of "link back" and none of its purpose.
 */
export const REGISTRY_SITE = (process.env.CLAWHUB_SITE || "https://clawhub.ai").replace(/\/+$/, "");

/** The catalogue sorts the API documents. Anything else is refused by the API with a 400. */
export const CATALOGUE_SORTS = ["updated", "createdAt", "downloads", "stars", "name", "trending"] as const;
export type CatalogueSort = (typeof CATALOGUE_SORTS)[number];

/** The largest page the API serves. Asking for more is a wasted request. */
export const MAX_PAGE = 200;

/**
 * Where a published skill's bytes can be downloaded, exactly.
 *
 * `preview=1` asks for the bounded escaped text form rather than the raw download,
 * because this deployment reads a document to judge it and never stores a file: the
 * preview cap (200KB) is already an order of magnitude above what any skill should be,
 * and the auditor's own byte cap is lower still.
 *
 * `owner` is not optional in practice. Slugs are not globally unique in this registry:
 * asking for a bare slug that two publishers share answers 409 with the matches, which
 * is a refusal this deployment would otherwise record as "could not read it" and blame
 * on the network.
 */
export function fileUrl(ref: string, path = "SKILL.md"): string {
  const parsed = parseRef(ref);
  if (!parsed) return "";
  const q = new URLSearchParams({ path, owner: parsed.owner, preview: "1" });
  return `${REGISTRY_API}/api/v1/skills/${parsed.slug}/file?${q.toString()}`;
}

/** The public detail for one skill, which is where its moderation verdict is published. */
export function detailUrl(ref: string): string {
  const parsed = parseRef(ref);
  if (!parsed) return "";
  return `${REGISTRY_API}/api/v1/skills/${parsed.slug}?owner=${encodeURIComponent(parsed.owner)}`;
}

/**
 * One page of the catalogue.
 *
 * `createdAt` is the sort the API documents for crawling new skills and the one this
 * deployment sweeps under, because it is stable: `updated` moves a skill you have
 * already seen back to the front of the list, so a sweep under it can visit the same
 * row twice and never reach the end of a busy catalogue.
 */
export function catalogueUrl(input: { sort?: CatalogueSort; limit?: number; cursor?: string | null } = {}): string {
  const sort = input.sort && CATALOGUE_SORTS.includes(input.sort) ? input.sort : "createdAt";
  const limit = Math.min(Math.max(Math.floor(input.limit ?? MAX_PAGE), 1), MAX_PAGE);
  const q = new URLSearchParams({ limit: String(limit), sort });
  if (input.cursor) q.set("cursor", input.cursor);
  return `${REGISTRY_API}/api/v1/skills?${q.toString()}`;
}

/** The page on clawhub.ai a reader should be sent to. The link-back, in one place. */
export function canonicalUrl(ref: string): string {
  const parsed = parseRef(ref);
  if (!parsed) return "";
  return `${REGISTRY_SITE}/${encodeURIComponent(parsed.owner)}/skills/${encodeURIComponent(parsed.slug)}`;
}

/** The owner-qualified identity every row and every request is keyed by. */
export function refOf(owner: string, slug: string): string {
  return `${owner.trim().toLowerCase()}/${slug.trim().toLowerCase()}`;
}

/** Lowercase letters, digits, and single separators inside. The registry's own grammar. */
const PART_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Split an owner-qualified ref, or refuse it.
 *
 * Deliberately strict. A ref becomes a path segment in a URL and a unique key in a
 * table, so a value carrying a slash, a space, a control character or a traversal
 * sequence is refused here rather than escaped into a request later.
 */
export function parseRef(ref: string): { owner: string; slug: string } | null {
  const value = String(ref ?? "").trim().toLowerCase();
  if (!value || value.length > 200) return null;
  const parts = value.split("/");
  if (parts.length !== 2) return null;
  const [owner, slug] = parts;
  if (!PART_RE.test(owner) || !PART_RE.test(slug)) return null;
  if (owner.length > 64 || slug.length > 96) return null;
  return { owner, slug };
}

/** Milliseconds since the epoch, or null when the registry did not really send one. */
export function msToIso(value: unknown): string | null {
  const n = typeof value === "number" ? value : Number(value);
  // Zero is not 1970 here. The registry omits a timestamp by sending 0, which is why
  // every real value in these payloads is a recent epoch in the second half of the
  // 2020s, and why reading it as a date would put a skill in the wrong decade.
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function text(value: unknown, cap: number): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  return s ? s.slice(0, cap) : null;
}

/** Topics, trimmed and deduped case-insensitively, order preserved, bounded. */
export function topicsOf(value: unknown, cap = 24): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of value) {
    const s = typeof t === "string" ? t.trim() : "";
    if (!s || s.length > 64) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/** A string map, bounded, with the keys the registry documents and nothing invented. */
function stringMap(value: unknown, cap: number): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= cap) break;
    if (typeof v === "string" && k.length <= 64) out[k.slice(0, 64)] = v.slice(0, 128);
  }
  return out;
}

/**
 * The stats the registry publishes, kept as they arrive.
 *
 * ABSENT STAYS ABSENT, which is the same rule the fleet bridge follows for a machine
 * with no battery: a skill nobody has installed has `installs: 0` and a skill whose
 * stats the API did not include has nothing at all, and reporting the second as zero
 * would invent a fact about the registry. A missing key is simply not written.
 */
export function statsOf(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && k.length <= 32) out[k.slice(0, 32)] = n;
  }
  return out;
}

/** One row of the mirror, as the crawl would write it. */
export type RegistryRow = {
  ref: string;
  owner_handle: string;
  slug: string;
  display_name: string | null;
  summary: string | null;
  topics: string[];
  tags: Record<string, string>;
  stats: Record<string, number>;
  latest_version: string | null;
  version_created_at: string | null;
  registry_created_at: string | null;
  registry_updated_at: string | null;
  canonical_url: string;
};

/**
 * Project one catalogue item, or refuse it.
 *
 * A refusal here is a fact about the registry rather than an error in this deployment:
 * an item with no owner handle or no slug cannot be keyed, and one whose slug breaks the
 * naming grammar cannot be addressed in a URL. Both are skipped and counted instead of
 * being forced into a row that would later be fetched at a broken address.
 */
export function projectItem(raw: unknown): RegistryRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const owner = text(item.ownerHandle, 64);
  const slug = text(item.slug, 96);
  if (!owner || !slug) return null;
  const ref = refOf(owner, slug);
  if (!parseRef(ref)) return null;

  const version =
    item.latestVersion && typeof item.latestVersion === "object" && !Array.isArray(item.latestVersion)
      ? (item.latestVersion as Record<string, unknown>)
      : null;

  return {
    ref,
    owner_handle: owner.toLowerCase(),
    slug: slug.toLowerCase(),
    display_name: text(item.displayName, 200),
    // The publisher's own words about their own skill, stored as data and attributed.
    // 2,000 characters is a bound on how much of a stranger's prose this deployment
    // keeps at all, and it is well above anything the registry actually sends.
    summary: text(item.summary, 2000),
    topics: topicsOf(item.topics),
    tags: stringMap(item.tags, 40),
    stats: statsOf(item.stats),
    latest_version: version ? text(version.version, 40) : null,
    version_created_at: version ? msToIso(version.createdAt) : null,
    registry_created_at: msToIso(item.createdAt),
    registry_updated_at: msToIso(item.updatedAt),
    canonical_url: canonicalUrl(ref),
  };
}

/** One page of the catalogue, projected, with the cursor that continues it. */
export function projectCataloguePage(payload: unknown): { rows: RegistryRow[]; nextCursor: string | null; refused: number } {
  const body = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  const items = Array.isArray(body?.items) ? (body?.items as unknown[]) : [];
  const rows: RegistryRow[] = [];
  let refused = 0;
  for (const item of items) {
    const row = projectItem(item);
    if (row) rows.push(row);
    else refused += 1;
  }
  const cursor = typeof body?.nextCursor === "string" ? body.nextCursor : null;
  return { rows, nextCursor: cursor && cursor.length <= 4096 ? cursor : null, refused };
}

/** ClawHub's verdict vocabulary, as its moderation endpoint documents it. */
export const CLAWHUB_VERDICTS = ["clean", "suspicious", "blocked"] as const;
export type ClawHubVerdict = (typeof CLAWHUB_VERDICTS)[number];

/** This deployment's verdict vocabulary, from the audit engine. */
export const SWAMP_VERDICTS = ["clean", "notes", "caution", "risky", "unsafe"] as const;
export type SwampVerdict = (typeof SWAMP_VERDICTS)[number];

export type Agreement = "agree" | "swamp_stricter" | "swamp_looser" | "unreadable";

/**
 * Where two independent engines disagree about the same bytes.
 *
 * THE ONLY HONEST REASON FOR A SECOND OPINION. Republishing ClawHub's own verdict would
 * be a mirror with a badge; running a different engine with different rules over the same
 * bytes, on a record bound to their digest, is a second opinion, and its value is exactly
 * the rows where the two do not agree. The scales are different lengths, so they are
 * compared by what each verdict means operationally rather than by ordinal position:
 * ClawHub reserves `suspicious` for high impact concerns, which is why it ranks with
 * `risky` here and not with `caution`.
 *
 * A document this deployment could not read at all is its own answer, `unreadable`,
 * because "we could not judge this" and "we judged it and agreed" are opposite findings
 * and a single null would erase the difference.
 */
export function agreementOf(input: {
  clawhub: string | null | undefined;
  swamp: string | null | undefined;
  readable?: boolean;
}): Agreement | null {
  if (input.readable === false) return "unreadable";
  const swamp = SWAMP_VERDICTS.includes((input.swamp ?? "") as SwampVerdict) ? (input.swamp as SwampVerdict) : null;
  if (!swamp) return null;
  const clawhub = CLAWHUB_VERDICTS.includes((input.clawhub ?? "") as ClawHubVerdict) ? (input.clawhub as ClawHubVerdict) : null;
  // Nothing to disagree with. Our verdict still stands on its own record; this column is
  // about the pair, and a pair with one member is not a comparison.
  if (!clawhub) return null;

  const ours: Record<SwampVerdict, number> = { clean: 0, notes: 1, caution: 2, risky: 3, unsafe: 4 };
  const theirs: Record<ClawHubVerdict, number> = { clean: 0, suspicious: 3, blocked: 4 };
  const a = ours[swamp];
  const b = theirs[clawhub];
  if (a === b) return "agree";
  return a > b ? "swamp_stricter" : "swamp_looser";
}

/**
 * Read the moderation block out of a detail response.
 *
 * The API includes `moderation` when a skill is flagged or when its owner is looking, so
 * an ordinary clean skill arrives without the block at all. That absence is reported as
 * null rather than as "clean": a mirror that guessed clean would be reporting a verdict
 * nobody published, which is the same class of error as inventing a missing statistic.
 */
export function moderationOf(payload: unknown): { verdict: ClawHubVerdict | null; reasonCodes: string[]; blocked: boolean } {
  const body = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  const mod = body?.moderation && typeof body.moderation === "object" && !Array.isArray(body.moderation)
    ? (body.moderation as Record<string, unknown>)
    : null;
  if (!mod) return { verdict: null, reasonCodes: [], blocked: false };
  const blocked = mod.isMalwareBlocked === true;
  const raw = typeof mod.verdict === "string" ? mod.verdict.trim().toLowerCase() : "";
  const verdict = blocked ? "blocked" : CLAWHUB_VERDICTS.includes(raw as ClawHubVerdict) ? (raw as ClawHubVerdict) : null;
  const reasonCodes = Array.isArray(mod.reasonCodes)
    ? mod.reasonCodes.filter((c): c is string => typeof c === "string" && c.length <= 128).slice(0, 24)
    : [];
  return { verdict, reasonCodes, blocked };
}

/** The publisher's own account of the skill, from a detail response. */
export function projectDetail(payload: unknown): {
  display_name: string | null;
  summary: string | null;
  topics: string[];
  tags: Record<string, string>;
  latest_version: string | null;
} | null {
  const body = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  const skill = body?.skill && typeof body.skill === "object" && !Array.isArray(body.skill)
    ? (body.skill as Record<string, unknown>)
    : null;
  if (!skill) return null;
  const version =
    body?.latestVersion && typeof body.latestVersion === "object" && !Array.isArray(body.latestVersion)
      ? (body.latestVersion as Record<string, unknown>)
      : null;
  return {
    display_name: text(skill.displayName, 200),
    summary: text(skill.summary, 2000),
    topics: topicsOf(skill.topics),
    tags: stringMap(skill.tags, 40),
    latest_version: version ? text(version.version, 40) : null,
  };
}

/**
 * How long to wait after a 429.
 *
 * Reads both header families the API documents, and both readings of each, because
 * getting this wrong is how a deployment gets throttled by a host it needs: `Retry-After`
 * is a delay in seconds or an HTTP date, `RateLimit-Reset` is a delay in seconds, and
 * `X-RateLimit-Reset` is an absolute Unix time. A caller with a headers-like object can
 * test every branch without a network.
 */
export function retryAfterMs(headers: { get(name: string): string | null }, now: number = Date.now()): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter.trim());
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 15 * 60 * 1000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.min(Math.max(at - now, 0), 15 * 60 * 1000);
  }
  // Each header is checked for being PRESENT before being read, and that is not defensive
  // noise: `Number("")` is 0, so an absent RateLimit-Reset used to answer "wait zero
  // seconds", which is the opposite of what a caller needs to hear when it has just been
  // refused. An empty header is an absent header.
  const delayRaw = (headers.get("ratelimit-reset") ?? "").trim();
  const delay = delayRaw ? Number(delayRaw) : Number.NaN;
  if (Number.isFinite(delay) && delay > 0) return Math.min(delay * 1000, 15 * 60 * 1000);
  const epochRaw = (headers.get("x-ratelimit-reset") ?? "").trim();
  const epoch = epochRaw ? Number(epochRaw) : Number.NaN;
  if (Number.isFinite(epoch) && epoch > 0) {
    // Seconds, matching the API's own documentation of the legacy header.
    const ms = epoch > 1e12 ? epoch : epoch * 1000;
    return Math.min(Math.max(ms - now, 0), 15 * 60 * 1000);
  }
  return null;
}

/**
 * The sentence that has to travel with every entry.
 *
 * One constant rather than a paragraph written three times, because the API's reuse
 * terms require it and a requirement restated per surface is a requirement that goes
 * missing from the fourth one.
 */
export const REGISTRY_DISCLOSURE =
  "Mirrored from the public ClawHub registry and cached here. ClawHub does not endorse this deployment or anything built on it, and a listing is not a recommendation: the canonical page and both verdicts are linked so a reader can judge the skill themselves.";

/** How one entry names its origin, for a page or a reply. */
export function attributionOf(row: { owner_handle: string; slug: string; canonical_url?: string | null }): string {
  return `@${row.owner_handle}/${row.slug}`;
}
