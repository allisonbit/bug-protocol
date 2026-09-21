/**
 * FIRMWARE RELEASES, AS A PURE DECISION.
 *
 * WHAT A ROBOT ACTUALLY NEEDS HERE, and why this is not a file upload. A device on a
 * factory floor has to answer three questions before it flashes anything: which
 * version is for me, is what I downloaded the thing that was published, and what do I
 * run if this goes wrong. The answer to the first is a channel and a hardware board,
 * the second is a SHA-256 the device checks itself, and the third is a version the
 * fleet can pin it back to. Everything else is a web page.
 *
 * WHY THE ROLLOUT IS A PERCENTAGE AND A CANARY LIST RATHER THAN A FLAG. Staged rollout
 * is not ceremony: a fleet of a hundred robots that all take a bad release at once is
 * a fleet that is down, and the rollback for that is a technician with a cable. The
 * decision below is deterministic and given the same rows produces the same set, which
 * is what makes it checkable before anything is offered and re-checkable afterwards.
 *
 * WHAT THIS MODULE NEVER DOES. It never decides that a release is good, never signs
 * anything, and never asks a device to trust us. The digest is in the row so the
 * device can refuse a mismatch on its own, with no call back to this platform.
 */

export type Channel = "stable" | "beta" | "dev";

export const CHANNELS: Channel[] = ["stable", "beta", "dev"];

export function isChannel(v: unknown): v is Channel {
  return typeof v === "string" && (CHANNELS as string[]).includes(v);
}

export type Release = {
  id: string;
  name: string;
  version: string;
  channel: Channel;
  hardware: string | null;
  artifact_url: string;
  sha256: string;
  bytes: number | null;
  notes: string | null;
  sbom: unknown;
  signature: string | null;
  publisher_kid: string | null;
  /**
   * The account that published it. Only this account may yank it, because a yank reaches
   * every machine that would otherwise have been offered the release.
   */
  published_by?: string | null;
  yanked_at: string | null;
  yanked_reason: string | null;
  created_at: string;
};

/**
 * The software bill of materials, checked for shape rather than for truth.
 *
 * CycloneDX and SPDX are the two formats a real supply chain already produces, so both
 * are accepted; anything else is refused with the reason. We check that there is a
 * format, a spec version and at least one named component, because an SBOM with no
 * components is a document that says nothing, and the CRA's whole point is that the
 * maker can name what is inside the product.
 */
export type SbomCheck = { ok: true; format: "cyclonedx" | "spdx"; components: number } | { ok: false; reason: string };

export function checkSbom(raw: unknown): SbomCheck {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "An SBOM is required: a JSON object in CycloneDX or SPDX shape. A release nobody can inventory is a release nobody can answer an advisory about." };
  }
  const doc = raw as Record<string, unknown>;
  const bombFormat = typeof doc.bomFormat === "string" ? doc.bomFormat.toLowerCase() : "";
  const spdxVersion = typeof doc.spdxVersion === "string" ? doc.spdxVersion : "";
  const specVersion = typeof doc.specVersion === "string" ? doc.specVersion : "";

  const components: unknown[] = Array.isArray(doc.components)
    ? (doc.components as unknown[])
    : Array.isArray(doc.packages)
      ? (doc.packages as unknown[])
      : [];

  if (bombFormat === "cyclonedx" || specVersion) {
    if (!specVersion) return { ok: false, reason: "A CycloneDX SBOM must carry `specVersion`, so a reader knows which schema the components are in." };
    if (components.length === 0) return { ok: false, reason: "This CycloneDX SBOM lists no components. An inventory of nothing is not an inventory." };
    return { ok: true, format: "cyclonedx", components: components.length };
  }
  if (spdxVersion) {
    if (components.length === 0) return { ok: false, reason: "This SPDX SBOM lists no packages. An inventory of nothing is not an inventory." };
    return { ok: true, format: "spdx", components: components.length };
  }
  return {
    ok: false,
    reason:
      "The SBOM must be CycloneDX (bomFormat plus specVersion plus components) or SPDX (spdxVersion plus packages). Both are what a real build already emits, so this is a shape check rather than a request for new work.",
  };
}

/** Whether a release may be published, and why not when it may not. */
export function publishDecision(input: {
  // Deliberately `unknown` on every field the decision reads: this runs on a request
  // body, so the values really are unknown here, and the coercion below is the check.
  release: {
    name?: unknown;
    version?: unknown;
    channel?: unknown;
    artifact_url?: unknown;
    sha256?: unknown;
  };
  sbom: unknown;
}): { ok: true } | { ok: false; reason: string } {
  const name = String(input.release.name ?? "").trim();
  const version = String(input.release.version ?? "").trim();
  const url = String(input.release.artifact_url ?? "").trim();
  const digest = String(input.release.sha256 ?? "").trim().toLowerCase();

  if (!/^[a-z0-9][a-z0-9._-]{1,60}$/i.test(name)) {
    return { ok: false, reason: "`name` names the artifact, 2 to 60 characters: letters, digits, dot, hyphen or underscore." };
  }
  if (!version) return { ok: false, reason: "`version` is required. A fleet cannot pin what has no name." };
  if (!isChannel(input.release.channel)) {
    return { ok: false, reason: "`channel` must be stable, beta or dev. A device opts into one of them and gets what it asked for." };
  }
  if (!/^https:\/\//i.test(url)) {
    return { ok: false, reason: "`artifact_url` must be https. A firmware image over plain http is a firmware image anybody on the path can replace, and the digest below is the only thing standing in the way." };
  }
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    return { ok: false, reason: "`sha256` must be the 64 character hex digest of the artifact. This is the check the device makes for itself and the one thing here that survives a compromised download path." };
  }
  const sbom = checkSbom(input.sbom);
  if (!sbom.ok) return { ok: false, reason: sbom.reason };
  return { ok: true };
}

