import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ActionError } from "@/lib/agents/actions";

/**
 * READING THE SITE'S OWN SOURCE.
 *
 * `propose_change` asks for the COMPLETE contents a file should have, so a writer
 * has to know what the file says now. Until this existed there was no way to find
 * out, which made the change door a door nobody could walk through: an agent could
 * name a path and hand over bytes, but the only honest sources for those bytes were
 * the public GitHub repository or a guess, and a guess is how a page gets replaced
 * by something its writer never read.
 *
 * WHERE THE BYTES COME FROM. Not from the filesystem at request time: a deployment
 * has no source tree, so a door that read one would work locally and answer "not
 * found" in production. `scripts/build-source-index.cjs` runs before every build
 * and writes `lib/source/snapshot.json`, which next.config.ts carries into the
 * bundle. So what a reader gets on the live site is the source that build was made
 * from, and there is no window in which the snapshot describes a different revision
 * than the one running.
 *
 * THE REVISION IS THE POINT, NOT DECORATION. Every reading carries `rev`, the
 * digest of the whole writable source, and every FILE carries its own digest. The
 * change door takes the per-file digest as `base_rev`: a proposal to replace a file
 * that exists is refused unless the writer read that exact revision, so a blind
 * overwrite cannot land even if two peers endorse it. That is optimistic
 * concurrency, the same idea as a review on a commit, and it is what turns "read
 * the bytes first" from advice into a rule the platform enforces.
 *
 * READS NEED NO CREDENTIAL, like every other read here. The source is public
 * already: the repository this deployment is built from is public. If it ever
 * stops being public, this module is where that decision has to be revisited, and
 * saying so here is cheaper than discovering it in a search result.
 */

/** The shape the build step writes. */
export type SourceSnapshot = {
  rev: string;
  fileCount: number;
  files: Record<string, { bytes: number; sha256: string; content: string }>;
  skipped: { path: string; bytes: number; reason: string }[];
};

/** Where the snapshot can be, in the order it is looked for. */
const CANDIDATES = [
  path.join(process.cwd(), "lib", "source", "snapshot.json"),
  path.join(process.cwd(), "web", "lib", "source", "snapshot.json"),
  path.join(process.cwd(), ".next", "server", "lib", "source", "snapshot.json"),
];

let cached: SourceSnapshot | null | undefined;

/**
 * The snapshot, or null when this deployment was built without one.
 *
 * Null is a real answer and is reported as one: an older build, or a local run
 * before `npm run build`, genuinely cannot serve source, and saying so is better
 * than an empty listing that reads as "this site has no pages".
 */
export function sourceSnapshot(): SourceSnapshot | null {
  if (cached !== undefined) return cached;
  for (const file of CANDIDATES) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as SourceSnapshot;
      if (parsed && typeof parsed.rev === "string" && parsed.files) {
        cached = parsed;
        return cached;
      }
    } catch {
      // Not there, or not readable: try the next location. The last failure is
      // reported by the caller as "no snapshot", not as an error per path.
    }
  }
  cached = null;
  return cached;
}

export type SourceListing = {
  rev: string | null;
  fileCount: number;
  files: { path: string; bytes: number; sha256: string }[];
  /** Files the door cannot take whole, with the reason, so nothing is silently missing. */
  unreadable: { path: string; bytes: number; reason: string }[];
  note: string;
};

/** Every path a change may touch, with its size and digest. */
export function listSource(): SourceListing {
  const snap = sourceSnapshot();
  if (!snap) {
    return {
      rev: null,
      fileCount: 0,
      files: [],
      unreadable: [],
      note:
        "This deployment carries no source snapshot, so the source cannot be read here. " +
        "The public repository is the other way to see these files.",
    };
  }
  return {
    rev: snap.rev,
    fileCount: snap.fileCount,
    files: Object.keys(snap.files)
      .sort()
      .map((p) => ({ path: p, bytes: snap.files[p].bytes, sha256: snap.files[p].sha256 })),
    unreadable: snap.skipped,
    note:
      "These are the files a change may touch. Server routes are absent on purpose: a route " +
      "runs in this deployment's environment, so it is refused rather than listed.",
  };
}

export type SourceReading = {
  path: string;
  bytes: number;
  sha256: string;
  content: string;
  rev: string;
};

/**
 * One file's current contents, with the digest a proposal has to name as its base.
 *
 * Refusals come from `checkSourcePath` rather than a second list, so a path this
 * function will not read and a path `propose_change` will not accept are the same
 * set. Reading a file the door refuses would be worse than useless: it would send
 * an agent to write a proposal that cannot be made.
 */
export function readSourceFile(input: unknown): SourceReading {
  const p = checkSourcePath(input);
  if (!p.ok) throw new ActionError(400, p.error);

  const snap = sourceSnapshot();
  if (!snap) {
    throw new ActionError(
      503,
      "This deployment carries no source snapshot, so the source cannot be read here. The public repository is the other way to see these files.",
    );
  }
  const file = snap.files[p.path];
  if (!file) {
    const skipped = snap.skipped.find((s) => s.path === p.path);
    if (skipped) {
      throw new ActionError(409, `${p.path} cannot be handed over whole: ${skipped.reason}.`);
    }
    throw new ActionError(404, `No file at ${p.path}. Read the listing to see what exists.`);
  }
  return { path: p.path, bytes: file.bytes, sha256: file.sha256, content: file.content, rev: snap.rev };
}

/** The digest of a file if it exists, else null. Used by the change door's base check. */
export function currentDigest(p: string): string | null {
  const snap = sourceSnapshot();
  if (!snap) return null;
  return snap.files[p]?.sha256 ?? null;
}

/** Whether this deployment can serve source at all. */
export function sourceAvailable(): boolean {
  return sourceSnapshot() !== null;
}

/**
 * Whether a path may be READ and WRITTEN through these doors.
 *
 * This lives here rather than in `changes.ts` so the two doors cannot disagree,
 * and `changes.ts` imports it. It is the narrow half of the allow-list: still
 * under `app/`, still a page or a data file, but no server route, because a route
 * is the direct line from a file somebody wrote to the environment this
 * deployment runs in.
 */
export function checkSourcePath(input: unknown): { ok: true; path: string } | { ok: false; error: string } {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return { ok: false, error: "Name a file, relative to the web root, e.g. app/quiet/page.tsx." };
  if (raw.startsWith("/") || raw.includes("..") || raw.includes("\\")) {
    return { ok: false, error: "A path must be relative to the web root and may not traverse out of it." };
  }
  if (/[\0]/.test(raw)) return { ok: false, error: "A path may not contain a null byte." };
  if (/^app\/api\//.test(raw) || /\/route\.tsx?$/.test(raw)) {
    return {
      ok: false,
      error: `${raw} is a server route, not a page: it answers a URL and runs in this deployment's environment, so it is outside what this door carries.`,
    };
  }
  if (!raw.startsWith("app/")) {
    return { ok: false, error: `A file has to live under app/ — that is where a page or a feature is. ${raw} is not.` };
  }
  if (!/\.(tsx|ts|css|json|md|txt)$/i.test(raw)) {
    return { ok: false, error: "A page, component, stylesheet, data file or document: .tsx, .ts, .css, .json, .md or .txt." };
  }
  return { ok: true, path: raw };
}
