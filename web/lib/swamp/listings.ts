import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SITE_URL } from "@/lib/site";
import { SKILL_MD, SKILL_NAME } from "@/lib/skill";
import { skillDigest } from "@/lib/skill-index";
import { publishDocumentToClawHub } from "@/lib/swamp/skills";
import {
  REGISTRY_SERVER_NAME,
  REGISTRY_VERSION,
  apexDomain,
  publishListing,
  readListing,
  registryConfigured,
  setListingStatus,
} from "@/lib/registry/mcp-registry";

/**
 * ARE WE STILL LISTED, AND IF NOT, PUT IT BACK.
 *
 * Swamp is discoverable in three places, and all three can vanish without this
 * deployment doing anything wrong:
 *
 *   1. The official MCP Registry, which says of itself that it is in preview and
 *      that **data resets may occur**.
 *   2. ClawHub, whose listings can be delisted by moderation or by a scan.
 *   3. This domain's own Agent Skills index, which nothing external can delete but
 *      which can rot from the inside if a digest stops matching the bytes it
 *      describes.
 *
 * "Publish once and hope" is how a storefront goes quietly empty. This module is
 * the schedule that looks: it reads each listing from the outside, records what it
 * found, and repairs what it can on its own.
 *
 * WHAT IT READS RATHER THAN ASSUMES.
 *
 * The MCP Registry is read through its public API, so the check is against the
 * registry's own answer and not against our record of having published.
 *
 * ClawHub needed a real signal and the obvious one is a trap. The canonical page
 * `clawhub.ai/<owner>/skills/<slug>` returns **200 for everything** — a slug that
 * has never existed, and another owner's skill, both answer 200 — because it is a
 * client-rendered page that never says "not found" to a fetcher. A check built on
 * that URL would report every listing healthy forever. Measured, not guessed. The
 * public search API is the signal that actually distinguishes present from absent:
 * an invented slug returns no results. It is fuzzy, so results are matched on the
 * **exact** `owner/slug` reference rather than trusting the first hit — searching
 * for `swamp` returns three different skills including two that are not ours.
 *
 * The Agent Skills index is read over HTTPS from this same domain, which is the
 * only way to check what a *client* would actually receive, and every digest in it
 * is verified against the artifact bytes the index points at.
 *
 * WHY THERE IS NO BUS EVENT. `appendEvent` requires an author and records
 * provenance, because the bus is a record of what inhabitants did. A listing check
 * is the platform looking at its own storefront, and there is no resident whose
 * act this is: attributing it to one would be exactly the kind of false provenance
 * this place refuses. So a regression is recorded durably and shown live on
 * /discover rather than dressed up as an agent's event.
 */

const CLAWHUB_BASE = (process.env.CLAWHUB_REGISTRY || "https://clawhub.ai").replace(/\/+$/, "");

/** The version the platform's own ClawHub listing is restored under, first time. */
const PLATFORM_SKILL_BASE_VERSION = "1.0.0";

export type ListingKind = "mcp-registry" | "clawhub" | "agent-skills-index";
export type ListingState = "present" | "missing" | "error";

export type ListingResult = {
  /** Stable id, and the primary key of listing_health. */
  listing: string;
  kind: ListingKind;
  title: string;
  url: string;
  state: ListingState;
  detail: string;
  /** What the last check recorded, so a transition is distinguishable. */
  previous: ListingState | null;
  repaired: boolean;
  repairDetail: string | null;
  /** The version in the registry or marketplace after this check, when known. */
  version: string | null;
  /** When this state was observed, so a page can say how stale it is. */
  checkedIso: string | null;
};

export type ListingsReport = {
  checkedAt: string;
  results: ListingResult[];
  present: number;
  missing: number;
  errored: number;
  repaired: number;
  /** True when nothing could be read because nothing is configured. */
  degraded: string | null;
};

/**
 * What a check returns, plus how it should be repaired.
 *
 * The hint is separate from `detail` on purpose. `detail` is prose for a reader,
 * and prose changes; an earlier draft of the registry repair decided whether to
 * flip a status or republish by **regex-matching the sentence in `detail`**, which
 * means an edit to a description would silently change what the repair did. The
 * two jobs are different and now have different fields.
 */
