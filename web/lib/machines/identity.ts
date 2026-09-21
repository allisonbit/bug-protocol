import { canonicalJson, sha256Hex, verifyMessage } from "@/lib/agents/crypto";

/**
 * MACHINE IDENTITY: what a device signs, and what the record can then say.
 *
 * PURE, like the rest of this layer, so the canonical form and every refusal
 * branch can be exercised without hardware, a database or a network.
 * `scripts/verify-machine-identity.cjs` walks all of it.
 *
 * WHAT A SIGNATURE BUYS, AND WHAT IT DOES NOT. A verified signature says the
 * bytes came from whoever holds the private key bound to this machine. It does
 * not say the device is trustworthy, the firmware is the one we published, or
 * the sensor is calibrated. Those are different claims with different evidence,
 * and this platform keeps them separate everywhere else, so it keeps them
 * separate here.
 *
 * WHY THE CANONICAL FORM IS SPELLED OUT RATHER THAN A JSON BLOB. A device in C,
 * MicroPython or Lua has to reproduce this string byte for byte, and a client
 * that cannot reproduce it cannot sign. So the recipe is six lines of text with
 * fixed prefixes, the readings serialised as canonical JSON (keys sorted, no
 * incidental whitespace), and nothing else. It is published in the guide and in
 * the skill, and the robots simulator in `scripts/robot-sim.cjs` builds it the
 * same way from the other side.
 */

/** The shape a device sends alongside its readings. */
export type ReportSignature = {
  /** The key id, as registered. */
  kid?: unknown;
  /** Hex Ed25519 signature over `canonicalReport`. */
  signature?: unknown;
  /** A unique value per report, so two identical reports are still two messages. */
  nonce?: unknown;
  /** ISO timestamp from the device's own clock, when it has one. */
  ts?: unknown;
};

export type SignedReportCheck =
  | { ok: true; signed: true; kid: string; digest: string }
  | { ok: true; signed: false; reason: string; digest: null }
  | { ok: false; code: string; reason: string };

/**
 * The exact bytes a device signs.
 *
 * Fixed field order, prefixed lines, and the readings canonicalised. Do not
 * reorder or re-prefix: this string is a contract with every client.
 */
export function canonicalReport(input: {
  machine: string;
  kid: string;
  nonce: string;
  ts: string;
  readings: unknown;
}): string {
  return [
    "machine-report:v1",
    `machine:${input.machine}`,
    `kid:${input.kid}`,
    `nonce:${input.nonce}`,
    `ts:${input.ts}`,
    `readings:${canonicalJson(input.readings)}`,
  ].join("\n");
}

/**
 * sha256 of the canonical message, hex. The receipt and the replay guard are keyed on it.
 *
 * The same helper the agent layer hashes tokens with, imported rather than reimplemented:
 * two sha256s in one codebase is two chances for one of them to disagree about encoding,
 * and the digest is the whole binding here.
 */
export function reportDigest(message: string): string {
  return sha256Hex(message);
}

/** A key as stored, with the lifecycle fields the decision needs. */
export type MachineKey = {
  kid: string;
  public_key: string;
  algo?: string | null;
  created_at?: string | null;
  retired_at?: string | null;
  revoked_at?: string | null;
  revoked_reason?: string | null;
};

export type KeyState = "active" | "retired" | "revoked";

/** How long a retired key still verifies reports signed before it was retired. */
export const ROTATION_GRACE_MS = 15 * 60 * 1000;

/**
 * What state a key is in, from the rows rather than from a flag somebody sets.
 *
 * A revoked key is revoked. A retired key is inside its grace window for a while,
 * because a device that rotates between signing and sending must not have that
 * report thrown away, and then it stops verifying. An active key is the only one
 * that may be named as the current key in a DID document.
 */
export function keyState(key: MachineKey, _nowMs?: number): KeyState {
  if (key.revoked_at) return "revoked";
  return key.retired_at ? "retired" : "active";
}

/** The key a DID document should publish as current, or null when none is. */
export function activeKey(keys: MachineKey[]): MachineKey | null {
  return keys.find((k) => !k.retired_at && !k.revoked_at) ?? null;
}

/**
 * Whether a key may verify a report, and the reason when it may not.
 *
 * The grace window is real rather than decorative: a retired key verifies a report
 * whose device timestamp falls no later than the retirement plus the window, which
 * covers the device that rotated while a report was in flight and covers nothing
 * else. A key revoked for cause verifies nothing, whatever the timestamp says.
 */
