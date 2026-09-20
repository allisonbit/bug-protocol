#!/usr/bin/env node
/**
 * Write the snapshot of this site's own source that the read door serves.
 *
 * WHY THIS IS A BUILD STEP AND NOT A FILE READ. `propose_change` hands over the
 * COMPLETE contents a file should have, so an agent has to know what the file says
 * now. On a deployment there is no source tree to read: the build compiles `app/`
 * into functions and the `.tsx` files are not in the bundle at all. A door that
 * read the filesystem would work on a laptop and answer "not found" in production,
 * which is the worst version of this feature. So the snapshot is taken at BUILD
 * time, by this script, and carried into the deployment by `outputFileTracingIncludes`
 * in next.config.ts. It cannot drift, because a deploy that skips it produces no
 * new snapshot rather than a stale one.
 *
 * WHAT IS IN IT, AND WHY THAT IS THE WHOLE OF IT. Exactly the files a change may
 * touch, which is what `checkPath` in lib/swamp/changes.ts accepts: a page, a
 * component, a stylesheet, a data file. Two things are deliberately NOT here:
 *
 *   - Server routes. `app/api/x/route.ts` and `app/x/route.ts` are both reachable
 *     by URL and both run in the environment holding this deployment's credentials,
 *     so they are refused by the change door and absent from this snapshot. A route
 *     is not "what a visitor sees", and that distinction is the door's whole
 *     boundary rather than a nicety.
 *   - Anything the change door refuses. The snapshot and the allow-list are the
 *     same set by construction, because a listing that named a path the door would
 *     refuse would send an agent to write a proposal that cannot be made.
 *
 * A FILE TOO BIG TO REWRITE WHOLE IS LISTED, NOT TRUNCATED. `propose_change` caps
 * a single change at MAX_CHANGE_BYTES, so a larger file cannot be handed over in
 * full, and a truncated body would be a lie an agent could write back. Those paths
 * are reported with their size and the reason instead, so the honest answer to
 * "show me that file" is "it is too big for this door" rather than half of it.
 *
 *   node scripts/build-source-index.cjs
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "lib", "source", "snapshot.json");

/** Must match MAX_CHANGE_BYTES in lib/swamp/changes.ts. */
const MAX_CHANGE_BYTES = 120_000;

/** Must match the accepted extensions in lib/swamp/changes.ts. */
const ACCEPTED = /\.(tsx|ts|css|json|md|txt)$/i;

/** Must match the refusals in lib/swamp/changes.ts that apply under app/. */
const REFUSED_IN_APP = [/^app\/api\//, /\/route\.ts$/, /\/route\.tsx$/];

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const appDir = path.join(ROOT, "app");
const files = {};
const skipped = [];

for (const full of walk(appDir)) {
  const rel = path.relative(ROOT, full).split(path.sep).join("/");
  if (!rel.startsWith("app/")) continue;
  if (!ACCEPTED.test(rel)) continue;
  if (REFUSED_IN_APP.some((re) => re.test(rel))) continue;

  const body = fs.readFileSync(full, "utf8");
  const bytes = Buffer.byteLength(body, "utf8");
  if (body.includes("\0")) {
    skipped.push({ path: rel, bytes, reason: "binary" });
    continue;
  }
  if (bytes > MAX_CHANGE_BYTES) {
    skipped.push({
      path: rel,
      bytes,
      reason: `too big to hand over whole: a single change is capped at ${MAX_CHANGE_BYTES} bytes`,
    });
    continue;
  }
  files[rel] = { bytes, sha256: sha256(body), content: body };
}

/**
 * The revision every reading is stamped with.
 *
 * Taken over the sorted path and digest of every file, so it changes when any
 * byte of the writable source changes and cannot be forged by editing one file:
 * the point of the stamp is that a writer who read revision X is proposing against
 * X, and the door can refuse a proposal whose base is no longer the file.
 */
const rev = sha256(
  Object.keys(files)
    .sort()
    .map((p) => `${p}\t${files[p].sha256}`)
    .join("\n"),
);

const snapshot = {
  rev,
  fileCount: Object.keys(files).length,
  files,
  skipped: skipped.sort((a, b) => a.path.localeCompare(b.path)),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(snapshot), "utf8");

console.log(
  `source snapshot: ${snapshot.fileCount} file(s) from app/, rev ${rev.slice(0, 12)}, ` +
    `${skipped.length} listed as unreadable, ${(fs.statSync(OUT).size / 1024).toFixed(0)}KB -> lib/source/snapshot.json`,
);
