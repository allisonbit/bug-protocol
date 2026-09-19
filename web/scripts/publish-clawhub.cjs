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
 * AUTH BELONGS TO THE OPERATOR. ClawHub authenticates by GitHub OAuth device
 * flow, or by a token the operator already holds. Either way this script does not
 * invent a credential: it signs in with a token only if one was handed to it, and
 * otherwise checks for an existing session and says exactly what is missing. It
 * fails before the upload rather than part way through one.
 *
 *   node scripts/publish-clawhub.cjs                    # build the bundle and stop
 *   node scripts/publish-clawhub.cjs --publish          # build it, then upload
 *   CLAWHUB_TOKEN=<token> node scripts/publish-clawhub.cjs --publish
 *
 * The CLI comes from PATH (or CLAWHUB_BIN), and the script says so plainly when it
 * is missing rather than trying to conjure one.
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

/**
 * A token can be handed in rather than signed in for. `clawhub login --token`
 * stores it, so an operator who has a token never has to open a browser, and a
 * headless run is possible. It is read from the environment rather than a flag
 * so it does not land in shell history or in a process list.
 */
const tokenArg = process.argv.find((a) => a.startsWith("--token="));
const token = (tokenArg ? tokenArg.slice("--token=".length) : process.env.CLAWHUB_TOKEN || "").trim();

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
    console.log("  node scripts/publish-clawhub.cjs --publish [--dry-run]\n");
    return;
  }

  // Resolve the CLI. A globally installed binary is used when it is there, and
  // `npx` is the fallback so that nothing has to be installed to publish: the
  // package is public, and a global install is a side effect on somebody else's
  // machine that this task does not need.
  // On Windows a Node script cannot exec `npx` or `clawhub` directly: those are
  // `.cmd` shims and only the shell resolves them. Naming the shim is the fix,
  // and getting it wrong here is not a harmless miss: the failure surfaces as
  // "not logged in" when the session is perfectly valid, which sends the
  // operator to re-authenticate against a problem that is not there.
  /**
   * The CLI is taken from PATH and nothing else, deliberately.
   *
   * An `npx` fallback was written first and removed, because on Windows `npx` and
   * `clawhub` are `.cmd` shims: a Node script cannot exec one, and handing it to a
   * shell means quoting every argument by hand, which splits the changelog below
   * into several arguments. The failure mode of getting that wrong is a script
   * that reports "not logged in" when the session is fine, which sends the
   * operator to re-authenticate against a problem that does not exist. One clear
   * instruction is worth more here than a clever fallback that lies when it
   * breaks: the CLI is one global install, and the operator does it once.
   */
  const win = process.platform === "win32";
  const cli = process.env.CLAWHUB_BIN || (win ? "clawhub.cmd" : "clawhub");
  try {
    execFileSync(cli, ["--cli-version"], { stdio: "ignore" });
  } catch {
    console.error(
      `Could not run the clawhub CLI (${cli}).\n` +
        "Install it once with `npm i -g clawhub`, or point CLAWHUB_BIN at the binary.\n" +
        "The bundle above is complete and needs no rebuilding.",
    );
    process.exitCode = 1;
    return;
  }
  const exec = (args, opts = {}) => execFileSync(cli, args, opts);
  const run = (args) => exec(args, { stdio: "inherit" });

  if (token) {
    // Stored, not passed through on every call, so the publish step is the same
    // command whether the operator signed in or handed in a token.
    console.log("storing the supplied token");
    run(["login", "--token", token, "--no-browser", "--label", "Swamp discovery publish"]);
  }

  // Fail before starting the upload rather than part way through it, and say
  // which of the two things went wrong: a session that is missing, or a CLI that
  // could not be run at all. They need different fixes.
  try {
    const who = exec(["whoami"], { encoding: "utf8" });
    console.log(`signed in as ${String(who).trim()}`);
  } catch (e) {
    const reason = (e.stderr || e.message || "").toString().trim().split("\n").pop();
    console.error(`Could not confirm a ClawHub session: ${reason}`);
    console.error("If you are not logged in: clawhub login, or set CLAWHUB_TOKEN=<token>");
    process.exitCode = 1;
    return;
  }

  // Every field is passed explicitly. Left to itself the CLI prompts for a
  // changelog and a version, and a prompt in a non-interactive run is a hang,
  // not a question.
  const repoCommit = (() => {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  })();

  const args = [
    "skill",
    "publish",
    outDir,
    "--slug",
    entry.name,
    "--name",
    "Swamp",
    "--version",
    "1.0.0",
    "--tags",
    "latest",
    "--changelog",
    "First publication. These are the bytes served at the discovery index's artifact URL, verified against its digest before upload.",
    "--source-repo",
    "https://github.com/allisonbit/bug-protocol",
    "--source-path",
    "web/lib/skill.ts",
  ];
  if (repoCommit) args.push("--source-commit", repoCommit);

  if (process.argv.includes("--dry-run")) {
    args.push("--dry-run");
    console.log("\ndry run");
  } else {
    console.log("\npublishing");
  }
  run(args);
  if (!process.argv.includes("--dry-run")) {
    console.log(`\npublished. Check it at https://clawhub.ai/skills/${entry.name}`);
  }
}

main().catch((e) => {
  console.error(`\n${e.message}`);
  process.exitCode = 1;
});
