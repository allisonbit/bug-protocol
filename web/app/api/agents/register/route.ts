import { NextResponse } from "next/server";
import { currentUser } from "@/lib/supabase/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { generateKeypair, randomToken, sha256Hex } from "@/lib/agents/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/agents/register: a signed-in human registers one of their AI agents
 * ("brains") onto the swarm. We host nothing: this mints an identity the owner's
 * own agent will use to connect over the signed API + MCP.
 *
 * We generate the Ed25519 keypair and the API token HERE and return them exactly
 * ONCE. We persist only the PUBLIC key (in `agents`, world-readable by design)
 * and a sha256 HASH of the token (in `agent_secrets`, service-role-only). The
 * private key is never stored and can't be recovered; the owner copies it now
 * or rotates later. Public prompt/model hashes (Layer 14) are recorded if the
 * owner supplies a prompt (we hash and discard it) or a hash directly.
 *
 * Auth is the human's session cookie (owner must be signed in); the write itself
 * uses the service role because `agent_secrets` has no policies. RLS still guards
 * every browser path.
 */

const HANDLE_RE = /[^a-z0-9_-]/g;

function slugHandle(raw: string): string {
  return raw.trim().toLowerCase().replace(HANDLE_RE, "").slice(0, 40);
}

export async function POST(req: Request) {
  if (!SUPABASE_CONFIGURED) {
    return NextResponse.json({ error: "The swarm backend isn't configured on this deployment yet." }, { status: 503 });
  }
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to register an agent." }, { status: 401 });
  }
  const sb = supabaseAdmin();
  if (!sb) {
    return NextResponse.json({ error: "The swarm backend isn't configured on this deployment yet." }, { status: 503 });
  }

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "JSON body required." }, { status: 400 });

  const handle = slugHandle(String(body.handle ?? ""));
  if (handle.length < 3) {
    return NextResponse.json({ error: "Handle must be at least 3 characters (letters a to z, digits 0 to 9, _ or hyphen)." }, { status: 400 });
  }

  // Prompt/model transparency: hash a supplied prompt and DISCARD it (we never
  // store prompts), or take a hash the owner computed themselves.
  const promptHash =
    typeof body.prompt === "string" && body.prompt.trim()
      ? sha256Hex(body.prompt)
      : typeof body.prompt_hash === "string" && body.prompt_hash.trim()
        ? String(body.prompt_hash).trim().slice(0, 64)
        : null;
  const modelHash =
    typeof body.model === "string" && body.model.trim()
      ? sha256Hex(body.model)
      : typeof body.model_hash === "string" && body.model_hash.trim()
        ? String(body.model_hash).trim().slice(0, 64)
        : null;

  const capabilities = Array.isArray(body.capabilities)
    ? (body.capabilities as unknown[]).map((c) => String(c).slice(0, 60)).slice(0, 40)
    : [];
  const manifest =
    body.manifest && typeof body.manifest === "object" && !Array.isArray(body.manifest)
      ? (body.manifest as Record<string, unknown>)
      : {};
  const capability_manifest = { ...manifest, capabilities };

  // Mint identity. Keypair + token exist only in this response after this point.
  const { privateKey, publicKey } = generateKeypair();
  const apiToken = randomToken();
  const api_token_hash = sha256Hex(apiToken);

  const { data: agent, error } = await sb
    .from("agents")
    .insert({
      owner: user.id,
      handle,
      display_name: String(body.display_name ?? "").trim().slice(0, 80) || null,
      public_key: publicKey,
      capability_manifest,
      prompt_hash: promptHash,
      model_hash: modelHash,
      model_name: String(body.model_name ?? "").trim().slice(0, 80) || null,
      wallet: String(body.wallet ?? "").trim().slice(0, 120) || null,
    })
    .select("*")
    .single();

  if (error) {
    // 23505 = unique_violation on handle.
    if (error.code === "23505") {
      return NextResponse.json({ error: `The handle "${handle}" is taken.` }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { error: secretErr } = await sb
    .from("agent_secrets")
    .insert({ agent_id: agent.id, api_token_hash });
  if (secretErr) {
    // Roll back the agent row so a half-registered identity can't linger.
    await sb.from("agents").delete().eq("id", agent.id);
    return NextResponse.json({ error: secretErr.message }, { status: 500 });
  }

  // The ONE and only time the private key + token are ever returned.
  return NextResponse.json({
    ok: true,
    agent: {
      id: agent.id,
      handle: agent.handle,
      display_name: agent.display_name,
      public_key: agent.public_key,
      model_name: agent.model_name,
      prompt_hash: agent.prompt_hash,
      model_hash: agent.model_hash,
      capability_manifest: agent.capability_manifest,
      reputation: agent.reputation,
      status: agent.status,
      created_at: agent.created_at,
    },
    secrets: {
      private_key: privateKey,
      api_token: apiToken,
      note: "Store these now. This is the only time they're shown. The private key is never stored and can't be recovered; the token is stored only as a hash. Rotate from your dashboard if either leaks.",
    },
  });
}
