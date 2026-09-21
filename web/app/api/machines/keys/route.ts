import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { currentUser } from "@/lib/supabase/server";
import { SITE_URL } from "@/lib/site";
import { keysFor, machineForToken, machineToken, nextKid } from "@/lib/machines/auth";
import { keyState } from "@/lib/machines/identity";
import { machineDid } from "@/lib/machines/did";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE KEY DOOR.
 *
 *   PUT   register: a device's first key, refused when one is already active
 *   POST  rotate: a device registers a new key and retires the one it had
 *   PATCH revoke: an owner revokes a key, with a reason, and it verifies nothing after
 *   GET   the key history for a machine (public: a public key is public)
 *
 * WHY PUT AND POST ARE DIFFERENT DOORS. A device's first key and a device's second key are
 * different acts: one creates an identity, the other replaces a key that reports have
 * already been signed with. PUT is the first and refuses when an active key already
 * exists, so a device cannot silently replace its identity by repeating a request it
 * sent at commissioning. Rotation is POST, and it says in its reply which key it retired.
 *
 * WHY THE DEVICE ROTATES ITS OWN KEY. The private half is generated on the device and
 * never leaves it, which is the only arrangement in which the signature means anything.
 * A platform that minted the key would be a platform whose copy of the private key is
 * the real one, and every verification would be theatre. So the device sends the public
 * half and this door refuses a request that carries none: generating a keypair here and
 * handing the private key back would make this deployment the holder of every robot's
 * signing key, which is exactly the arrangement the identity layer claims it does not
 * have. An ESP32 with mbedtls generates an Ed25519 key in microseconds, so there is no
 * device for which this is a burden.
 *
 * WHY AN OWNER CAN REVOKE BUT NOT CREATE. Creating a key the device does not hold
 * would produce reports that verify and are worthless. Revoking is the opposite act:
 * it says this key is no longer mine, and it has to be available to the person who
 * owns the hardware, because a stolen device is the case that matters.
 */

function fail(code: string, message: string, status: number, details?: Record<string, unknown>) {
  return NextResponse.json({ error: { code, message, details: details ?? {} }, docs: `${SITE_URL}/machines/guide` }, { status, headers: { "cache-control": "no-store" } });
}

// ---- POST: rotate -----------------------------------------------------------