export function keyMayVerify(
  key: MachineKey,
  nowMs: number,
  reportTsMs?: number,
): { ok: true } | { ok: false; reason: string } {
  if (key.revoked_at) {
    return {
      ok: false,
      reason: `${key.kid} was revoked${key.revoked_reason ? ` (${key.revoked_reason})` : ""}, so nothing signed with it is accepted any more`,
    };
  }
  if (key.retired_at) {
    const retired = Date.parse(key.retired_at);
    const ts = typeof reportTsMs === "number" ? reportTsMs : Number.NaN;
    const inside = Number.isFinite(retired) && Number.isFinite(ts) && ts <= retired + ROTATION_GRACE_MS && ts >= retired - 24 * 60 * 60 * 1000;
    if (!inside) {
      return {
        ok: false,
        reason: `${key.kid} was retired at ${key.retired_at}, and this report's own timestamp is outside the rotation grace window of ${Math.round(ROTATION_GRACE_MS / 60000)} minutes`,
      };
    }
  }
  return { ok: true };
}

/** Whether a key may be retired by a rotation, which it may as long as it is live. */
export function keyMayRetire(key: MachineKey): boolean {
  return !key.retired_at && !key.revoked_at;
}

/**
 * Check one report's signature.
 *
 * The three outcomes are deliberately distinct. `signed: true` is a verified
 * report. `signed: false` with a reason is a report that arrived unsigned, or
 * with a key this machine does not hold, and it is STORED with that fact on it,
 * because a record that quietly dropped the unsigned half would flatter itself.
 * `ok: false` is reserved for a report that cannot be judged at all, a malformed
 * signature or a missing nonce, where writing a row would imply we checked it.
 */
export function checkReport(input: {
  machine: string;
  readings: unknown;
  signature: ReportSignature | null | undefined;
  keys: MachineKey[];
  nowMs: number;
}): SignedReportCheck {
  const sig = input.signature ?? {};
  const hasAnything = typeof sig.signature === "string" && sig.signature.trim().length > 0;

  if (!hasAnything) {
    return {
      ok: true,
      signed: false,
      reason: "unsigned: the report carried no signature, which this platform records rather than refuses, because an unsigned reading is not the same thing as a bad one",
      digest: null,
    };
  }

  const kid = typeof sig.kid === "string" ? sig.kid.trim() : "";
  const signature = String(sig.signature).trim();
  const nonce = typeof sig.nonce === "string" ? sig.nonce.trim() : "";
  const ts = typeof sig.ts === "string" ? sig.ts.trim() : "";

  if (!kid) return { ok: false, code: "NO_KID", reason: "A signed report must name its key with `kid`, so a rotation cannot be ambiguous." };
  if (!/^[0-9a-fA-F]{128}$/.test(signature.replace(/^0x/i, ""))) {
    return { ok: false, code: "BAD_SIGNATURE_SHAPE", reason: "`signature` must be the 64 byte hex Ed25519 signature over the canonical message." };
  }
  if (!nonce) {
    return {
      ok: false,
      code: "NO_NONCE",
      reason: "A signed report must carry a `nonce`, so a replay is a distinct message rather than the same one twice.",
    };
  }
  if (!ts || !Number.isFinite(Date.parse(ts))) {
    return {
      ok: false,
      code: "BAD_TS",
      reason: "A signed report must carry `ts`, an ISO timestamp, so the record can say when the device believed it sent this.",
    };
  }

  const key = input.keys.find((k) => k.kid === kid);
  if (!key) {
    return {
      ok: true,
      signed: false,
      reason: `unsigned: no key with kid ${kid} is bound to this machine, so the signature could not be checked`,
      digest: null,
    };
  }
  const may = keyMayVerify(key, input.nowMs, Date.parse(ts));
  if (!may.ok) return { ok: true, signed: false, reason: `unsigned: ${may.reason}`, digest: null };

  const message = canonicalReport({ machine: input.machine, kid, nonce, ts, readings: input.readings });
  const digest = reportDigest(message);
  if (!verifyMessage(message, signature, key.public_key)) {
    return { ok: true, signed: false, reason: `unsigned: the signature did not verify against ${kid}`, digest: null };
  }
  return { ok: true, signed: true, kid, digest };
}

/**
 * Whether a rotation is allowed, and what it does to the previous key.
 *
 * One active key at a time, which the database also enforces with a partial unique
 * index: a machine that could hold two live keys would have two answers to "which
 * key speaks for this robot", and the DID document would have to pick.
 */
export function rotationDecision(input: { keys: MachineKey[]; nowMs: number }): { ok: true; retired: MachineKey[] } | { ok: false; reason: string } {
  const live = input.keys.filter((k) => !k.revoked_at);
  const active = live.filter((k) => !k.retired_at);
  if (active.length > 1) {
    return {
      ok: false,
      reason: `This machine holds ${active.length} active keys, which should be impossible: the store enforces one at a time. Nothing was changed.`,
    };
  }
  return { ok: true, retired: active };
}
