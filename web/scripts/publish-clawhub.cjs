#!/usr/bin/env node
/**
 * publish-clawhub.cjs
 *
 * Publishes Swamp's Agent Skill to ClawHub, OpenClaw's public skill registry,
 * where an agent browsing for skills finds it without anyone telling it Swamp
 * exists.
 *
 * WHAT THIS SCRIPT REFUSES TO DO. It does not keep its own copy of the skill.
 * It fetches the artifact from the deployed domain, verifies it against the
 * digest in the discovery index, writes it into a bundle directory, and only
 * then publishes. That ordering matters: if the repository copy and the served
 * copy ever diverged, a bundle built from the repository would put bytes into
 * ClawHub that the digest on swampai.world does not describe, and a client doing
 * the integrity check it is required to do would reject the published skill. One
 * source, checked at the moment of publishing, is the only arrangement where that
 * cannot happen silently.
 *
 * AUTH IS NOT OURS TO DO. ClawHub authenticates with GitHub OAuth, so this needs
 * a logged in CLI on the operator's machine. There is no token this script can
 * conjure, and it does not try: it checks for the CLI and for a session, and says
 * exactly what is missing rather than failing halfway through an upload.
 *
 *   node scripts/publish-clawhub.cjs                  # build the bundle and stop
 *   node scripts/publish-clawhub.cjs --publish        # build it, then upload
 *
 * The bundle it writes is a real directory, so it can also be published by hand
 * or committed if ClawHub ever wants it in the repository.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const site = (process.env.SWAMP_SITE_URL || "https://www.swampai.world").replace(/\/+$/, "");
const shouldPublish = process.argv.includes("--publish");

const outDir = path.join(__dirname, "..", "skills", "swamp");
const outFile = path.join(outDir, "SKILL.md");

async function main() {
  console.log(`fetching the published artifact from ${site}`);

  const indexRes = await fetch(`${site}/.well-known/agent-skills/index.json`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!indexRes.ok) throw new Error(`index returned HTTP ${indexRes.status}`);
  const index = await indexRes.json();
  const entry = index.skills?.[0];
  if (!entry) throw new Error("the discovery index names no skill");

  const artifactUrl = new URL(entry.url, site).toString();
  const artifactRes = await fetch(artifactUrl, { signal: AbortSignal.timeout(30000) });
  if (!artifactRes.ok) throw new Error(`artifact returned HTTP ${artifactRes.status}`);
  const body = await artifactRes.text();

  // The same check a client is required to perform before using the skill. If it
  // fails here, publishing would ship bytes nobody can verify, so it stops.
  const actual = "sha256:" + crypto.createHash("sha256").update(body, "utf8").digest("hex");
  if (actual !== entry.digest) {
    throw new Error(`digest mismatch: the index says ${entry.digest}, the bytes hash to ${actual}`);
  }
  console.log(`digest verified  ${actual}`);

  // ClawHub reads name and description from the frontmatter, so a bundle without
  // it is published with no name.
  if (!/^---\s*\nname:\s*\S+/.test(body)) {
    throw new Error("the artifact has no frontmatter name, so ClawHub could not index it");
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, body, "utf8");
  console.log(`wrote bundle    ${path.relative(process.cwd(), outFile)}`);

  if (!shouldPublish) {
    console.log("\nbundle only. To upload, log in first:\n");
    console.log("  clawhub login            # or: clawhub login --device, on a machine with no browser");
    console.log("  node scripts/publish-clawhub.cjs --publish\n");
    return;
  }

  // Is the CLI even here? A missing binary should not look like a failed upload.
  let cli = null;
  for (const candidate of ["clawhub", "clawhub.cmd"]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      cli = candidate;
      break;
    } catch {
      /* try the next */
    }
  }
  if (!cli) {
    console.error(
      "clawhub CLI not found on PATH. Install it, log in, then rerun with --publish.\n" +
        "The bundle above is complete and needs no rebuilding.",
    );
    process.exitCode = 1;
    return;
  }

  // Fail on an unauthenticated session before starting the upload, rather than
  // part way through it.
  try {
    execFileSync(cli, ["whoami"], { stdio: "inherit" });
  } catch {
    console.error("clawhub is installed but not logged in. Run: clawhub login");
    process.exitCode = 1;
    return;
  }

  console.log("\npublishing");
  execFileSync(cli, ["skill", "publish", outDir], { stdio: "inherit" });
  console.log(`\npublished. Check it at https://clawhub.ai/skills/${entry.name}`);
}

main().catch((e) => {
  console.error(`\n${e.message}`);
  process.exitCode = 1;
});
