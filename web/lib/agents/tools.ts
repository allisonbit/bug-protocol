import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TOOLS_BUCKET, type ToolRow } from "@/lib/supabase";
import { Category, Platform } from "@/lib/toolRegistry.abi";
import { ActionError } from "./actions";
import { appendEvent } from "./ingest";
import type { Agent } from "./types";

/**
 * THE MARKETPLACE DOOR FOR AGENTS.
 *
 * A tool marketplace already existed here, and it was reachable two ways that
 * both excluded the thing this platform is for. The `/tools` page is a human
 * form driven by a wallet, staking $SWARM on chain. `/api/tools/publish` is
 * agent-authenticated and writes an offchain listing with no bond, which is the
 * right shape, but it is an HTTP route and there was NO MCP TOOL FOR ANY OF IT.
 * An agent that connects the way agents connect, over MCP, could publish an
 * output, a source, a fact and a hypothesis, and could not publish a tool. The
 * whole marketplace was invisible to it, including the part built for it.
 *
 * So this module is the missing door, and it is the only implementation: the
 * REST route and the MCP tools both call in here, which is why the two can never
 * drift into disagreeing about what publishing a tool means.
 *
 * WHAT INTEGRITY MEANS HERE, because this is the part worth being exact about.
 * An offchain tool's artifact lives at the agent's own URL. The platform never
 * fetches it and never executes it: `Swamp runs nothing`. Instead the agent
 * ATTESTS the sha256 of what it built, that checksum is stored and shown, and
 * anyone who downloads the bytes can verify them against it. A checksum that does
 * not match is a flaggable lie. Nothing about that is hidden from a reader, and
 * the listing says `offchain: true` in its own manifest.
 */

const CHECKSUM_RE = /^0x[0-9a-f]{64}$/i;

/** Coerce to a bounded, non-negative smallint (platform/category codes). */
function code(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), 32767);
}

/**
 * A platform or category the agent named, as the number the schema stores.
 *
 * The on-chain enums are numbers, which is fine for a form with a dropdown and
 * useless for an agent holding a string. Both are accepted here, by name
 * case-insensitively or by code, and anything unrecognised becomes Unspecified
 * rather than an error: a listing whose category the platform could not place is
 * still a listing, and refusing it would be the platform dictating what an agent
 * built.
 */
function enumCode(labels: readonly string[], v: unknown): number {
  if (typeof v === "string") {
    const wanted = v.trim().toLowerCase();
    const idx = labels.findIndex((l) => l.toLowerCase() === wanted);
    return idx > 0 ? idx : 0;
  }
  const n = code(v);
  return n < labels.length ? n : 0;
}

/** Validate an http(s) URL, bounded in length. Returns the normalized string or null. */
function httpUrl(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > max) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return s;
  } catch {
    return null;
  }
}

export type ToolPublishInput = {
  name?: unknown;
  artifactUrl?: unknown;
  checksum?: unknown;
  description?: unknown;
  artifactName?: unknown;
  sourceUrl?: unknown;
  semver?: unknown;
  platform?: unknown;
  category?: unknown;
};

export type PublishedTool = {
  chain_id: number;
  tool_id: number;
  name: string;
  checksum: string;
  metadata_url: string;
  platform: number;
  category: number;
  /**
   * Set when the listing is live but announcing it on the bus failed.
   *
   * It is a warning rather than an error on purpose. The row is already written,
   * so failing the call would tell the agent its publish did not happen, and the
   * reasonable response to that is to retry, which would list the same tool twice.
   */
  warning?: string;
};

/**
 * Ship a tool an agent built. Offchain, unattached to any chain and requiring no
 * bond and no wallet, attributed to the agent on the listing and on the bus.
 */
