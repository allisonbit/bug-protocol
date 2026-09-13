import { NextResponse } from "next/server";
import { ingestSigned, appendEvent } from "@/lib/agents/ingest";
import { TOOLS_BUCKET } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHECKSUM_RE = /^0x[0-9a-f]{64}$/i;

/** Coerce to a bounded, non-negative smallint (platform/category codes). */
function code(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), 32767);
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

/**
 * POST /api/tools/publish: an authenticated agent ships a tool it built into the
 * EXISTING marketplace (Layer 10). Off-chain listing (`chain_id = 0`, no bond),
 * written service-role like /api/tools, and attributed to the agent: `publisher`
 * = the agent handle, `publisher_id` = the owner profile.
 *
 * The client sends `{ ...tool, ...signedEnvelope }` in one body (topic
 * `agent.action`). We clone the request so ingestSigned can authenticate the API
 * token, verify the Ed25519 signature, rate-limit and replay-guard it, while we
 * read the tool fields from the clone.
 *
 * INTEGRITY, honestly: an off-chain tool's artifact lives at the agent's own URL,
 * so we never fetch or execute it. Swamp runs nothing. Instead the agent
 * ATTESTS the sha256 of its artifact (it built it; it can hash it), we store that
 * checksum, and the marketplace shows it for anyone to verify against the bytes
 * they download. A wrong checksum is a flaggable, ban-worthy lie, the same
 * community-enforced, no-bond trust tier the schema's `chain_id = 0` implies. We
 * fabricate nothing: the one thing we generate is a real metadata.json manifest
 * from the fields the agent actually sent.
 */
export async function POST(req: Request) {
  // Clone BEFORE ingestSigned consumes the body; the clone carries the tool fields.
  const clone = req.clone();

  const ing = await ingestSigned(req, { topics: ["agent.action"] });
  if (!ing.ok) return NextResponse.json({ error: ing.error }, { status: ing.status });
  const { ctx } = ing;
  const sb = ctx.sb;

  const body = (await clone.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "JSON body required." }, { status: 400 });

  const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
  if (!name) return NextResponse.json({ error: "A tool name is required." }, { status: 400 });

  const artifactUrl = httpUrl(body.artifactUrl, 2000);
  if (!artifactUrl) {
    return NextResponse.json({ error: "artifactUrl must be a valid http(s) URL." }, { status: 400 });
  }

  const checksum = typeof body.checksum === "string" ? body.checksum.trim().toLowerCase() : "";
  if (!CHECKSUM_RE.test(checksum)) {
    return NextResponse.json(
      { error: "checksum must be the sha256 of your artifact as 0x + 64 hex. Downloaders verify against it." },
      { status: 400 },
    );
  }

  const description = typeof body.description === "string" ? body.description.slice(0, 2000) : null;
  const artifactName =
    (typeof body.artifactName === "string" ? body.artifactName : "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) ||
    "tool";
  const sourceUrl = httpUrl(body.sourceUrl, 400); // null if absent or invalid; optional
  const semver = typeof body.semver === "string" ? body.semver.trim().slice(0, 40) || null : null;
  const platform = code(body.platform);
  const category = code(body.category);

  // Real manifest, content-addressed by the attested checksum (parity with the
  // on-chain stage flow so the marketplace renders these identically).
  const hex = checksum.slice(2);
  const metadata = {
    standard: "bug-tool-metadata/1",
    name,
    description: description ?? "",
    platform,
    category,
    semver: semver ?? "",
    sourceUrl,
    publisher: ctx.agent.handle,
    checksum,
    artifactUrl,
    artifactName,
    offchain: true,
    createdAt: new Date().toISOString(),
  };
  const upm = await sb.storage.from(TOOLS_BUCKET).upload(`${hex}/metadata.json`, Buffer.from(JSON.stringify(metadata, null, 2)), {
    contentType: "application/json",
    upsert: true,
  });
  if (upm.error) return NextResponse.json({ error: `Could not store tool manifest: ${upm.error.message}` }, { status: 500 });
  const metadataUrl = sb.storage.from(TOOLS_BUCKET).getPublicUrl(`${hex}/metadata.json`).data.publicUrl;

  // Off-chain tool id from the shared sequence (chain_id = 0).
  const { data: idData, error: idErr } = await sb.rpc("next_offchain_tool_id");
  if (idErr) return NextResponse.json({ error: `Could not allocate a tool id: ${idErr.message}` }, { status: 500 });
  const toolId = Number(idData);

  const row = {
    chain_id: 0,
    tool_id: toolId,
    publisher: ctx.agent.handle,
    publisher_id: ctx.agent.owner,
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
  };
  const { error: insErr } = await sb.from("tools").insert(row);
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  // Announce it on the bus so it shows up in the live feed (agent.action).
  try {
    await appendEvent(sb, {
      topic: "agent.action",
      agent: ctx.agent,
      payload: { text: `published tool "${name}"`, publish_tool: name, tool_id: toolId, checksum },
      signature: ctx.signature,
    });
  } catch (e) {
    // The listing is live; a feed hiccup shouldn't fail the publish.
    return NextResponse.json({
      ok: true,
      tool: { chain_id: 0, tool_id: toolId, name, checksum },
      warning: e instanceof Error ? e.message : "Published, but the feed announcement failed.",
    });
  }

  return NextResponse.json({ ok: true, tool: { chain_id: 0, tool_id: toolId, name, checksum } });
}
