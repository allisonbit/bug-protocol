import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/agents/admin";
import { policyFor } from "@/lib/swamp/policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/swamp/seed-agents — register N Swamp-hosted reflex agents.
 *
 * WHAT THIS IS FOR. Standing up a habitat takes agents, and a fresh deployment
 * has none. This mints a small, bounded set of them in one call so an operator
 * can bring the swamp up and watch it work, instead of hand-registering a dozen
 * identities through the dashboard.
 *
 * WHAT THESE AGENTS ARE, EXACTLY. They are real registrations: real rows, real
 * pulse beats, real passive checks against opted-in targets, real findings with
 * real evidence. They are NOT independent researchers, and nothing here pretends
 * they are. They are Swamp-hosted reflex agents owned by the operator who called
 * this route, they are labelled that way in their capability manifest, and they
 * are born with no credentials at all:
 *
 *   - no private key exists. `public_key` is the sentinel `runtime:no-key`, so a
 *     key-signed write from this identity is refused rather than accepted against
 *     a key nobody holds. `verifyMessage()` returns false on it; it never throws.
 *   - no API token is minted, and no `agent_secrets` row is written. Nobody but
 *     the platform can act as one of these agents.
 *   - every event they cause is `provenance: runtime`.
 *
 * The alternative — generating throwaway keypairs and storing the public halves —
 * would put a key-looking value on the roster that no human can ever sign with.
 * That is the one thing this route must not do, so it doesn't.
 *
 * Body: { owner: <profile uuid | account email>, count?: number (default 3, max 12),
 *         prefix?: string (default "reflex"), brain?: 'reflex' | 'model' }
 *
 * Nothing acts until an operator turns the pulse on, and these agents can only
 * ever act against targets a separate operator has opted in. Registration is not
 * activity, and this route does not create any.
 */

const COUNT_DEFAULT = 3;
const COUNT_MAX = 12;
const MANIFEST_KIND = "swamp-hosted-reflex";

/** The honest placeholder for "this identity has no owner-held key". */
const NO_KEY = "runtime:no-key";

function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
}

/**
 * Resolve `owner` to a profile id. Accepts a uuid directly, or an email looked
 * up through the auth admin API, because an operator setting a deployment up
 * knows the account's email and shouldn't have to go find its uuid first.
 */
async function resolveOwner(
  sb: NonNullable<ReturnType<typeof import("@/lib/supabase").supabaseAdmin>>,
  raw: string,
): Promise<{ ok: true; id: string; email: string | null } | { ok: false; error: string }> {
  const value = raw.trim();
  if (!value) return { ok: false, error: "An `owner` (profile uuid or account email) is required." };

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    const { data } = await sb.from("profiles").select("id").eq("id", value).maybeSingle();
    if (!data) return { ok: false, error: `No profile with id ${value}.` };
    return { ok: true, id: value, email: null };
  }

  if (!value.includes("@")) {
    return { ok: false, error: "`owner` must be a profile uuid or an account email." };
  }

  // Small page walk; a deployment setting up a swamp does not have a million users.
  const target = value.toLowerCase();
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return { ok: false, error: `Couldn't read accounts: ${error.message}` };
    const users = data?.users ?? [];
    const hit = users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit) {
      const { data: profile } = await sb.from("profiles").select("id").eq("id", hit.id).maybeSingle();
      if (!profile) {
        return { ok: false, error: `${value} has an account but no profile row, so it can't own an agent yet.` };
      }
      return { ok: true, id: hit.id, email: hit.email ?? null };
    }
    if (users.length < 1000) break;
  }
  return { ok: false, error: `No account with the email ${value}.` };
}

export async function POST(req: Request) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.res;
  const sb = gate.sb;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.owner !== "string") {
    return NextResponse.json(
      {
        error: "An `owner` is required: the profile uuid or account email these agents belong to.",
        hint: "These are real registrations owned by a real account. There is no anonymous default.",
      },
      { status: 400 },
    );
  }

  const owner = await resolveOwner(sb, body.owner);
  if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: 404 });

  const brain = body.brain === "model" ? "model" : "reflex";
  const wanted = Number(body.count);
  const count = Number.isFinite(wanted) && wanted >= 1 ? Math.min(Math.floor(wanted), COUNT_MAX) : COUNT_DEFAULT;
  const prefix = slug(String(body.prefix ?? "reflex")) || "reflex";

  // The policy descriptor IS the transparency record for a reflex agent: the
  // hash published on its page is a commitment to the rule list this deployment
  // actually evaluates. Nothing is invented to fill these columns.
  const policy = policyFor(brain);

  const created: { id: string; handle: string }[] = [];
  const skipped: string[] = [];

  for (let i = 1; i <= count; i++) {
    const handle = `${prefix}-${String(i).padStart(2, "0")}`;
    const { data, error } = await sb
      .from("agents")
      .insert({
        owner: owner.id,
        handle,
        display_name: `${prefix} ${String(i).padStart(2, "0")} (Swamp-hosted)`,
        // No key exists for a hosted agent. Say so where a key would go, rather
        // than parking a public key no human can sign against.
        public_key: NO_KEY,
        capability_manifest: {
          kind: MANIFEST_KIND,
          capabilities: ["recon", "web", "tls", "dns"],
          hosted_by: "swamp",
          note: "Swamp-hosted agent. Real pulse beats, real passive checks, events labelled provenance=runtime. Not an independent researcher; it has no owner-held key and no API token.",
        },
        prompt_hash: brain === "reflex" ? policy.hash : null,
        model_hash: brain === "model" ? policy.hash : null,
        model_name: policy.name,
        brain,
        runtime_enabled: true,
        // Idle, not active: a fresh identity has done nothing yet, and "active"
        // would claim a heartbeat that hasn't happened.
        status: "idle",
      })
      .select("id, handle")
      .maybeSingle();

    if (error) {
      // 23505 = the handle is taken; skip it rather than failing the whole call.
      if (error.code === "23505") {
        skipped.push(handle);
        continue;
      }
      return NextResponse.json({ error: `${handle}: ${error.message}`, created }, { status: 500 });
    }
    if (data) created.push(data as { id: string; handle: string });
  }

  return NextResponse.json({
    ok: true,
    owner: { id: owner.id, email: owner.email },
    created,
    skipped,
    brain,
    policy: { name: policy.name, hash: policy.hash, version: policy.version, deterministic: policy.deterministic },
    note:
      `${created.length} Swamp-hosted ${brain} agent(s) registered. They have no private key and no API token — ` +
      "only the platform can act as them, and everything they do is labelled provenance=runtime. " +
      "They will do nothing until two things are true: an operator sets pulse_enabled, and there is an " +
      "opted-in target for them to work. Register nothing here you would not be willing to describe as " +
      "Swamp-hosted on the roster, because that is exactly how they are labelled.",
  });
}
