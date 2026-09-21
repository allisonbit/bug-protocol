import "server-only";
import { canonicalJson, sha256Hex, verifyMessage } from "@/lib/agents/crypto";

/**
 * BINDING A TASK TO THE KEY THAT SENT IT.
 *
 * A2A establishes identity once, at the agent card, and then never again. A
 * September 2026 analysis of the protocol (A2ABreak) put the consequence plainly: a
 * delegated task carries a credential and no proof of which key composed it, so
 * everything downstream rests on the transport having been honest. This platform
 * already holds an Ed25519 public key for every registered agent, so the fix here is
 * small: let a caller sign the task itself, check that signature against the key the
 * registry already has, and record the RESULT of the check rather than the claim.
 *
 * WHAT IS COVERED, AND WHY EXACTLY THIS. The signed bytes are the canonical JSON of
 * the task's own fields: the caller, the text, and the caller's own external id when
 * it gave one. Nothing about the platform is in there, no timestamp, no server-side
 * id, because a caller cannot sign an id it has not been given yet and a signature
 * that covers a platform field would fail the moment the platform changed anything.
 * The consequence is honest and worth stating: this binds a KEY to a STRING, and it
 * does not prove the string arrived unaltered by a relay that held the signature.
 * What it proves is that the holder of the key chose those words, which is the fact
 * a reader of the queue actually needs.
 *
 * The canonical form is `canonicalJson`, the same one the bus uses for
 * signed events, so a caller that already signs events here needs no second
 * implementation. Field names in the message are the caller's vocabulary (caller,
 * text, external_id), not this platform's column names, because the caller composes
 * it and should not have to read a schema to do so.
 */

/** The bytes a caller signs to bind a delegated task to its key. */
export function taskBindingMessage(input: {
  caller: string;
  text: string;
  externalId?: string | null;
}): string {
  return canonicalJson({
    caller: input.caller,
    text: input.text,
    external_id: input.externalId ?? null,
  });
}

/** What the A2A door accepts as a binding, before anything is checked. */
export type BindingInput = { signature: string; keyId: string };

/**
 * Read a binding out of a request, or say it is malformed.
 *
 * Absent and malformed are different answers on purpose: an absent binding is
 * allowed, which keeps delegation from outside working exactly as it always has,
 * and a malformed one is refused before a task is written, so a caller never gets a
 * task it thinks is signed.
 */
export function bindingOf(params: Record<string, unknown>): BindingInput | null | "invalid" {
  const raw = params.binding as { signature?: unknown; keyId?: unknown } | undefined;
  if (raw === undefined || raw === null) return null;
  const signature = typeof raw.signature === "string" ? raw.signature.trim() : "";
  const keyId = typeof raw.keyId === "string" ? raw.keyId.trim() : "";
  if (!/^[0-9a-fA-F]{128}$/.test(signature) || !keyId || keyId.length > 200) return "invalid";
  return { signature, keyId };
}

/**
 * The record of what the check found.
 *
 * `verified: null` means it could not be checked rather than that it failed, which
 * is the distinction a reader needs: an anonymous caller's binding is not a lie, it
 * is an unchecked claim, and recording it as a failure would misrepresent them both.
 */
export type BindingRecord = {
  key_id: string;
  signature: string;
  alg: "ed25519";
  /** SHA-256 of the exact bytes that were signed, so the message is not stored twice. */
  message_sha256: string;
  verified: boolean | null;
  reason: string | null;
  checked_at: string;
};

/**
 * Check a binding against the public key the registry holds for the caller.
 *
 * The key comes from the database, never from the request: a caller that supplied
 * its own public key would be verifying itself, which is the failure mode this whole
 * mechanism exists to remove.
 */
export async function verifyTaskBinding(input: {
  sb: { from: (table: string) => unknown };
  caller: string;
  text: string;
  externalId: string | null;
  binding: BindingInput;
}): Promise<BindingRecord> {
  const message = taskBindingMessage({ caller: input.caller, text: input.text, externalId: input.externalId });
  const record: BindingRecord = {
    key_id: input.binding.keyId,
    signature: input.binding.signature,
    alg: "ed25519",
    message_sha256: sha256Hex(message),
    verified: null,
    reason: null,
    checked_at: new Date().toISOString(),
  };

  // Unauthenticated delegation is allowed, so a caller with no registration is not
  // an error. It is a caller whose binding nobody can check, and it is recorded as
  // exactly that.
  const lookup = input.sb.from("agents") as {
    select: (cols: string) => { eq: (col: string, value: string) => { maybeSingle: () => Promise<{ data: unknown; error: { message: string } | null }> } };
  };
  const { data, error } = await lookup.select("handle, public_key").eq("handle", input.caller).maybeSingle();
  if (error) {
    record.reason = `The registry could not be read, so the binding is unverified: ${error.message}`;
    return record;
  }
  const row = data as { handle: string; public_key: string | null } | null;
  if (!row) {
    record.reason = `No agent is registered as "${input.caller}", so there is no key to check this against. The binding is recorded as unchecked.`;
    return record;
  }
  if (!row.public_key) {
    record.reason = `@${row.handle} registered without a public key, so it cannot sign. The binding is recorded as unchecked.`;
    return record;
  }

  const ok = verifyMessage(message, input.binding.signature, row.public_key);
  record.verified = ok;
  record.reason = ok
    ? null
    : "The signature does not match the key this caller registered. The task is still recorded, because the record of a failed check is the point of making it.";
  return record;
}
