import { NextResponse } from "next/server";
import { getTarget, getBoard, getFindings } from "@/lib/queries";
import { currentUser, supabaseServer } from "@/lib/supabase/server";
import { SUPABASE_CONFIGURED } from "@/lib/supabase/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/targets/[slug]: one target with its live board (active claims) and its
 * findings. Public read (Layer 3). Only opted-in, non-closed targets are exposed
 * here, so this API never reveals a target that hasn't joined the swarm.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const target = await getTarget(slug);
  if (!target || !target.opted_in || target.status === "closed") {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const [claims, findings] = await Promise.all([getBoard(target.id), getFindings(target.id)]);
  return NextResponse.json({ target, claims, findings });
}

const MAX_LIST = 50;

function cleanList(v: unknown, itemMax: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim().slice(0, itemMax)).filter(Boolean).slice(0, MAX_LIST);
}

function cleanScope(v: unknown): { in: string[]; out: string[]; rules: string } {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return {
    in: cleanList(o.in, 200),
    out: cleanList(o.out, 200),
    rules: typeof o.rules === "string" ? o.rules.slice(0, 4000) : "",
  };
}

// An owner may voluntarily retire or pause their own target, but never 'frozen'  // (that's an operator stop) and never 'active' back from a frozen state. RLS
// blocks both regardless, this just keeps the API's own error honest.
const OWNER_STATUSES = new Set(["active", "stale", "closed"]);

/**
 * PATCH /api/targets/[slug]: the owner edits their target WHILE IT IS PENDING.
 * Scope, domains, contact, notes, and a voluntary status (active/stale/closed)
 * only. Opting a target in and freezing it are not here; those are operator
 * actions (POST /api/admin/target), and the row-level policy blocks them from
 * this session path anyway. Once a target is opted in, it becomes operator-
 * managed and the owner can no longer edit it here (RLS returns zero rows).
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!SUPABASE_CONFIGURED) {
    return NextResponse.json({ error: "The swarm backend isn't configured on this deployment yet." }, { status: 503 });
  }
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in to edit a target." }, { status: 401 });
  const sb = await supabaseServer();
  if (!sb) {
    return NextResponse.json({ error: "The swarm backend isn't configured on this deployment yet." }, { status: 503 });
  }

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "JSON body required." }, { status: 400 });

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 120);
    if (name.length < 2) return NextResponse.json({ error: "Name must be at least 2 characters." }, { status: 400 });
    patch.name = name;
  }
  if (body.scope !== undefined) patch.scope = cleanScope(body.scope);
  if (body.domains !== undefined) patch.domains = cleanList(body.domains, 253);
  if (body.security_contact !== undefined) {
    patch.security_contact = String(body.security_contact).trim().slice(0, 200) || null;
  }
  if (body.notes !== undefined) patch.notes = String(body.notes).trim().slice(0, 4000) || null;
  if (body.status !== undefined) {
    const status = String(body.status);
    if (!OWNER_STATUSES.has(status)) {
      return NextResponse.json({ error: "You can set a target active, stale, or closed. Freezing is an operator action." }, { status: 400 });
    }
    patch.status = status;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  // RLS scopes this to a pending row the caller owns; a matched-zero update means
  // the target is missing, not theirs, or already opted in / frozen (operator-owned).
  const { data, error } = await sb.from("targets").update(patch).eq("slug", slug).select("*").maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) {
    return NextResponse.json(
      { error: "No pending target you own by that slug. Once a target is opted in, only the platform can change it." },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, target: data });
}
