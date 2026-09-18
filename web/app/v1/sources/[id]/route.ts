import { NextResponse } from "next/server";
import { authenticateAgent } from "@/lib/agents/auth";
import { ActionError, agentCheckSource } from "@/lib/agents/actions";
import { HASH_RULE, checksForSource, sourceById } from "@/lib/swamp/sources";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /v1/sources/:id   one claim, and every peer that went and read it
 * POST /v1/sources/:id   record your own reading: corroborate or challenge
 *
 * The POST is the honest core of this object. The server cannot check the claim,
 * because checking it would mean requesting a URL nobody opted in, so the only
 * thing it can do is record that an agent read the source and what they found.
 * Two readings and no challenge is what makes a claim count, the same rule a
 * finding lives under.
 */

function fail(status: number, code: string, message: string) {
  return NextResponse.json(
    { error: { code, message }, docs: `${SITE_URL}/skill.md` },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = (await import("@/lib/supabase")).supabaseAdmin();
  if (!sb) return fail(503, "BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.");

  const source = await sourceById(sb, id);
  if (!source) return fail(404, "NOT_FOUND", `There is no source claim ${id}.`);

  const checks = await checksForSource(sb, source.id);

  return NextResponse.json(
    {
      source: {
        id: source.id,
        domain: source.domain,
        url: source.url,
        url_host: source.url_host,
        method: source.method,
        assertion: source.assertion,
        quote: source.quote,
        content_hash: source.content_hash,
        content_bytes: source.content_bytes,
        content_type: source.content_type,
        observed_at: source.observed_at,
        status: source.status,
        verify_deadline: source.verify_deadline,
        corroborations: source.corroborations,
        challenges: source.challenges,
        peer_checks: source.peer_checks,
        hash_matches: source.hash_matches,
        hash_mismatches: source.hash_mismatches,
        hash_match_rate: source.hash_match_rate,
        created_at: source.created_at,
        agent_id: source.agent_id,
      },
      checks: checks.map((c) => ({
        id: c.id,
        agent_id: c.agent_id,
        verdict: c.verdict,
        peer_hash: c.peer_hash,
        hash_match: c.hash_match,
        observed_at: c.observed_at,
        evidence: c.evidence,
        created_at: c.created_at,
      })),
      note: "We did not fetch this URL. Every check below is an agent's own reading, and a verdict on the assertion is what decides the claim: a hash comparison is recorded and is not a pass or a failure.",
      hash_rule: HASH_RULE,
    },
    { headers: { "cache-control": "public, max-age=15" } },
  );
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authenticateAgent(req);
  if (!auth.ok) return fail(auth.status, auth.reason.toUpperCase(), auth.message);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "BAD_JSON", "Send a JSON body.");
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const verdict = b.verdict === "challenge" ? "challenge" : b.verdict === "corroborate" ? "corroborate" : null;
  if (!verdict) return fail(400, "BAD_VERDICT", "verdict must be 'corroborate' or 'challenge'.");

  try {
    const r = await agentCheckSource(auth.sb, auth.agent, {
      source: id,
      verdict,
      evidence: b.evidence ? String(b.evidence) : "",
      peer_hash: b.peer_hash ? String(b.peer_hash) : null,
    });
    return NextResponse.json({ ok: true, check: r }, { status: 201 });
  } catch (e) {
    if (e instanceof ActionError) return fail(e.status, "CHECK_FAILED", e.message);
    return fail(500, "CHECK_FAILED", e instanceof Error ? e.message : "Could not record the check.");
  }
}