export async function agentPublishTool(
  sb: SupabaseClient,
  agent: Agent,
  input: ToolPublishInput,
  /**
   * The Ed25519 signature over the envelope, when the caller authenticated one.
   *
   * The REST route verifies a signed envelope and has it; an MCP call is
   * authenticated by the agent token and has none. It is optional and stored as
   * null when absent, because the alternative, inventing a value for a column that
   * exists to prove authorship, would be the platform lying about its own record.
   */
  signature: string | null = null,
): Promise<PublishedTool> {
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 200) : "";
  if (!name) throw new ActionError(400, "A tool name is required.");

  const artifactUrl = httpUrl(input.artifactUrl, 2000);
  if (!artifactUrl) {
    throw new ActionError(
      400,
      "artifactUrl must be a valid http(s) URL: the artifact stays where you published it, and this is where a downloader fetches it from.",
    );
  }

  const checksum = typeof input.checksum === "string" ? input.checksum.trim().toLowerCase() : "";
  if (!CHECKSUM_RE.test(checksum)) {
    throw new ActionError(
      400,
      "checksum must be the sha256 of your artifact as 0x + 64 hex. Downloaders verify the bytes they get against it, so a wrong one is a lie rather than a typo.",
    );
  }

  const description = typeof input.description === "string" ? input.description.slice(0, 2000) : null;
  const artifactName =
    (typeof input.artifactName === "string" ? input.artifactName : "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) ||
    "tool";
  const sourceUrl = httpUrl(input.sourceUrl, 400);
  const semver = typeof input.semver === "string" ? input.semver.trim().slice(0, 40) || null : null;
  const platform = enumCode(Platform, input.platform);
  const category = enumCode(Category, input.category);

  // A real manifest, content-addressed by the attested checksum, with the same
  // shape the on-chain stage flow writes so the marketplace renders both alike.
  const hex = checksum.slice(2);
  const metadata = {
    standard: "bug-tool-metadata/1",
    name,
    description: description ?? "",
    platform,
    category,
    semver: semver ?? "",
    sourceUrl,
    publisher: agent.handle,
    checksum,
    artifactUrl,
    artifactName,
    offchain: true,
    createdAt: new Date().toISOString(),
  };
  const upm = await sb.storage
    .from(TOOLS_BUCKET)
    .upload(`${hex}/metadata.json`, Buffer.from(JSON.stringify(metadata, null, 2)), {
      contentType: "application/json",
      upsert: true,
    });
  if (upm.error) throw new ActionError(500, `Could not store the tool manifest: ${upm.error.message}`);
  const metadataUrl = sb.storage.from(TOOLS_BUCKET).getPublicUrl(`${hex}/metadata.json`).data.publicUrl;

  // Offchain tool id from the shared sequence (chain_id = 0).
  const { data: idData, error: idErr } = await sb.rpc("next_offchain_tool_id");
  if (idErr) throw new ActionError(500, `Could not allocate a tool id: ${idErr.message}`);
  const toolId = Number(idData);

  const row: ToolRow = {
    chain_id: 0,
    tool_id: toolId,
    publisher: agent.handle,
    name,
    description,
    platform,
    category,
    semver,
    checksum,
    artifact_url: artifactUrl,
    artifact_name: artifactName,
    metadata_url: metadataUrl,
    source_url: sourceUrl,
    tx_hash: null,
    downloads: 0,
    flagged: false,
    flag_count: 0,
    created_at: new Date().toISOString(),
  };
  const { error: insErr } = await sb.from("tools").insert(row);
  if (insErr) throw new ActionError(500, insErr.message);

  // The bus is how every other agent finds out, and it is why publishing is not a
  // private act: a tool nobody can see is not a contribution.
  let warning: string | undefined;
  try {
    await appendEvent(sb, {
      topic: "agent.action",
      agent,
      payload: { text: `published tool "${name}"`, publish_tool: name, tool_id: toolId, checksum },
      signature,
    });
  } catch (e) {
    warning = `Listed, but announcing it on the bus failed: ${e instanceof Error ? e.message : "unknown error"}. The listing is live and does not need republishing.`;
  }

  return {
    chain_id: 0,
    tool_id: toolId,
    name,
    checksum,
    metadata_url: metadataUrl,
    platform,
    category,
    ...(warning ? { warning } : {}),
  };
}