type Finding = Omit<ListingResult, "previous" | "repaired" | "repairDetail" | "checkedIso"> & {
  /**
   * `status-inactive`: the entry exists but browsing clients cannot see it, so
   * the repair is to put the status back. `absent`: nothing is there, so the
   * repair is to publish. `null`: nothing to repair.
   */
  hint?: "status-inactive" | "absent" | null;
};

/** `1.2.3` -> `1.2.4`. A restoration is a new publication, not an edit. */
function bumpPatch(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return `${PLATFORM_SKILL_BASE_VERSION.replace(/\.\d+$/, "")}.1`;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

// ---------------------------------------------------------------------------
// ClawHub
// ---------------------------------------------------------------------------

type ClawHubHit = { reference: string; canonicalUrl: string | null; owner: string | null; displayName: string | null };

/** The public lookup. No credential: a listing's existence is public information. */
async function clawhubSearch(query: string): Promise<ClawHubHit[]> {
  const res = await fetch(`${CLAWHUB_BASE}/api/v1/search?q=${encodeURIComponent(query)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`ClawHub search returned ${res.status}`);
  const body = (await res.json()) as {
    results?: {
      displayName?: string;
      canonicalUrl?: string;
      install?: { reference?: string };
      owner?: { handle?: string };
    }[];
  };
  return (body.results ?? []).map((r) => ({
    reference: String(r.install?.reference ?? ""),
    canonicalUrl: r.canonicalUrl ?? null,
    owner: r.owner?.handle ?? null,
    displayName: r.displayName ?? null,
  }));
}

/** Which account the operator's token belongs to. Authenticated; cached per call. */
async function clawhubOwner(token: string): Promise<string> {
  const res = await fetch(`${CLAWHUB_BASE}/api/v1/whoami`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(20000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`ClawHub whoami returned ${res.status}`);
  const body = (await res.json()) as { user?: { handle?: string | null } };
  const handle = body.user?.handle;
  if (!handle) throw new Error("ClawHub did not report a handle for this token.");
  return handle;
}

/**
 * Is a skill present in the marketplace?
 *
 * Exact reference match, deliberately. The search is fuzzy enough that trusting
 * the first result would have this platform reporting its own listing healthy
 * while reading somebody else's skill.
 */
function findExact(hits: ClawHubHit[], owner: string, slug: string): ClawHubHit | null {
  const want = `${owner}/${slug}`.toLowerCase();
  return hits.find((h) => h.reference.toLowerCase() === want) ?? null;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

async function checkMcpRegistry(): Promise<Finding> {
  const base = {
    listing: "mcp-registry",
    kind: "mcp-registry" as const,
    title: "Official MCP Registry",
    url: `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(REGISTRY_SERVER_NAME)}`,
  };

  const read = await readListing();
  if (!read.ok) {
    return { ...base, state: "error", detail: read.error, version: null, hint: null };
  }
  if (!read.listing) {
    return {
      ...base,
      state: "missing",
      detail: `${REGISTRY_SERVER_NAME} is not in the registry's results at all.`,
      version: null,
      hint: "absent",
    };
  }
  const l = read.listing;
  if (l.status !== "active") {
    // Deliberately `missing` rather than `present`: an entry in `deleted` or
    // `deprecated` state does not appear to a browsing client, so calling it
    // present would be reporting a listing that nobody can find as healthy.
    return {
      ...base,
      state: "missing",
      detail: `${REGISTRY_SERVER_NAME} v${l.version} is listed as "${l.status}", which browsing clients do not see.`,
      version: null,
      hint: "status-inactive",
    };
  }
  return { ...base, state: "present", detail: `active, version ${l.version}`, version: l.version, hint: null };
}

async function checkClawHub(
  owner: string | null,
): Promise<Omit<ListingResult, "previous" | "repaired" | "repairDetail" | "checkedIso">> {
  const base = {
    listing: "clawhub",
    kind: "clawhub" as const,
    title: "ClawHub",
    url: `${CLAWHUB_BASE}/skills/${SKILL_NAME}`,
  };
  if (!owner) {
    return { ...base, state: "error", detail: "no credential, so the owner this listing belongs to cannot be known", version: null };
  }
  const hits = await clawhubSearch(SKILL_NAME);
  const hit = findExact(hits, owner, SKILL_NAME);
  if (!hit) {
    return {
      ...base,
      url: `${CLAWHUB_BASE}/api/v1/search?q=${SKILL_NAME}`,
      state: "missing",
      detail: `no result for ${owner}/${SKILL_NAME} in the marketplace search`,
      version: null,
    };
  }
  return { ...base, state: "present", detail: `${owner}/${SKILL_NAME} is listed`, version: null };
}

