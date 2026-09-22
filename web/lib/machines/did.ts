import type { Machine } from "@/lib/agents/types";
import { ed25519Jwk, ed25519Multibase } from "@/lib/identity/key-encoding";
import { activeKey, keyState, type MachineKey } from "./identity";

/**
 * A DID PER MACHINE, derived from the key rows rather than stored.
 *
 * WHY A HARDWARE DEVICE GETS ONE. The agent layer already publishes a did:web for
 * every agent and for the deployment, and a machine that signs its reports has the
 * same problem an agent has: a verifier needs somewhere authoritative to look up
 * the key. Without that document, a reader would have to trust this platform's own
 * copy of the key inside the same store the readings live in, which is circular.
 * With it, the rule that already holds for agents holds here too, that a signature
 * is checked against a key fetched from the subject's own document.
 *
 * WHAT IT DOES NOT CLAIM. It does not say the firmware is the published one, the
 * sensor is calibrated, or the device is safe. It says which keys speak for this
 * machine, when each was retired or revoked, and where its telemetry arrives. Those
 * are the facts the store holds, and nothing beyond them is invented here.
 *
 * ONE ACTIVE KEY AT A TIME is published as the assertion key, because a document
 * with two live keys would force a verifier to guess which one signed a report.
 * Retired keys stay in the document behind a revocation-or-retirement assertion, so
 * a report signed before a rotation still has a key to check against.
 *
 * THE KEY IS ENCODED THE WAY A RESOLVER EXPECTS, NOT THE WAY THIS STORE HAPPENS TO
 * KEEP IT. The rows hold raw hex, but a JsonWebKey2020 method is a JWK: a document
 * that declares that type and then publishes only hex, or a null multibase, gives a
 * conformant consumer nothing to verify with, however readable it looks to us. So
 * every method carries `publicKeyJwk` and `publicKeyMultibase` computed by the same
 * encoders the platform and agent documents use, and keeps `publicKeyHex` as the
 * store's own spelling for readers of this platform.
 */

/** The DID for a machine on this deployment. */
export function machineDid(name: string, siteUrl: string): string {
  const host = siteUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  return `did:web:${host}:machines:${name}`;
}

/** Where a machine's telemetry door is, and where its page is. */
export function machineServiceEndpoints(name: string, siteUrl: string) {
  return [
    {
      id: "#telemetry",
      type: "MachineTelemetry",
      serviceEndpoint: `${siteUrl}/api/machines`,
      description: "Reports are PUT here with X-Machine-Token, and the same call returns queued commands.",
    },
    {
      id: "#release",
      type: "MachineRelease",
      serviceEndpoint: `${siteUrl}/api/machines/releases`,
      description: "Where the device asks what firmware it is offered, and reports what it installed.",
    },
    {
      id: "#page",
      type: "MachinePage",
      serviceEndpoint: `${siteUrl}/machines/${name}`,
      description: "The public record of this machine: readings, commands, key history, firmware.",
    },
  ];
}

export type MachineDidDocument = {
  "@context": string[];
  id: string;
  alsoKnownAs: string[];
  verificationMethod: {
    id: string;
    type: string;
    controller: string;
    publicKeyJwk: { kty: string; crv: string; x: string; kid?: string };
    publicKeyMultibase: string;
    publicKeyHex: string;
    retiredAt: string | null;
    revokedAt: string | null;
    note: string;
  }[];
  authentication: string[];
  assertionMethod: string[];
  service: ReturnType<typeof machineServiceEndpoints>;
  /** The facts this document states, and the ones it deliberately does not. */
  scope: string;
};

/**
 * Build the document.
 *
 * `nowMs` is passed rather than read, so the same rows always produce the same
 * document in a verifier and the tests do not depend on the clock.
 */
export function machineDidDocument(input: {
  machine: Pick<Machine, "name" | "kind" | "location" | "status" | "created_at">;
  keys: MachineKey[];
  siteUrl: string;
}): MachineDidDocument {
  const did = machineDid(input.machine.name, input.siteUrl);
  const current = activeKey(input.keys);
  const verificationMethod = input.keys.map((k) => {
    const raw = Buffer.from(k.public_key.replace(/^0x/i, ""), "hex");
    return {
      id: `${did}#${k.kid}`,
      type: "JsonWebKey2020",
      controller: did,
      // The same encoders the platform and agent documents use, so the three cannot
      // disagree about how one key is spelled.
      publicKeyJwk: ed25519Jwk(raw, k.kid),
      publicKeyMultibase: ed25519Multibase(raw),
      // The store's own spelling, kept because this platform's own readers use it.
      publicKeyHex: k.public_key,
      retiredAt: k.retired_at ?? null,
      revokedAt: k.revoked_at ?? null,
      note:
        keyState(k) === "active"
          ? "The key this machine signs with now."
          : keyState(k) === "revoked"
            ? `Revoked${k.revoked_reason ? `: ${k.revoked_reason}` : ""}. Nothing signed with it is accepted.`
            : "Retired by a rotation. It verifies only reports inside the rotation grace window.",
    };
  });

  return {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/jws-2020/v1"],
    id: did,
    alsoKnownAs: [`${input.siteUrl}/machines/${input.machine.name}`],
    verificationMethod,
    authentication: current ? [`${did}#${current.kid}`] : [],
    assertionMethod: current ? [`${did}#${current.kid}`] : [],
    service: machineServiceEndpoints(input.machine.name, input.siteUrl),
    scope:
      "This document states which keys speak for this machine and where its telemetry arrives. It does not assert that the firmware is the published one, that any sensor is calibrated, or that the machine is safe to be near. A verified signature over a report means the bytes came from the holder of the key, and nothing more.",
  };
}
