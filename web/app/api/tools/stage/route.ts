import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { supabaseAdmin, TOOLS_BUCKET } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phase A of publishing: stage the artifact off chain, content-addressed.
 * Receives the file + form metadata, computes the authoritative sha256 over the
 * bytes we actually stored, and returns that checksum for the publisher to
 * commit on chain, guaranteeing the onchain checksum matches the stored bytes.
 * Uploads both the artifact and a metadata.json under a folder named for the
 * hash, so re-staging identical bytes is idempotent.
 */
export async function POST(req: Request) {
  const sb = supabaseAdmin();
  if (!sb) return NextResponse.json({ error: "Supabase storage is not configured for this project." }, { status: 503 });

  const form = await req.formData();
  const file = form.get("file");
  const metaRaw = form.get("meta");
  if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });

  let meta: Record<string, unknown> = {};
  try {
    meta = metaRaw ? JSON.parse(String(metaRaw)) : {};
  } catch {
    return NextResponse.json({ error: "meta must be JSON" }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length === 0) return NextResponse.json({ error: "empty file" }, { status: 400 });

  const hex = createHash("sha256").update(buf).digest("hex");
  const checksum = `0x${hex}`;
  const safeName = ((file.name || "tool").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100)) || "tool";

  const artifactPath = `${hex}/${safeName}`;
  const up = await sb.storage.from(TOOLS_BUCKET).upload(artifactPath, buf, {
    contentType: file.type || "application/octet-stream",
    upsert: true,
  });
  if (up.error) return NextResponse.json({ error: up.error.message }, { status: 500 });
  const artifactUrl = sb.storage.from(TOOLS_BUCKET).getPublicUrl(artifactPath).data.publicUrl;

  const metadata = {
    standard: "bug-tool-metadata/1",
    name: String(meta.name ?? safeName),
    description: String(meta.description ?? ""),
    platform: Number(meta.platform ?? 0),
    category: Number(meta.category ?? 0),
    semver: String(meta.semver ?? ""),
    sourceUrl: meta.sourceUrl ? String(meta.sourceUrl) : null,
    publisher: meta.publisher ? String(meta.publisher) : null,
    checksum,
    artifactUrl,
    artifactName: safeName,
    size: buf.length,
    createdAt: new Date().toISOString(),
  };
  const metaBuf = Buffer.from(JSON.stringify(metadata, null, 2));
  const upm = await sb.storage.from(TOOLS_BUCKET).upload(`${hex}/metadata.json`, metaBuf, {
    contentType: "application/json",
    upsert: true,
  });
  if (upm.error) return NextResponse.json({ error: upm.error.message }, { status: 500 });
  const metadataUrl = sb.storage.from(TOOLS_BUCKET).getPublicUrl(`${hex}/metadata.json`).data.publicUrl;

  return NextResponse.json({ checksum, artifactUrl, metadataUrl, artifactName: safeName, size: buf.length });
}
