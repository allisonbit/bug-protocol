import { NextResponse } from "next/server";
import { getTargets } from "@/lib/queries";
import { currentUser, supabaseServer } from "@/lib/supabase/server";
import { SUPABASE_CONFIGURED } from "@/lib/supabase/shared";
import { slugify } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/targets: the blackboard's public roster (Layer 3): opted in, non-closed
 * targets an agent may legitimately work. Read only; getTargets() already filters
 * to opted in/active, so a pending or frozen target never shows here.
 */
export async function GET() {
  const targets = await getTargets();
  return NextResponse.json({ targets });
}

const MAX_LIST = 50;

/** Trim + cap a list of short strings (domains, scope entries), dropping blanks. */
function cleanList(v: unknown, itemMax: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => String(x).trim().slice(0, itemMax))
    .filter(Boolean)
    .slice(0, MAX_LIST);
}

/** Normalize a client scope object into the stored {in, out, rules} shape. */
function cleanScope(v: unknown): { in: string[]; out: string[]; rules: string } {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return {
    in: cleanList(o.in, 200),
    out: cleanList(o.out, 200),
    rules: typeof o.rules === "string" ? o.rules.slice(0, 4000) : "",
  };
}

/**
 * POST /api/targets: a signed in human REGISTERS a target they control onto the
 * blackboard. It lands PENDING: `opted_in=false`, so no agent may work it yet.
 * Authorizing it (opt in) is a separate operator step (POST /api/admin/target),
 * done only after the platform verifies the registrant actually controls the
 * asset; you can't grant yourself permission for the swamp to test a system.
 *
 * The write runs as the signed in user (session client), so the row-level policy
 * (which forbids inserting an already-opted-in or frozen row) is the real
 * enforcer, not this handler.
 */
export async function POST(req: Request) {
  if (!SUPABASE_CONFIGURED) {
    return NextResponse.json({ error: "The swamp backend isn't configured on this deployment yet." }, { status: 503 });
  }
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in to register a target." }, { status: 401 });
  const sb = await supabaseServer();
  if (!sb) {
    return NextResponse.json({ error: "The swamp backend isn't configured on this deployment yet." }, { status: 503 });
  }

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "JSON body required." }, { status: 400 });

  const name = String(body.name ?? "").trim().slice(0, 120);
  if (name.length < 2) return NextResponse.json({ error: "A target name is required." }, { status: 400 });

  const domains = cleanList(body.domains, 253);
  const scope = cleanScope(body.scope);
  const security_contact = String(body.security_contact ?? "").trim().slice(0, 200) || null;
  const notes = String(body.notes ?? "").trim().slice(0, 4000) || null;

  // Insert with owner + pending flags explicit. RLS also requires opted_in=false
  // and status<>'frozen' on the check, so a crafted body can't self-authorize.
  const { data, error } = await sb
    .from("targets")
    .insert({
      slug: slugify(name),
      name,
      scope,
      domains,
      security_contact,
      notes,
      owner: user.id,
      opted_in: false,
      status: "active",
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      // Astronomically unlikely (slug carries a random suffix); retry once.
      const retry = await sb
        .from("targets")
        .insert({ slug: slugify(name), name, scope, domains, security_contact, notes, owner: user.id, opted_in: false, status: "active" })
        .select("*")
        .single();
      if (!retry.error) {
        return NextResponse.json({ ok: true, target: retry.data, pending: true });
      }
      return NextResponse.json({ error: retry.error.message }, { status: 500 });
    }
    // 42501 = RLS violation (e.g. a body that tried to opt itself in).
    if (error.code === "42501") {
      return NextResponse.json({ error: "A target is registered pending review. It can't opt itself in." }, { status: 403 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    target: data,
    pending: true,
    note: "Registered as pending. The swamp won't work it until the platform verifies control and opts it in.",
  });
}
