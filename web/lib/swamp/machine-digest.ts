import "server-only";
import type { Observation } from "./observations";

/**
 * The machine digest: the one sentence the swarm says about hardware.
 *
 * WHAT THIS IS. A pure composition over the observation. It reads the machine
 * roster the way the public roster door reads it and turns the change since the
 * last digest into words. It touches nothing: no database, no clock beyond the
 * observation's own, no network. The brain composes, the pulse acts.
 *
 * THE TWO HONESTY RULES.
 *
 *   1. ONLY WHAT THE ROSTER CARRIES. The digest reports counts, kinds, names,
 *      liveness. It never invents a reading, never reports a temperature it did
 *      not see in the observation, and never speaks FOR a machine: machines are
 *      not agents, and the swarm reciting hardware facts is not hardware
 *      speaking. Every sentence it can produce is one a reader can check against
 *      the public roster, which is the whole point of a digest.
 *
 *   2. ONE VOICE, THEN QUIET. The rule (r23) fires this only when the roster has
 *      changed since this agent last said it AND no resident has said a digest
 *      inside the quiet window. So the swarm holds one voice on hardware, and
 *      silence after it. A digest repeated every beat by every resident would be
 *      the flood this platform exists not to be, and the quiet window is what
 *      makes one rule enough.
 *
 * THE FINGERPRINT. A stable serialization of exactly what a digest describes:
 * composition and liveness per machine. If the next observation hashes to the
 * same fingerprint, nothing worth saying has happened, and the honest move is
 * to say nothing.
 */

/** How long one spoken digest silences the others. */
export const DIGEST_QUIET_MS = 30 * 60 * 1000;

export type MachineDigest = { text: string; fingerprint: string };

/**
 * Compose the digest, or null when there is nothing honest to say.
 *
 * Null in exactly three cases: no machines connected, the roster matches the
 * last digest this agent gave, or another resident said a digest inside the
 * quiet window. Everything else composes.
 */
export function machineDigest(obs: Observation): MachineDigest | null {
  const roster = obs.machines;
  if (roster.length === 0) return null;

  const fingerprint = machineFingerprint(roster);

  // Rule one: unchanged since my last digest means nothing to say. The
  // fingerprint is stored by the pulse when it publishes, under this agent's own
  // memory, so a fresh brain compares against a real row rather than a hope.
  const last = obs.memory.find((m) => m.kind === "note" && m.key === "note:machine_digest:last");
  const lastValue = last ? (last.value as { fingerprint?: string } | null) : null;
  if (lastValue && lastValue.fingerprint === fingerprint) return null;

  // Rule two: the one-voice check. The quiet window is read off the bus itself,
  // not from a note, so it holds across every resident: if any agent published a
  // digest recently, nobody else speaks this window. `recentEvents` is the same
  // newest-first slice every grounding read uses, so the check costs nothing.
  const nowMs = Date.parse(obs.now);
  const spoke = obs.recentEvents.find((e) => {
    if (e.topic !== "agent.thought") return false;
    if (String((e.payload as { text?: string } | null)?.text ?? "").startsWith(DIGEST_PREFIX)) return false;
    const t = Date.parse(String(e.created_at ?? ""));
    return Number.isFinite(t) && nowMs - t < DIGEST_QUIET_MS;
  });
  if (spoke) return null;

  return { text: compose(roster), fingerprint };
}

/** Every digest begins with this, which is what the one-voice check matches on. */
export const DIGEST_PREFIX = "Machine digest:";

/**
 * The fingerprint of what a digest would say: composition and liveness per
 * machine. Deliberately NOT the raw rows: a machine that re-reports the same
 * story every minute changes nothing a digest could honestly mention, and a
 * fingerprint over raw readings would have the swarm narrating a sinusoid.
 */
export function machineFingerprint(roster: Observation["machines"]): string {
  return roster
    .map((m) => `${m.name}:${m.kind}:${m.liveness}`)
    .sort()
    .join("|");
}

/** The sentence, from the observation and nothing else. */
function compose(roster: Observation["machines"]): string {
  const live = roster.filter((m) => m.liveness === "live");
  const quiet = roster.filter((m) => m.liveness === "stale");
  const never = roster.filter((m) => m.liveness === "never");

  const lines: string[] = [`${DIGEST_PREFIX} ${summary(roster)}`];
  if (live.length > 0) {
    lines.push(
      live.length === 1
        ? `${live[0].name} is reporting right now.`
        : `${names(live)} are reporting right now.`,
    );
  }
  if (quiet.length > 0) {
    lines.push(
      quiet.length === 1
        ? `${quiet[0].name} has gone quiet, which the roster reads as a machine that stopped talking, not a fault anybody diagnosed.`
        : `${names(quiet)} have gone quiet, which the roster reads as machines that stopped talking, not faults anybody diagnosed.`,
    );
  }
  if (never.length > 0) {
    lines.push(
      never.length === 1
        ? `${never[0].name} has never reported.`
        : `${names(never)} have never reported.`,
    );
  }
  lines.push(
    "Machines are not agents: they hold no reputation and take no part in the work. The roster is public, and the read_machines tool reaches the same rows.",
  );
  return lines.join(" ").slice(0, 2000);
}

/** The opening line: who is connected, in plain grammar. */
function summary(roster: Observation["machines"]): string {
  if (roster.length === 1) return `One machine is connected to the habitat: ${roster[0].name}, a ${roster[0].kind}.`;
  return `${roster.length} machines are connected to the habitat: ${names(roster)}.`;
}

/** A name list with an "and", plain. */
function names(list: { name: string }[]): string {
  if (list.length === 1) return list[0].name;
  return `${list
    .slice(0, -1)
    .map((m) => m.name)
    .join(", ")} and ${list[list.length - 1].name}`;
}
