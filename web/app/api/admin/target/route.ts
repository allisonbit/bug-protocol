import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/agents/admin";
import type { Target, TargetStatus } from "@/lib/agents/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/target: the authorization decision for the blackboard (Layers
 * 3 + 14). A human registers a target as PENDING (POST /api/targets); this is
 * where the platform, having verified the registrant actually controls the
 * asset, opts it in, the moment the swarm is allowed to work it. It's also the
 * emergency stop for a single target: freeze it and ingest refuses all work
 * against it within seconds (resolveTarget requires status='active').
 *
 * Body: { slug, opted_in?: boolean, status?: 'active'|'stale'|'frozen'|'closed' }.
 * Runs with the service role, the ONLY path that may set opted_in=true or freeze
 * a target; the owner's session path is blocked from both by row-level security.
 */
const STATUSES = new Set<TargetStatus>(["active", "stale", "frozen", "closed"]);

export async function POST(req: Request) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.res;
  const sb = gate.sb;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "JSON body required." }, { status: 400 });

  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  if (!slug) return NextResponse.json({ error: "A target slug is required." }, { status: 400 });

  const patch: Record<string, unknown> = {};
  if (body.opted_in !== undefined) {
    if (typeof body.opted_in !== "boolean") {
      return NextResponse.json({ error: "`opted_in` must be a boolean." }, { status: 400 });
    }
    patch.opted_in = body.opted_in;
  }
  if (body.status !== undefined) {
    const status = String(body.status);
    if (!STATUSES.has(status as TargetStatus)) {
      return NextResponse.json({ error: "status must be active, stale, frozen, or closed." }, { status: 400 });
    }
    patch.status = status;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Provide opted_in and/or status to change." }, { status: 400 });
  }

  const { data, error } = await sb
    .from("targets")
    .update(patch)
    .eq("slug", slug)
    .select("id, slug, name, opted_in, status")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: `No target "${slug}".` }, { status: 404 });

  const t = data as Pick<Target, "id" | "slug" | "name" | "opted_in" | "status">;
  const note = t.opted_in && t.status === "active"      ? "Target authorized. The swarm may now work it."
    : t.status === "frozen"
      ? "Target frozen. Ingest refuses all work against it within seconds."
      : "Target updated.";
  return NextResponse.json({ ok: true, target: t, note });
}
