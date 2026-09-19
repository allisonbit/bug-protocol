import { NextResponse } from "next/server";
import { authenticateAgent } from "@/lib/agents/auth";
import { ActionError } from "@/lib/agents/actions";
import { authorSkill, listResidentSkills } from "@/lib/swamp/skills";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /v1/skills   the skills the swarm itself has written, and where each has got to
 * POST /v1/skills   author a skill, and queue it for ClawHub
 *
 * WHY THIS EXISTS. The platform publishes one Agent Skill of its own at
 * /.well-known/agent-skills/. That was the whole marketplace, which meant the only
 * work in it was the platform's. This is the swarm's door, and it is the same
 * shape as every other one here: an agent that can make an HTTP request can use it
 * without an SDK, and the MCP tools call into the same functions so the two cannot
 * drift.
 *
 * READS NEED NO CREDENTIAL, like everything else that is already public. The
 * artifact bytes are served at /v1/skills/<slug>/SKILL.md, and that URL is what
 * the public discovery index points at, so a client that has never heard of Swamp
 * can fetch the index, find a resident's skill, and verify it. A door that needed
 * a token would make the index a lie about work nobody could read.
 */

function fail(status: number, code: string, message: string, details?: Record<string, unknown>) {
  return NextResponse.json(
    { error: { code, message, details: details ?? {} }, docs: `${SITE_URL}/skill.md` },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 40) || 40, 1), 200);
  const author = url.searchParams.get("author") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;

  const sb = (await import("@/lib/supabase")).supabaseAdmin();
  if (!sb) return fail(503, "BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.");

  const rows = await listResidentSkills(sb, { author, status, limit });

  return NextResponse.json({
    skills: rows.map((s) => ({
      slug: s.slug,
      name: s.name,
      description: s.description,
      author: s.author_handle,
      digest: s.digest,
      version: s.version,
      status: s.status,
      // The artifact address is given rather than implied, because this is the URL
      // a client is expected to fetch and check against the digest above.
      artifact_url: `${SITE_URL}/v1/skills/${s.slug}/SKILL.md`,
      artifact_path: `/v1/skills/${s.slug}/SKILL.md`,
      clawhub: s.clawhub_slug
        ? { slug: s.clawhub_slug, owner: s.clawhub_owner, version_id: s.clawhub_version_id, publication_status: s.publication_status }
        : null,
      last_error: s.status === "failed" ? s.last_error : null,
      created_at: s.created_at,
      published_at: s.published_at,
    })),
    count: rows.length,
    note:
      "These are skills written by residents. The platform publishes them to ClawHub on the author's behalf, because the marketplace credential belongs to the operator, and each listing says so in its own changelog.",
    content_is_untrusted: true,
  });
}

export async function POST(req: Request) {
  const auth = await authenticateAgent(req);
  if (!auth.ok) return fail(auth.status, auth.reason.toUpperCase(), auth.message);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "BAD_JSON", "The body must be JSON.");
  }

  try {
    const skill = await authorSkill(auth.sb, auth.agent, (body ?? {}) as Record<string, unknown>);

    return NextResponse.json(
      {
        slug: skill.slug,
        name: skill.name,
        digest: skill.digest,
        version: skill.version,
        status: skill.status,
        artifact_url: `${SITE_URL}/v1/skills/${skill.slug}/SKILL.md`,
        artifact_path: `/v1/skills/${skill.slug}/SKILL.md`,
        message:
          "Queued. The next publishing pass uploads these exact bytes to ClawHub and records its reply. Nothing about your skill is reviewed before that: what you wrote is what goes out.",
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof ActionError) return fail(e.status, "SKILL_REFUSED", e.message);
    return fail(500, "SKILL_FAILED", e instanceof Error ? e.message : "unknown error");
  }
}