/**
 * This domain's own index, read the way a client reads it.
 *
 * Two failures are possible and they are different. The index can be unreachable
 * or unparseable, which is a deployment problem; or it can describe an artifact
 * whose bytes no longer hash to the digest it publishes, which makes the skill
 * unusable in exactly the clients that verify it — silently, because a client
 * refuses the content rather than complaining about it.
 */
async function checkAgentSkillsIndex(): Promise<Omit<ListingResult, "previous" | "repaired" | "repairDetail" | "checkedIso">> {
  const base = {
    listing: "agent-skills-index",
    kind: "agent-skills-index" as const,
    title: "Agent Skills index",
    url: `${SITE_URL}/.well-known/agent-skills/index.json`,
  };

  const res = await fetch(base.url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000), cache: "no-store" });
  if (!res.ok) {
    return { ...base, state: "missing", detail: `the index returned ${res.status}`, version: null };
  }
  const index = (await res.json()) as {
    skills?: { name?: string; url?: string; digest?: string }[];
  };
  const entries = index.skills ?? [];
  const entry = entries.find((s) => s.name === SKILL_NAME);
  if (!entry) {
    return { ...base, state: "missing", detail: `the index does not name the "${SKILL_NAME}" skill`, version: null };
  }
  if (entry.digest !== skillDigest()) {
    return {
      ...base,
      state: "missing",
      detail: `the index publishes ${entry.digest?.slice(0, 20)}… but this build's skill hashes to ${skillDigest().slice(0, 20)}…`,
      version: null,
    };
  }

  // Every artifact the index names, including the swarm's own skills: the bytes
  // must hash to the digest, because that is the one thing a conforming client
  // checks and the one thing a drift would break silently.
  const checked: string[] = [];
  for (const s of entries) {
    if (!s.url || !s.digest) continue;
    const artifact = await fetch(`${SITE_URL}${s.url}`, { signal: AbortSignal.timeout(20000), cache: "no-store" });
    if (!artifact.ok) {
      return { ...base, state: "missing", detail: `${s.name} is listed but its artifact returns ${artifact.status}`, version: null };
    }
    const actual = `sha256:${sha256(await artifact.text())}`;
    if (actual !== s.digest) {
      return {
        ...base,
        state: "missing",
        detail: `${s.name}: the digest says ${s.digest.slice(7, 27)}… and the bytes hash to ${actual.slice(7, 27)}…`,
        version: null,
      };
    }
    checked.push(String(s.name));
  }

  return {
    ...base,
    state: "present",
    detail: `${entries.length} skill(s) listed, ${checked.length} artifact digest(s) verified: ${checked.join(", ")}`,
    version: null,
  };
}

// ---------------------------------------------------------------------------
// The repairs
// ---------------------------------------------------------------------------

/**
 * Put the MCP Registry listing back.
 *
 * Two different accidents need two different repairs, and knowing which is which
 * is the whole job. A **status** flip (`deleted`, `deprecated`) is repaired by
 * flipping it back: the registry keeps versions, so republishing a version that
 * already exists is a no-op and the entry would stay invisible. A listing that is
 * **absent entirely** is repaired by publishing, which is the only thing that
 * creates it.
 */
async function repairMcpRegistry(hint: Finding["hint"]): Promise<string> {
  if (!registryConfigured()) {
    throw new Error("MCP_REGISTRY_PRIVATE_KEY is not set on this deployment, so it cannot sign as the namespace.");
  }
  if (hint === "status-inactive") {
    await setListingStatus("active", `Restored automatically: the listing had been marked inactive. ${apexDomain()} still holds the namespace key.`);
    return "status was set back to active";
  }
  const published = await publishListing();
  return `republished ${published.version} (status ${published.status})`;
}

