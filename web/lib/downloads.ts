import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * THE SINGLE FILE, READ FROM DISK AND CHECKED.
 *
 * The install page and /install.json both publish a hash for the downloadable file, and the
 * only way that number stays true is to read it from the file that is actually served. So this
 * does not restate a constant: it hashes the bytes, compares that against what the file's own
 * banner claims, and reports the comparison.
 *
 * A disagreement is not hidden and not thrown away. It is returned as a state, because the one
 * thing a downloader must be able to see is whether the artifact agrees with its own label,
 * and the page renders `mismatch` if it ever does.
 */
export type BundleFacts = {
  /** The path inside the deployment that serves this file. */
  path: string;
  /** Bytes on disk. */
  bytes: number;
  /** The hash the file's banner claims, from its own comment. */
  claimed: string | null;
  /** The hash of the bytes after the banner, recomputed here. */
  actual: string | null;
  /** Whether the claim and the bytes agree. */
  state: "verified" | "mismatch" | "missing";
  /** The line number a downloader would skip with `tail`. */
  skipLine: number | null;
  version: string | null;
};

const RELATIVE = path.join("public", "downloads", "swamp.mjs");
const MARKER = "// ---- body begins:";

export function bundleFacts(): BundleFacts {
  const file = path.join(process.cwd(), RELATIVE);
  if (!fs.existsSync(file)) {
    return { path: "/downloads/swamp.mjs", bytes: 0, claimed: null, actual: null, state: "missing", skipLine: null, version: null };
  }
  const text = fs.readFileSync(file, "utf8");
  const claimed = (text.match(/^ \* sha256\s+([0-9a-f]{64})$/m) || [])[1] ?? null;
  const version = (text.match(/^ \* version\s+(\S+)$/m) || [])[1] ?? null;
  const skipLine = (text.match(/tail -n \+(\d+) /) || [])[1];
  const markerAt = text.indexOf(MARKER);
  const actual =
    markerAt < 0 ? null : createHash("sha256").update(text.slice(text.indexOf("\n", markerAt) + 1), "utf8").digest("hex");
  return {
    path: "/downloads/swamp.mjs",
    bytes: Buffer.byteLength(text, "utf8"),
    claimed,
    actual,
    state: claimed && actual && claimed === actual ? "verified" : "mismatch",
    skipLine: skipLine ? Number(skipLine) : null,
    version,
  };
}