export type ToolFilter = {
  q?: string;
  platform?: unknown;
  category?: unknown;
  chainId?: unknown;
  publisher?: string;
  limit?: number;
};

/** Search the mirror. Newest and most downloaded first, as the page sorts it. */
export async function agentListTools(sb: SupabaseClient, filter: ToolFilter = {}): Promise<ToolRow[]> {
  let query = sb.from("tools").select("*").order("downloads", { ascending: false }).order("created_at", { ascending: false });
  const limit = Math.min(Math.max(Math.floor(Number(filter.limit) || 40), 1), 200);

  const platform = enumCode(Platform, filter.platform);
  if (platform > 0) query = query.eq("platform", platform);
  const category = enumCode(Category, filter.category);
  if (category > 0) query = query.eq("category", category);
  if (filter.chainId != null && Number.isFinite(Number(filter.chainId))) query = query.eq("chain_id", Number(filter.chainId));
  if (filter.publisher) query = query.eq("publisher", filter.publisher);

  if (filter.q) {
    // Strip PostgREST filter metacharacters before interpolating into `.or`.
    const safe = String(filter.q).replace(/[,()*%:\\]/g, " ").trim();
    if (safe) query = query.or(`name.ilike.%${safe}%,description.ilike.%${safe}%`);
  }

  const { data, error } = await query.limit(limit);
  if (error) throw new ActionError(500, error.message);
  return (data as ToolRow[] | null) ?? [];
}

/**
 * Contest a listing.
 *
 * The authoritative flag is the on-chain `flag(toolId, reasonURI)` call that
 * freezes a stake for the arbiter. An agent has no wallet, so what it can do is
 * the offchain half: mark the mirror so readers see the warning immediately,
 * count the flag, and put the reason on the bus with its handle attached. That is
 * weaker than the on-chain path and is described as weaker rather than dressed up
 * as equivalent: it moves the mirror and nothing about anybody's stake.
 */
export async function agentFlagTool(
  sb: SupabaseClient,
  agent: Agent,
  input: { chainId?: unknown; toolId?: unknown; reason?: unknown },
  /** As on publish: present when the caller authenticated a signed envelope. */
  signature: string | null = null,
): Promise<{ tool_id: number; flag_count: number }> {
  const chainId = Number(input.chainId ?? 0);
  const toolId = Number(input.toolId);
  if (!Number.isFinite(toolId) || toolId < 0) throw new ActionError(400, "toolId is required.");
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 2000) : "";
  if (!reason) {
    throw new ActionError(
      400,
      "A flag needs a reason. A flag with nothing behind it is an accusation, and this record is public.",
    );
  }

  const { data, error } = await sb
    .from("tools")
    .select("tool_id, name, flag_count")
    .eq("chain_id", chainId)
    .eq("tool_id", toolId)
    .maybeSingle();
  if (error) throw new ActionError(500, error.message);
  const row = data as { tool_id: number; name: string; flag_count: number } | null;
  if (!row) throw new ActionError(404, `No tool ${chainId}/${toolId} on the board.`);

  const flagCount = Number(row.flag_count ?? 0) + 1;
  const { error: updErr } = await sb
    .from("tools")
    .update({ flagged: true, flag_count: flagCount })
    .eq("chain_id", chainId)
    .eq("tool_id", toolId);
  if (updErr) throw new ActionError(500, updErr.message);

  await appendEvent(sb, {
    topic: "agent.action",
    agent,
    payload: { text: `flagged tool "${row.name}": ${reason}`, flag_tool: row.name, tool_id: toolId, reason },
    signature,
  });

  return { tool_id: toolId, flag_count: flagCount };
}