/** Republish the platform's own skill, under a new version. */
async function repairClawHub(token: string, owner: string, lastVersion: string | null): Promise<string> {
  const version = bumpPatch(lastVersion || PLATFORM_SKILL_BASE_VERSION);
  const result = await publishDocumentToClawHub(token, {
    slug: SKILL_NAME,
    displayName: "Swamp",
    version,
    document: SKILL_MD,
    changelog: `Republished automatically at v${version}: the listing for this skill was not found in the marketplace, and this platform keeps its own storefront from going quietly empty. Content is unchanged.`,
  });
  return `republished as v${version} under ${result.owner}/${result.slug} (ClawHub status ${result.publicationStatus ?? "unknown"})`;
}

// ---------------------------------------------------------------------------
// The schedule's entry point
// ---------------------------------------------------------------------------

/**
 * Check every listing, repair what can be repaired, and record it all.
 *
 * Repair happens only on `missing`, never on `error`. An error means the check
 * could not see the listing — a timeout, a 500, a credential that is not set — and
 * republishing on the strength of an outage would turn one platform's bad minute
 * into a duplicate version here.
 */
export async function checkListings(sb: SupabaseClient, options: { repair?: boolean } = {}): Promise<ListingsReport> {
  const repairEnabled = options.repair !== false;
  const token = process.env.CLAWHUB_TOKEN ?? "";

  // Read previous states in one go, so a transition can be told from a standing
  // condition and the report can say which.
  const { data: previousRows } = await sb.from("listing_health").select("listing, state, published_version, repair_count");
  const previous = new Map<string, { state: ListingState; version: string | null; repairs: number }>();
  for (const r of (previousRows ?? []) as {
    listing: string;
    state: ListingState;
    published_version: string | null;
    repair_count: number | null;
  }[]) {
    previous.set(r.listing, { state: r.state, version: r.published_version, repairs: r.repair_count ?? 0 });
  }

  const results: ListingResult[] = [];

  // Owner first, because two of the checks depend on knowing whose account the
  // marketplace listing lives under.
  let owner: string | null = null;
  let ownerError: string | null = null;
  if (token) {
    try {
      owner = await clawhubOwner(token);
    } catch (e) {
      ownerError = e instanceof Error ? e.message : String(e);
    }
  } else {
    ownerError = "CLAWHUB_TOKEN is not set on this deployment";
  }

  // Annotated so the repair hint survives inference: without it the array widens
  // to the type of its first element and `hint` is lost at the one place it is
  // read.
  const checks: Finding[] = [
    await checkMcpRegistry().catch((e) => ({
      listing: "mcp-registry",
      kind: "mcp-registry" as ListingKind,
      title: "Official MCP Registry",
      url: "https://registry.modelcontextprotocol.io",
      state: "error" as ListingState,
      detail: e instanceof Error ? e.message : String(e),
      version: null as string | null,
    })),
    await checkClawHub(ownerError ? null : owner).catch((e) => ({
      listing: "clawhub",
      kind: "clawhub" as ListingKind,
      title: "ClawHub",
      url: `${CLAWHUB_BASE}/skills/${SKILL_NAME}`,
      state: "error" as ListingState,
      detail: ownerError ?? (e instanceof Error ? e.message : String(e)),
      version: null as string | null,
    })),
    await checkAgentSkillsIndex().catch((e) => ({
      listing: "agent-skills-index",
      kind: "agent-skills-index" as ListingKind,
      title: "Agent Skills index",
      url: `${SITE_URL}/.well-known/agent-skills/index.json`,
      state: "error" as ListingState,
      detail: e instanceof Error ? e.message : String(e),
      version: null as string | null,
    })),
  ];

  for (const found of checks) {
    const prev = previous.get(found.listing) ?? null;
    let repaired = false;
    let repairDetail: string | null = null;
    let state = found.state;
    let detail = found.detail;
    let version = found.version;

    if (state === "missing" && repairEnabled) {
      try {
        if (found.listing === "mcp-registry") {
          repairDetail = await repairMcpRegistry(found.hint);
          repaired = true;
          // Re-read rather than assume: the repair is only real if the registry
          // now says so, which is the same discipline the check itself follows.
          const after = await readListing();
          if (after.ok && after.listing?.status === "active") {
            state = "present";
            version = after.listing.version;
            detail = `repaired: ${repairDetail}`;
          } else {
            repairDetail = `${repairDetail}; but the registry still reads as ${after.ok ? (after.listing ? after.listing.status : "absent") : "unreadable"}`;
          }
        } else if (found.listing === "clawhub") {
          if (!token || !owner) throw new Error(ownerError ?? "no ClawHub credential on this deployment");
          repairDetail = await repairClawHub(token, owner, prev?.version ?? null);
          repaired = true;
          const hits = await clawhubSearch(SKILL_NAME);
          if (findExact(hits, owner, SKILL_NAME)) {
            state = "present";
            detail = `repaired: ${repairDetail}`;
          } else {
            repairDetail = `${repairDetail}; but the marketplace still does not show it (ClawHub scans an upload before it appears, so this can be correct for a few minutes)`;
          }
        } else {
          // Nothing can repair this one from inside the deployment: the index is
          // generated from the code that is running, so a mismatch between them is
          // a defect that a deploy fixes, not a storefront that went dark. Saying
          // "repaired" here would be a lie about a check nobody performed.
          repairDetail = "not repairable from here: the index is generated from this deployment's own code, so a mismatch is a defect a deploy fixes";
        }
      } catch (e) {
        repairDetail = `repair failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    const row: ListingResult = {
      listing: found.listing,
      kind: found.kind,
      title: found.title,
      url: found.url,
      state,
      detail,
      previous: prev?.state ?? null,
      repaired,
      repairDetail,
      version,
      checkedIso: new Date().toISOString(),
    };
    results.push(row);

    // Durable: the current state replaces the row, and the run is appended.
    await sb.from("listing_health").upsert(
      {
        listing: row.listing,
        kind: row.kind,
        state: row.state,
        detail: row.detail.slice(0, 800),
        url: row.url,
        checked_at: new Date().toISOString(),
        ...(row.state === "present" ? { present_at: new Date().toISOString() } : {}),
        ...(row.repaired
          ? {
              repaired_at: new Date().toISOString(),
              repair_detail: (row.repairDetail ?? "").slice(0, 800),
              // Read-then-write rather than an increment expression, because the
              // upsert is the only write path here and a value that silently
              // resets to 1 would hide how often this has actually happened.
              repair_count: (previous.get(row.listing)?.repairs ?? 0) + 1,
            }
          : {}),
        ...(row.version ? { published_version: row.version } : {}),
      },
      { onConflict: "listing" },
    );
    await sb.from("listing_check_log").insert({
      listing: row.listing,
      state: row.state,
      detail: row.detail.slice(0, 800),
      repaired: row.repaired,
      repair_detail: row.repairDetail ? row.repairDetail.slice(0, 800) : null,
    });
  }

  return {
    checkedAt: new Date().toISOString(),
    results,
    present: results.filter((r) => r.state === "present").length,
    missing: results.filter((r) => r.state === "missing").length,
    errored: results.filter((r) => r.state === "error").length,
    repaired: results.filter((r) => r.repaired).length,
    degraded: !registryConfigured()
      ? "The registry signing key is not set on this deployment, so a vanished MCP Registry listing can be detected but not restored."
      : null,
  };
}

/** The current state of every listing, for a page. Order is stable, not by luck. */
export async function readListingHealth(sb: SupabaseClient): Promise<ListingResult[]> {
  const { data } = await sb
    .from("listing_health")
    .select("listing, kind, state, detail, url, checked_at, repaired_at, repair_detail, published_version");
  const rows = (data ?? []) as {
    listing: string;
    kind: ListingKind;
    state: ListingState;
    detail: string | null;
    url: string | null;
    checked_at: string | null;
    repaired_at: string | null;
    repair_detail: string | null;
    published_version: string | null;
  }[];

  const ORDER: ListingKind[] = ["mcp-registry", "clawhub", "agent-skills-index"];
  const TITLES: Record<string, string> = {
    "mcp-registry": "Official MCP Registry",
    clawhub: "ClawHub",
    "agent-skills-index": "Agent Skills index",
  };
  return rows
    .map((r) => ({
      listing: r.listing,
      kind: r.kind,
      title: TITLES[r.listing] ?? r.listing,
      url: r.url ?? "",
      state: r.state,
      detail: r.detail ?? "",
      previous: null,
      repaired: !!r.repaired_at,
      repairDetail: r.repair_detail,
      version: r.published_version,
      checkedIso: r.checked_at,
    }))
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

/** The manifest version this deployment would publish, for a page to state. */
export const LISTED_VERSION = REGISTRY_VERSION;
