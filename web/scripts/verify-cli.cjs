#!/usr/bin/env node
/**
 * THE CLI AND DISTRIBUTION VERIFIER.
 *
 * Four things can rot independently here, and each is checked:
 *
 *   1. The package, which is the artifact npm would publish. If `files` misses a module the
 *      published CLI crashes on the first command, and nothing would notice, because running it
 *      from the checkout does not use that list.
 *   2. The generated single file. `packages/swampai/src` is the source and
 *      web/public/downloads/swamp.mjs is what a stranger downloads, so this REBUILDS the file in
 *      memory and compares byte for byte. Editing the source without rebuilding fails here, and
 *      so does editing the download by hand.
 *   3. The install page's claims. `lib/distribution.ts` tells a reader which commands exist,
 *      and this fails when that list and the CLI's help disagree in either direction.
 *   4. The channels themselves, live. Every channel marked `live` names a URL this script
 *      fetches, the release tarball is installed into a throwaway prefix and asked its version,
 *      and the Homebrew formula is compared against the asset it points at. A channel that
 *      stops working turns the suite red instead of quietly becoming a broken command on a page.
 *
 * Pass a deployment to check against; it defaults to a local one.
 *
 *   node scripts/verify-cli.cjs https://www.swampai.world
 */
const { execFileSync, execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

const repo = path.resolve(__dirname, "..", "..");
const pkgDir = path.join(repo, "packages", "swampai");
const publicBundle = path.join(repo, "web", "public", "downloads", "swamp.mjs");
const base = (process.argv[2] || "http://localhost:3000").replace(/\/+$/, "");

let checks = 0;
let failures = 0;

function check(what, pass, detail = "") {
  checks += 1;
  if (pass) {
    process.stdout.write(`  ok   ${what}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL ${what}${detail ? ": " + detail : ""}\n`);
}

function run(args, opts = {}) {
  return execFileSync(process.execPath, args, {
    cwd: opts.cwd || pkgDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runAllowFail(args, opts = {}) {
  try {
    return { code: 0, out: run(args, opts) };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout || ""}${err.stderr || ""}` };
  }
}

/**
 * Run a command line through a shell.
 *
 * Two things need this and neither is a detail. npm is a shell script on POSIX and a .cmd on
 * Windows, so it cannot be spawned the way node itself is. And the command npm installs is
 * also a shim with a platform of its own. A first version of this file ran `node install` and
 * then tried to execute a .cmd with node, which is four failing checks that described the
 * verifier rather than the channels.
 */
function shellAllowFail(command, opts = {}) {
  try {
    return { code: 0, out: execSync(command, { cwd: opts.cwd || repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout || ""}${err.stderr || ""}` };
  }
}

function quoted(p) {
  return `"${p}"`;
}

async function head(url) {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow" });
    return { status: res.status, length: Number(res.headers.get("content-length") || 0) };
  } catch (err) {
    return { status: 0, length: 0, error: err && err.message ? err.message : String(err) };
  }
}

async function main() {
  // ---- 1. the package ---------------------------------------------------------
  process.stdout.write("the package\n");
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  check("the name is the published name", pkg.name === "swampai", pkg.name);
  check("it has a version", /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version);
  check("the bin is named swamp", pkg.bin && typeof pkg.bin.swamp === "string" && pkg.bin.swamp.endsWith(".mjs"), JSON.stringify(pkg.bin));
  check("the bin file exists", fs.existsSync(path.join(pkgDir, pkg.bin.swamp)));
  check("there are no runtime dependencies", !pkg.dependencies || Object.keys(pkg.dependencies).length === 0);
  check("the published files include every module", ["bin", "src", "README.md"].every((f) => (pkg.files || []).includes(f)), JSON.stringify(pkg.files));
  check("it is public, so npx can resolve it", pkg.publishConfig && pkg.publishConfig.access === "public");

  const shipped = new Set(
    ["bin", "src"].flatMap((dir) => fs.readdirSync(path.join(pkgDir, dir)).map((f) => `${dir}/${f}`)),
  );
  const imports = new Set();
  for (const rel of shipped) {
    if (!rel.endsWith(".mjs")) continue;
    for (const m of fs.readFileSync(path.join(pkgDir, rel), "utf8").matchAll(/from\s+"(\.\/[^"]+|\.\.\/[^"]+)"/g)) {
      imports.add(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
    }
  }
  check("every relative import ships", [...imports].every((rel) => shipped.has(rel)), [...imports].filter((r) => !shipped.has(r)).join(", "));

  // ---- 2. the generated single file -------------------------------------------
  process.stdout.write("the single file\n");
  check("the download exists in the repository", fs.existsSync(publicBundle));
  const onDisk = fs.existsSync(publicBundle) ? fs.readFileSync(publicBundle, "utf8") : "";

  // The rebuild is the real check: source and artifact cannot drift without failing here. The
  // generated copy in packages/swampai/dist is a build product for local use and is ignored by
  // git, so there is nothing to compare it against that this does not already cover.
  const built = await import(`file://${path.join(pkgDir, "build.mjs").replace(/\\/g, "/")}`);
  const fresh = built.bundle();
  check(
    "the committed file is what the current source produces",
    fresh.file === onDisk,
    fresh.file.length === onDisk.length ? "same length, different bytes" : `${fresh.file.length} bytes from source, ${onDisk.length} on disk`,
  );

  const claimed = built.claimedHash(onDisk);
  const actual = built.bodyHash(onDisk);
  check("the banner carries a hash", !!claimed, String(claimed));
  check("the hash matches the body it describes", !!actual && claimed === actual, `banner ${claimed} vs body ${actual}`);
  check("the banner tells the reader which line to skip", onDisk.includes(`tail -n +${fresh.skipLine} `), `expected skip line ${fresh.skipLine}`);

  // The file's own answer has to match the arithmetic, or the self-check is theatre.
  const selfHash = runAllowFail([publicBundle, "--self-sha256"], { cwd: repo });
  check("the file's own --self-sha256 agrees", selfHash.out.trim() === actual, `${selfHash.out.trim()} vs ${actual}`);
  const bundledVersion = runAllowFail([publicBundle, "--version"], { cwd: repo });
  check("the single file runs and reports the package version", bundledVersion.out.trim() === pkg.version, bundledVersion.out.trim());

  // ---- 3. the CLI, offline, and the page's claims ------------------------------
  process.stdout.write("the cli, offline\n");
  const selfcheck = runAllowFail(["src/selfcheck.mjs"]);
  check("the offline self-check passes", selfcheck.code === 0, selfcheck.out.trim().split("\n").slice(-1)[0]);
  const help = runAllowFail(["bin/swamp.mjs", "--help"]);
  check("--help exits 0", help.code === 0, `exit ${help.code}`);
  const version = runAllowFail(["bin/swamp.mjs", "--version"]);
  check("--version prints the package version", version.out.trim() === pkg.version, version.out.trim());
  const unknown = runAllowFail(["bin/swamp.mjs", "definitely-not-a-command"]);
  check("an unknown command is refused with exit 2", unknown.code === 2, `exit ${unknown.code}`);

  process.stdout.write("the install page\n");
  const distribution = fs.readFileSync(path.join(repo, "web", "lib", "distribution.ts"), "utf8");
  const surfaces = fs.readFileSync(path.join(repo, "web", "lib", "surfaces.json"), "utf8");
  const nav = fs.readFileSync(path.join(repo, "web", "lib", "nav.ts"), "utf8");
  const page = fs.readFileSync(path.join(repo, "web", "app", "install", "page.tsx"), "utf8");
  check("the install page renders the channels from the data module", /CHANNELS\.map/.test(page));
  check("the page shows the bundle hash it read from disk", /bundleFacts/.test(page) && /bundle\.actual/.test(page));
  check("the page is listed in surfaces.json", surfaces.includes('"/install"'));
  check("the machine-readable index is listed in surfaces.json", surfaces.includes('"/install.json"'));
  check("the page is in a menu, so it is reachable", nav.includes('"/install"'));

  const declaredName = (distribution.match(/export const NPM_PACKAGE = "([^"]+)"/) || [])[1];
  const declaredVersion = (distribution.match(/export const NPM_VERSION = "([^"]+)"/) || [])[1];
  check("the page's package name is the real one", declaredName === pkg.name, `${declaredName} vs ${pkg.name}`);
  check("the page's version is the real one", declaredVersion === pkg.version, `${declaredVersion} vs ${pkg.version}`);

  const declared = [...(distribution.match(/CLI_COMMANDS[\s\S]*?\n\];/) || [""])[0].matchAll(/name: "([^"]+)"/g)].map((m) => m[1]);
  const advertisedMissing = declared.filter((name) => !new RegExp(`^\\s{2}${name.split(" ")[0]}\\s`, "m").test(help.out));
  check("every advertised command exists in the CLI", advertisedMissing.length === 0, advertisedMissing.join(", "));
  const commands = [...help.out.matchAll(/^\s{2}([a-z]+)\s{2,}/gm)].map((m) => m[1]);
  const undocumented = commands.filter((c) => !declared.some((d) => d.split(" ")[0] === c));
  check("every CLI command is on the page", undocumented.length === 0, undocumented.join(", "));

  // ---- 4. the channels, live ---------------------------------------------------
  process.stdout.write("the live channels\n");
  const channelsSource = (distribution.match(/export const CHANNELS[\s\S]*?\n\];/) || [""])[0];
  // Neither the state count nor the live count is typed twice: both come from the data module,
  // so a channel added without being labelled fails here rather than shipping as a claim.
  const liveChannels = [...channelsSource.matchAll(/\bid: "([^"]+)",[\s\S]{0,120}?\bstate: "live"/g)].map((m) => m[1]);
  const waitingChannels = [...channelsSource.matchAll(/\bid: "([^"]+)",[\s\S]{0,120}?\bstate: "after-publish"/g)].map((m) => m[1]);
  const totalChannels = [...channelsSource.matchAll(/\bid: "([^"]+)",/g)].length;
  check("every channel carries a state the verifier understands", liveChannels.length + waitingChannels.length === totalChannels, `${liveChannels.length} live + ${waitingChannels.length} waiting of ${totalChannels}`);
  check("the page advertises some live channels", liveChannels.length >= 4, liveChannels.join(", "));
  check("every waiting channel says what is left", [...channelsSource.matchAll(/state: "after-publish"[\s\S]{0,400}?remaining: "/g)].length === waitingChannels.length, `${waitingChannels.join(", ")}`);

  const singleFileUrl = base + "/downloads/swamp.mjs";
  const served = await fetch(singleFileUrl).catch((err) => ({ status: 0, error: err.message }));
  check("the deployment serves the single file", served.status === 200, `${singleFileUrl} answered ${served.status}`);
  if (served.status === 200) {
    const servedText = await served.text();
    check("the served file is byte-identical to the repository copy", servedText === onDisk, "the deployment is serving different bytes");
    const servedHash = createHash("sha256").update(servedText.slice(servedText.indexOf("\n", servedText.indexOf("// ---- body begins:")) + 1), "utf8").digest("hex");
    check("the served file's hash matches what the page prints", servedHash === actual, `${servedHash} vs ${actual}`);
  }

  const assetUrl = (distribution.match(/export const RELEASE_ASSET_URL =\s*\n?\s*"([^"]+)"/) || [])[1];
  const asset = await head(assetUrl);
  check("the release asset answers", asset.status === 200 && asset.length > 0, `${assetUrl} answered ${asset.status}`);

  const formula = await fetch((distribution.match(/export const TAP_FORMULA_URL = "([^"]+)"/) || [])[1]).catch(() => ({ status: 0 }));
  check("the Homebrew formula is published in the tap", formula.status === 200, `answered ${formula.status}`);
  if (formula.status === 200) {
    const text = await formula.text();
    const local = fs.readFileSync(path.join(repo, "packaging", "homebrew", "swamp.rb"), "utf8");
    check("the tap copy and the repository copy agree", text === local, "they differ");
    const url = (text.match(/^\s*url "([^"]+)"/m) || [])[1];
    const sha = (text.match(/^\s*sha256 "([^"]+)"/m) || [])[1];
    check("the formula installs the release asset", url === assetUrl, `${url} vs ${assetUrl}`);
    const tarball = await fetch(url).then((r) => r.arrayBuffer()).catch(() => null);
    const tarballHash = tarball ? createHash("sha256").update(Buffer.from(tarball)).digest("hex") : null;
    check("the formula's sha256 is the hash of that tarball", tarballHash === sha, `${tarballHash} vs ${sha}`);
  }

  // The install path itself, run for real: a published artifact is not an install until a
  // package manager resolves it and the command answers.
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "swamp-install-"));
  try {
    const installed = shellAllowFail(`npm install -g --prefix ${quoted(prefix)} ${quoted(assetUrl)}`);
    check("npm installs the published tarball", installed.code === 0, installed.out.trim().split("\n").slice(-1)[0]);
    // npm writes a shell shim on POSIX and a .cmd on Windows, so the check looks for the one
    // that exists rather than assuming a platform.
    const shim = [path.join(prefix, "bin", "swamp"), path.join(prefix, "swamp.cmd"), path.join(prefix, "bin", "swamp.cmd")].find((p) => fs.existsSync(p));
    check("npm wrote the command into the prefix", !!shim, `nothing at ${prefix}/bin`);
    const installedVersion = shim ? shellAllowFail(`${quoted(shim)} --version`) : { out: "no shim" };
    check("the installed command reports the published version", installedVersion.out.trim() === pkg.version, `${installedVersion.out.trim()} from ${shim}`);
    const installedProve = shim ? shellAllowFail(`${quoted(shim)} prove --url ${base} --no-color`) : { code: 1, out: "no shim" };
    check("the installed command verifies a deployment", installedProve.code === 0 && /of \d+ verified/.test(installedProve.out), installedProve.out.trim().split("\n").slice(-1)[0]);
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true });
  }

  // ---- 5. the CLI against the deployment ---------------------------------------
  process.stdout.write(`the cli against ${base}\n`);
  const prove = runAllowFail(["bin/swamp.mjs", "prove", "--url", base, "--no-color"]);
  check("prove exits 0 and verified every document", prove.code === 0 && /of \d+ verified/.test(prove.out) && !/fail /.test(prove.out), prove.out.trim().split("\n").slice(-1)[0]);
  const doctor = runAllowFail(["bin/swamp.mjs", "doctor", "--url", base, "--no-color"]);
  check("doctor exits 0 with no failed check", doctor.code === 0 && /all checks passed/.test(doctor.out), doctor.out.trim().split("\n").slice(-1)[0]);
  const config = runAllowFail(["bin/swamp.mjs", "mcp", "--client", "cursor", "--url", base, "--json"]);
  let parsed = null;
  try {
    parsed = JSON.parse(config.out);
  } catch {
    parsed = null;
  }
  check("the generated config names the real endpoint", parsed && parsed.url === `${base}/api/mcp`, parsed ? parsed.url : "no url");
  const index = await fetch(`${base}/install.json`).catch(() => ({ status: 0 }));
  check("the machine-readable index answers", index.status === 200, `answered ${index.status}`);
  if (index.status === 200) {
    const body = await index.json();
    check("the index reports the same single-file hash", body.single_file?.sha256 === actual, `${body.single_file?.sha256} vs ${actual}`);
    check("the index says the file agrees with its banner", body.single_file?.state === "verified", String(body.single_file?.state));
    check("the index lists every channel the page does", body.channels?.length === totalChannels, `${body.channels?.length} in the index, ${totalChannels} on the page`);
  }

  process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  process.stdout.write(`the verifier could not run: ${err && err.message ? err.message : err}\n`);
  process.exitCode = 1;
});