export async function POST(req: Request) {
  const auth = await machineForToken(machineToken(req));
  if (!auth.ok) return fail(auth.code, auth.message, auth.status);
  const { machine, sb } = auth;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 120) || null : null;

  // The device's own public key, parsed by the same function PUT uses so the two
  // doors cannot disagree about what a valid key is.
  const parsed = readPublicKey(body);
  if (!parsed.ok) return fail("BAD_PUBLIC_KEY", parsed.reason, 400, { example: { public_key: "<64 hex characters>", label: "esp32-s3 on the roof" } });
  const publicKey = parsed.publicKey;

  const existing = await keysFor(sb, machine.id);
  const kid = nextKid(existing.map((k) => k.kid));
  const nowIso = new Date().toISOString();

  // Retire first, then insert. The partial unique index allows one active key, so
  // the other order would fail on the index; and if the insert then fails the
  // machine is left with no active key, which is a visible state rather than a
  // silent one: the door says so and the row stays retired.
  const toRetire = existing.filter((k) => !k.retired_at && !k.revoked_at);
  if (toRetire.length > 0) {
    const { error: retireErr } = await sb
      .from("machine_keys")
      .update({ retired_at: nowIso })
      .in("kid", toRetire.map((k) => k.kid))
      .eq("machine_id", machine.id);
    if (retireErr) return fail("ROTATION_FAILED", `The previous key could not be retired: ${retireErr.message}`, 500);
  }

  const { error } = await sb.from("machine_keys").insert({
    machine_id: machine.id,
    kid,
    public_key: publicKey,
    algo: "ed25519",
    label,
  });
  if (error) {
    return fail(
      "ROTATION_FAILED",
      `The new key could not be registered: ${error.message}. ${toRetire.length > 0 ? `The previous key ${toRetire[0].kid} is retired, so no key is active on this machine until one is registered.` : ""}`,
      500,
    );
  }

  await sb
    .from("events")
    .insert({
      topic: "machine.key.rotated",
      agent_id: null,
      agent_handle: null,
      payload: {
        text: `${machine.name} rotated its signing key to ${kid}${toRetire.length > 0 ? `, retiring ${toRetire.map((k) => k.kid).join(", ")}` : ""}`,
        machine: machine.name,
        kid,
        retired: toRetire.map((k) => k.kid),
      },
      signature: null,
      signed_ok: false,
      provenance: "system",
    })
    .then(undefined, () => null);

  return NextResponse.json(
    {
      ok: true,
      kid,
      public_key: publicKey,
      retired: toRetire.map((k) => k.kid),
      did: machineDid(machine.name, SITE_URL),
      how_to_sign: {
        step_1: "Build the canonical message, six lines joined by \\n: machine-report:v1, machine:<name>, kid:<kid>, nonce:<unique per report>, ts:<ISO timestamp>, readings:<canonical JSON of your readings array>.",
        step_2: "Sign it with Ed25519 and send the report with `signature`, `kid`, `nonce` and `ts` alongside `readings`.",
        step_3: `PUT ${SITE_URL}/api/machines with X-Machine-Token. Unsigned reports are still accepted and recorded as unsigned.`,
        canonical_json: "Object keys sorted, no spaces, numbers plain. Both the JS client and the ESP32 example build it this way.",
      },
      warning: "Nothing here can recover a private key, because this deployment never had one. If the device loses it, rotate: generate a new pair on the device, send the public half, and the retired key stops verifying outside the grace window. Nothing already written is rewritten.",
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

// ---- PUT: register the first key --------------------------------------------

/** Pull the public half out of a request body, or say why it cannot be used. */
function readPublicKey(body: Record<string, unknown> | null): { ok: true; publicKey: string } | { ok: false; reason: string } {
  const supplied = typeof body?.public_key === "string" ? (body.public_key as string).trim() : "";
  if (!supplied) {
    return {
      ok: false,
      reason:
        "Send `public_key`, the public half of a key the device generated itself. This deployment will not mint a signing key for a robot: a private key that has been through this server is a private key whose signature means nothing, because whoever handled the reply could have signed with it too. On an ESP32, generate it once and keep it in NVS.",
    };
  }
  const hex = supplied.replace(/^0x/i, "");
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return { ok: true, publicKey: hex.toLowerCase() };
  try {
    const raw = Buffer.from(supplied, "base64");
    if (raw.length === 32) return { ok: true, publicKey: raw.toString("hex") };
  } catch {
    /* falls through to the refusal */
  }
  return { ok: false, reason: "`public_key` must be a raw Ed25519 public key: 32 bytes as 64 hex characters, or the same 32 bytes in base64. Send the public half only. This door has no use for a private key and will not accept one." };
}

export async function PUT(req: Request) {
  const auth = await machineForToken(machineToken(req));
  if (!auth.ok) return fail(auth.code, auth.message, auth.status);
  const { machine, sb } = auth;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const parsed = readPublicKey(body);
  if (!parsed.ok) return fail("BAD_PUBLIC_KEY", parsed.reason, 400, { example: { public_key: "<64 hex characters>", label: "esp32-s3 on the roof" } });

  const existing = await keysFor(sb, machine.id);
  const live = existing.filter((k) => !k.retired_at && !k.revoked_at);
  if (live.length > 0) {
    return fail(
      "KEY_ALREADY_ACTIVE",
      `${machine.name} already holds the active key ${live[0].kid}. Registering a first key is PUT; replacing a key is POST, which retires the old one and says so in its reply. That difference exists so a device repeating a commissioning request cannot quietly replace its own identity.`,
      409,
      { rotate: `POST ${SITE_URL}/api/machines/keys with X-Machine-Token and { public_key: "<64 hex>" }` },
    );
  }

  const kid = nextKid(existing.map((k) => k.kid));
  const label = typeof body?.label === "string" ? (body.label as string).trim().slice(0, 120) || null : null;
  const { error } = await sb.from("machine_keys").insert({ machine_id: machine.id, kid, public_key: parsed.publicKey, algo: "ed25519", label });
  if (error) return fail("KEY_REFUSED", error.message, 500);

  await sb
    .from("events")
    .insert({
      topic: "machine.key.rotated",
      agent_id: null,
      agent_handle: null,
      payload: {
        text: `${machine.name} registered its first signing key, ${kid}`,
        machine: machine.name,
        kid,
        retired: [],
      },
      signature: null,
      signed_ok: false,
      provenance: "machine",
    })
    .then(undefined, () => null);

  return NextResponse.json(
    {
      ok: true,
      kid,
      public_key: parsed.publicKey,
      retired: [],
      did: machineDid(machine.name, SITE_URL),
      how_to_sign: {
        step_1: "Build the canonical message, six lines joined by \\n: machine-report:v1, machine:<name>, kid:<kid>, nonce:<unique per report>, ts:<ISO timestamp>, readings:<canonical JSON of your readings array>.",
        step_2: "Sign it with Ed25519 and send the report with `signature`, `kid`, `nonce` and `ts` alongside `readings`.",
        step_3: `PUT ${SITE_URL}/api/machines with X-Machine-Token. Unsigned reports are still accepted and recorded as unsigned.`,
        canonical_json: "Object keys sorted, no spaces, numbers plain. The JS client, the Python client and the ESP32 example all build it this way.",
      },
      warning: "Nothing here can recover a private key, because this deployment never had one. If the device loses it, rotate with POST and the retired key stops verifying outside the grace window. Nothing already written is rewritten.",
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

// ---- PATCH: revoke ----------------------------------------------------------

export async function PATCH(req: Request) {
  if (!SUPABASE_CONFIGURED) return fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503);
  const user = await currentUser();
  if (!user) return fail("SIGN_IN_REQUIRED", "Revoking a key is an owner's act: sign in first.", 401, { login: `${SITE_URL}/login` });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return fail("JSON_REQUIRED", "Send { machine, kid, reason }.", 400);
  const name = String(body.machine ?? "").trim().toLowerCase();
  const kid = String(body.kid ?? "").trim();
  const reason = String(body.reason ?? "").trim();
  if (!name || !kid) return fail("BAD_REQUEST", "Both `machine` and `kid` are required.", 400);
  if (reason.length < 10) {
    return fail("REASON_REQUIRED", "Say why the key is revoked, in at least 10 characters. A revocation without a reason is a fact nobody can evaluate later.", 400);
  }

  const admin = supabaseAdmin();
  if (!admin) return fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503);
  const { data: machineRow } = await admin.from("machines").select("*").eq("name", name).maybeSingle();
  const machine = machineRow as { id: string; name: string; owner: string | null } | null;
  if (!machine) return fail("NOT_FOUND", `No machine named "${name}" is registered.`, 404);
  if (machine.owner !== user.id) {
    return fail(
      "NOT_OWNER",
      `@${user.id.slice(0, 8)} does not own ${name}. Only the account that registered a machine may revoke its keys, which is the point of the owner column.`,
      403,
    );
  }

  const { data, error } = await admin
    .from("machine_keys")
    .update({ revoked_at: new Date().toISOString(), revoked_reason: reason.slice(0, 300) })
    .eq("machine_id", machine.id)
    .eq("kid", kid)
    .is("revoked_at", null)
    .select("kid")
    .maybeSingle();
  if (error) return fail("REVOKE_FAILED", error.message, 500);
  if (!data) return fail("NOT_FOUND", `No live key ${kid} on ${name}. It may already be revoked.`, 404);

  await admin
    .from("events")
    .insert({
      topic: "machine.key.revoked",
      agent_id: null,
      agent_handle: null,
      payload: { text: `${name} lost key ${kid}: ${reason.slice(0, 160)}`, machine: name, kid, reason: reason.slice(0, 300) },
      signature: null,
      signed_ok: false,
      provenance: "system",
    })
    .then(undefined, () => null);

  return NextResponse.json(
    {
      ok: true,
      machine: name,
      kid,
      reason,
      note: "Nothing signed with this key verifies any more, including reports inside the rotation grace window. Readings already recorded keep their own signature verdict, because a revocation changes what is accepted next and not what was accepted then.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}

// ---- GET: the key history ---------------------------------------------------

export async function GET(req: Request) {
  const sb = supabaseAdmin();
  if (!sb || !SUPABASE_CONFIGURED) return fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503);
  const name = new URL(req.url).searchParams.get("machine")?.trim().toLowerCase();
  if (!name) {
    return fail("BAD_REQUEST", "Name a machine: GET /api/machines/keys?machine=<name>.", 400, { example: `${SITE_URL}/api/machines/keys?machine=atlas` });
  }
  const { data: machineRow } = await sb.from("machines").select("*").eq("name", name).maybeSingle();
  const machine = machineRow as { id: string; name: string } | null;
  if (!machine) return fail("NOT_FOUND", `No machine named "${name}" is registered.`, 404);

  const keys = await keysFor(sb, machine.id);
  return NextResponse.json(
    {
      machine: machine.name,
      did: machineDid(machine.name, SITE_URL),
      keys: keys.map((k) => ({
        kid: k.kid,
        public_key: k.public_key,
        algo: k.algo,
        state: keyState(k),
        created_at: k.created_at,
        retired_at: k.retired_at,
        revoked_at: k.revoked_at,
        revoked_reason: k.revoked_reason,
      })),
      note:
        "Public keys only, which is why this is public. A signature is checked against the key the machine's DID document publishes, so a reader can verify a reading without trusting this store's copy of the key.",
      did_url: `${SITE_URL}/api/machines/${machine.name}/did.json`,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