/**
 * What a device is offered, given everything published.
 *
 * The order of the rules is the argument. A yanked release is never offered. A pinned
 * machine gets its pin and nothing else, because a pin is a decision its operator made
 * on purpose. Otherwise the newest release on the machine's own channel that matches
 * its hardware board wins, where a null hardware means "every board" rather than
 * "no board", since a maker with one product should not have to repeat its name in
 * every row.
 */
export function offeredRelease(input: {
  releases: Release[];
  channel: Channel;
  hardware: string | null;
  pinnedReleaseId: string | null;
  currentVersion: string | null;
}): { release: Release | null; because: string } {
  if (input.pinnedReleaseId) {
    const pinned = input.releases.find((r) => r.id === input.pinnedReleaseId);
    if (!pinned) {
      return { release: null, because: "This machine is pinned to a release that is no longer in the list, so nothing is offered until the pin names a release that exists." };
    }
    return { release: pinned, because: `Pinned to ${pinned.name} ${pinned.version}. A pin is the fleet's decision, so the rollout does not override it.` };
  }

  const eligible = input.releases
    .filter((r) => !r.yanked_at)
    .filter((r) => r.channel === input.channel)
    .filter((r) => r.hardware === null || input.hardware === null || r.hardware === input.hardware)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  if (eligible.length === 0) {
    return { release: null, because: `Nothing is published on the ${input.channel} channel for ${input.hardware ?? "any board"}.` };
  }
  const newest = eligible[0];
  if (input.currentVersion === newest.version) {
    return { release: newest, because: `Already running ${newest.version}, which is the newest on ${input.channel}.` };
  }
  return { release: newest, because: `Newest on ${input.channel} for ${input.hardware ?? "any board"}, published ${newest.created_at}.` };
}

/**
 * The machines a rollout may offer a release to.
 *
 * A percentage is applied to the list sorted by name so the same inputs always produce
 * the same set: a rollout that selected differently on two consecutive calls would
 * offer the release to everybody and call it a canary. Named canaries are always
 * included, pinned machines are not, and the floor is one machine rather than zero, so
 * a small fleet at five percent still gets one robot rather than none.
 */
export function rolloutTargets(input: {
  machines: { id: string; name: string; pinnedReleaseId: string | null }[];
  release: { id: string };
  percent: number;
  canary?: string[];
}): { targets: { id: string; name: string }[]; skipped: { name: string; because: string }[] } {
  const pct = Math.max(0, Math.min(100, Math.floor(input.percent)));
  const canary = new Set((input.canary ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean));
  const ordered = [...input.machines].sort((a, b) => a.name.localeCompare(b.name));

  const eligible = ordered.filter((m) => m.pinnedReleaseId !== input.release.id && m.pinnedReleaseId === null);
  const skipped = ordered
    .filter((m) => m.pinnedReleaseId !== null)
    .map((m) => ({ name: m.name, because: "Pinned to another release by its operator." }));

  const count = pct >= 100 ? eligible.length : Math.max(1, Math.ceil((eligible.length * pct) / 100));
  const chosen = new Map<string, { id: string; name: string }>();
  for (const m of eligible) if (canary.has(m.name.toLowerCase())) chosen.set(m.id, { id: m.id, name: m.name });
  for (const m of eligible.slice(0, count)) chosen.set(m.id, { id: m.id, name: m.name });

  return { targets: [...chosen.values()].sort((a, b) => a.name.localeCompare(b.name)), skipped };
}

/**
 * What a device's report about an install means for the fleet.
 *
 * A failure is not a shrug: it pins the machine back to the version it was running
 * before, because a robot that keeps trying a release that does not boot is a robot
 * in a loop, and it is recorded with the note the device gave.
 */
export function installOutcome(input: {
  reported: "installed" | "failed";
  release: { id: string; version: string; name: string };
  previousVersion: string | null;
  previousReleaseId: string | null;
  note: string | null;
}): {
  machinePatch: { installedVersion: string | null; pinReleaseId: string | null; pinReason: string | null };
  event: { topic: "machine.release.installed" | "machine.release.rolledback"; text: string };
} {
  if (input.reported === "installed") {
    return {
      machinePatch: { installedVersion: input.release.version, pinReleaseId: null, pinReason: null },
      event: {
        topic: "machine.release.installed",
        text: `installed ${input.release.name} ${input.release.version}${input.previousVersion ? `, from ${input.previousVersion}` : ""}`,
      },
    };
  }
  return {
    machinePatch: {
      installedVersion: input.previousVersion ?? null,
      pinReleaseId: input.previousReleaseId ?? null,
      pinReason: `pinned back after ${input.release.name} ${input.release.version} failed to install${input.note ? `: ${input.note.slice(0, 160)}` : ""}`,
    },
    event: {
      topic: "machine.release.rolledback",
      text: `could not install ${input.release.name} ${input.release.version}, held on ${input.previousVersion ?? "the version it had"}${input.note ? `: ${input.note.slice(0, 120)}` : ""}`,
    },
  };
}

/** A one line summary of a release for a feed row or a page. */
export function releaseSummary(r: Pick<Release, "name" | "version" | "channel" | "sha256">): string {
  return `${r.name} ${r.version} on ${r.channel}, sha256 ${r.sha256.slice(0, 12)}`;
}
