#!/usr/bin/env node
/**
 * THE CLI VERIFIER.
 *
 * Three things can rot independently here, and each one is checked:
 *
 *   1. The package, which is the artifact npm would publish. If `files` misses a module the
 *      published CLI crashes on the first command, and nothing in this repository would
 *      notice, because running it from the checkout does not use that list.
 *   2. The CLI's real behaviour, offline: its help text, its version, its refusal of a
 *      command it does not have, and its own self-check.
 *   3. The install page's claims. `lib/distribution.ts` tells a reader which commands exist,
 *      and this script fails when that list and the CLI's help disagree, in either direction.
 *      That is the same rule the nav and surface verifiers apply: a page may not advertise
 *      something the deployment does not do.
 *
 * The live half runs the CLI against a real deployment, because the point of the tool is
 * what it does to a running site. Pass one as the first argument:
 *
 *   node scripts/verify-cli.cjs https://www.swampai.world
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repo = path.resolve(__dirname, "..", "..");
const pkgDir = path.join(repo, "packages", "swampai");
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

// ---- 1. the package -----------------------------------------------------------

process.stdout.write("the package\n");
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
check("the name is the published name", pkg.name === "swampai", pkg.name);
check("it has a version", /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version);
check("the bin is named swamp", pkg.bin && typeof pkg.bin.swamp === "string" && pkg.bin.swamp.endsWith(".mjs"), JSON.stringify(pkg.bin));
check("the bin file exists", fs.existsSync(path.join(pkgDir, pkg.bin.swamp)));
check("there are no runtime dependencies", !pkg.dependencies || Object.keys(pkg.dependencies).length === 0);
check("the published files include every module", ["bin", "src", "README.md"].every((f) => (pkg.files || []).includes(f)), JSON.stringify(pkg.files));
check("it is public, so npx can resolve it", pkg.publishConfig && pkg.publishConfig.access === "public");
check("it states a Node floor", typeof pkg.engines?.node === "string", JSON.stringify(pkg.engines));

// Every module referenced from a module must ship, or the published CLI breaks on the first
// command while the checkout keeps working.
const shipped = new Set(
  ["bin", "src"].flatMap((dir) => fs.readdirSync(path.join(pkgDir, dir)).map((f) => `${dir}/${f}`)),
);
const imports = new Set();
for (const rel of shipped) {
  if (!rel.endsWith(".mjs")) continue;
  const text = fs.readFileSync(path.join(pkgDir, rel), "utf8");
  for (const m of text.matchAll(/from\s+"(\.\/[^"]+|\.\.\/[^"]+)"/g)) {
    imports.add(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
  }
}
const missing = [...imports].filter((rel) => !shipped.has(rel));
check("every relative import ships", missing.length === 0, missing.join(", "));

// ---- 2. the CLI, offline ------------------------------------------------------

process.stdout.write("the cli, offline\n");
const selfcheck = runAllowFail(["src/selfcheck.mjs"]);
check("the offline self-check passes", selfcheck.code === 0, selfcheck.out.trim().split("\n").slice(-1)[0]);
const selfSummary = selfcheck.out.match(/(\d+)\/(\d+) checks passed/);
check("the self-check actually ran checks", selfSummary && Number(selfSummary[2]) >= 20, selfSummary ? selfSummary[0] : "no summary");

const help = runAllowFail(["bin/swamp.mjs", "--help"]);
check("--help exits 0", help.code === 0, `exit ${help.code}`);
const version = runAllowFail(["bin/swamp.mjs", "--version"]);
check("--version prints the package version", version.out.trim() === pkg.version, version.out.trim());
const unknown = runAllowFail(["bin/swamp.mjs", "definitely-not-a-command"]);
check("an unknown command is refused with exit 2", unknown.code === 2, `exit ${unknown.code}`);
check("an unknown command says what to try", /unknown command/.test(unknown.out));

// ---- 3. the install page's claims ---------------------------------------------

process.stdout.write("the install page\n");
const distribution = fs.readFileSync(path.join(repo, "web", "lib", "distribution.ts"), "utf8");
const surfaces = fs.readFileSync(path.join(repo, "web", "lib", "surfaces.json"), "utf8");
const nav = fs.readFileSync(path.join(repo, "web", "lib", "nav.ts"), "utf8");
const pagePath = path.join(repo, "web", "app", "install", "page.tsx");

check("the install page exists", fs.existsSync(pagePath));
check("the install page renders the channels from the data module", /CHANNELS\.map/.test(fs.readFileSync(pagePath, "utf8")));
check("the page is listed in surfaces.json", surfaces.includes('"/install"'));
check("the page is in a menu, so it is reachable", nav.includes('"/install"'));

const declaredName = (distribution.match(/export const NPM_PACKAGE = "([^"]+)"/) || [])[1];
const declaredVersion = (distribution.match(/export const NPM_VERSION = "([^"]+)"/) || [])[1];
check("the page's package name is the real one", declaredName === pkg.name, `${declaredName} vs ${pkg.name}`);
check("the page's version is the real one", declaredVersion === pkg.version, `${declaredVersion} vs ${pkg.version}`);

// The commands the page advertises, and the commands the CLI has. The help text is the
// authority; the page may not name a command that is not in it.
const declared = [...(distribution.match(/CLI_COMMANDS[\s\S]*?\n\];/) || [""])[0].matchAll(/name: "([^"]+)"/g)].map((m) => m[1]);
check("the page advertises some commands", declared.length >= 8, String(declared.length));
const advertisedMissing = declared.filter((name) => {
  const top = name.split(" ")[0];
  return !new RegExp(`^\\s{2}${top}\\s`, "m").test(help.out);
});
check("every advertised command exists in the CLI", advertisedMissing.length === 0, advertisedMissing.join(", "));

const commands = [...help.out.matchAll(/^\s{2}([a-z]+)\s{2,}/gm)].map((m) => m[1]);
const undocumented = commands.filter((c) => !declared.some((d) => d.split(" ")[0] === c));
check("every CLI command is on the page", undocumented.length === 0, undocumented.join(", "));

// ---- 4. the live deployment ---------------------------------------------------

process.stdout.write(`the cli against ${base}\n`);
const prove = runAllowFail(["bin/swamp.mjs", "prove", "--url", base, "--no-color"]);
check(
  "prove exits 0 and verified every document",
  prove.code === 0 && /of \d+ verified/.test(prove.out) && !/fail /.test(prove.out),
  prove.code !== 0 ? `exit ${prove.code}: ${prove.out.trim().split("\n").slice(-1)[0]}` : prove.out.trim().split("\n").slice(-1)[0],
);
const verifiedCount = (prove.out.match(/(\d+) of (\d+) verified/) || [])[1];
check("more than one document was proven", Number(verifiedCount) >= 3, String(verifiedCount));

const doctor = runAllowFail(["bin/swamp.mjs", "doctor", "--url", base, "--no-color"]);
check("doctor exits 0 with no failed check", doctor.code === 0 && /all checks passed/.test(doctor.out), doctor.out.trim().split("\n").slice(-1)[0]);
check("doctor spoke to the MCP door", /mcp door\s+200\s+\d+ tools/.test(doctor.out));
check("doctor spoke to the A2A door", /a2a door\s+200/.test(doctor.out));

const config = runAllowFail(["bin/swamp.mjs", "mcp", "--client", "cursor", "--url", base, "--json"]);
let parsed = null;
try {
  parsed = JSON.parse(config.out);
} catch {
  parsed = null;
}
check("the generated config is valid JSON", parsed !== null);
check("the config names the real endpoint", parsed && parsed.url === `${base}/api/mcp`, parsed ? parsed.url : "no url");

// A body that does not verify must be refused, so the check is a check and not a formality.
// Pointing at a path that is served unsigned must come back non-zero.
const unsigned = runAllowFail(["bin/swamp.mjs", "prove", "--url", base, "--no-color", "/robots.txt"]);
check("an unsigned document is not counted as verified", unsigned.code !== 0 && !/^verified/m.test(unsigned.out), unsigned.out.trim().split("\n").slice(-1)[0]);

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
process.exitCode = failures ? 1 : 0;
