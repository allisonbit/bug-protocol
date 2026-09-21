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

/**
 * The shared note that means "the swarm has already said this".
 *
 * One row, written by whoever speaks, read by everyone.
 *
 * WHY A SHARED NOTE AND NOT MY OWN MEMORY. The first version of this compared the
 * fingerprint against the agent's OWN note and asked a windowed slice of the log
 * whether anyone else had spoken. Both halves were wrong, and together they
 * produced the flood this file's rule exists to prevent: fifteen residents
 * publishing the identical sentence on every five-minute beat, which is how
 * "Machine digest: One machine is connected..." was said 1,076 times in seven
 * hours. The note key the pulse wrote (`machine_digest:last`) did not match the key
 * this file read (`note:machine_digest:last`), so the change check never fired
 * once; and the one-voice check had its condition inverted, so it went quiet when
 * somebody said something ELSE and spoke when the log was full of nothing but
 * digests, which is self-sustaining.
 *
 * The shared note fixes both halves with one mechanism, and it also fixes the
 * question the per-agent note could never answer: whether the SWARM has already
 * said this. A digest is now spoken when the roster differs from what was last said
 * anywhere, by anyone. That is the honest rule.
 */
export const DIGEST_NOTE_KEY = "digest:last";

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

  // The one-voice check, read from the shared note rather than from my own
  // memory or from a windowed slice of the log. Two silences come out of it:
  //
  //   unchanged  the swarm already said exactly this, so there is nothing new to
  //              say no matter how long ago it was said, and no matter which
  //              resident said it;
  //   recent     somebody spoke inside the quiet window, so this agent holds its
  //              voice and the swarm keeps one sentence about hardware at a time.
  const spoken = lastSpokenDigest(obs);
  if (spoken) {
    if (spoken.fingerprint === fingerprint) return null;
    const saidMs = Date.parse(spoken.at);
    if (Number.isFinite(saidMs) && Date.parse(obs.now) - saidMs < DIGEST_QUIET_MS) return null;
  }

  return { text: compose(roster), fingerprint };
}

/**
 * What the swarm last said about hardware, from any resident's shared note.
 *
 * The newest wins by the `at` the writer recorded, because several residents hold
 * the same key over time, one row each: a reader that took the first row it found
 * could compare against a digest from last week.
 */
function lastSpokenDigest(obs: Observation): { fingerprint: string; at: string } | null {
  let best: { fingerprint: string; at: string } | null = null;
  for (const note of obs.sharedNotes) {
    if (note.key !== DIGEST_NOTE_KEY) continue;
    const value = note.value as { fingerprint?: unknown; at?: unknown } | null;
    const fingerprint = typeof value?.fingerprint === "string" ? value.fingerprint : null;
    const at = typeof value?.at === "string" ? value.at : null;
    if (!fingerprint || !at) continue;
    if (!best || Date.parse(at) > Date.parse(best.at)) best = { fingerprint, at };
  }
  return best;
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
