#!/usr/bin/env node
/**
 * Is the repository's AGENTS.md still true?
 *
 * WHY THIS FILE EXISTS. AGENTS.md is the file a coding agent reads and then ACTS on: it
 * runs the commands it finds there and trusts the paths it names. That makes it different
 * from a README, where a stale line is an annoyance, and closer to a script, where a stale
 * line is a failure. A file that tells an agent to run `npm run verifiers`, in a repository
 * that has no such script, wastes the agent's first two minutes and then teaches it to
 * distrust everything else it read.
 *
 * WHAT IT CHECKS. Four things, all mechanical:
 *
 *   1. Every `npm run <name>` it mentions is a script that exists, and the one line that
 *      says `cd cli && npm run build` names a script in the CLI's own package.json rather
 *      than one borrowed from the web app.
 *   2. Every repository path it names exists. The table of directories is the load-bearing
 *      part: it is how an agent decides where to look first.
 *   3. Every verifier it names by filename exists in scripts/.
 *   4. It carries no credential. A token pasted into an instruction file is a token that
 *      every agent that reads the file now holds.
 *
 * WHAT IT DOES NOT CHECK. Whether the advice is good. That is not mechanically answerable,
 * and pretending otherwise would be worse than leaving it out.
 *
 *   node scripts/verify-agents-md.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..", "..");
const FILE = path.join(REPO, "AGENTS.md");

let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
    failed += 1;
  }
};

if (!fs.existsSync(FILE)) {
  console.log("AGENTS.md does not exist at the repository root.\n");
  process.exit(1);
}

const text = fs.readFileSync(FILE, "utf8");
const scriptsOf = (p) => {
  try {
    return Object.keys(JSON.parse(fs.readFileSync(path.join(REPO, p), "utf8")).scripts ?? {});
  } catch {
    return [];
  }
};
const webScripts = scriptsOf("web/package.json");
const rootScripts = scriptsOf("package.json");
const cliScripts = scriptsOf("cli/package.json");
const allScripts = new Set([...webScripts, ...rootScripts, ...cliScripts]);

console.log("\nthe file itself\n");
check("AGENTS.md is at the repository root", true);
check("it is plain markdown, with headings", /^#{1,3} /m.test(text));
check("it opens with what the file is for", /Instructions for coding agents/i.test(text));
check("it is short enough that an agent reads all of it", text.length < 14000, `${text.length} chars`);
check("it says which document is NOT this one", /not the document at\s*`?\/agents\.md/i.test(text) || /not the document at/.test(text));

console.log("\nevery command it names exists\n");
const named = [...text.matchAll(/npm run ([a-z0-9:_-]+)/gi)].map((m) => m[1]);
check("it names at least one script", named.length > 0, String(named.length));
for (const n of [...new Set(named)]) {
  check(`  npm run ${n} exists somewhere in the tree`, allScripts.has(n), `known: ${[...allScripts].join(", ")}`);
}
check("the CLI line names a CLI script, not the web app's", /cd cli && npm run build/.test(text) && cliScripts.includes("build"));
check("the contracts line names the root test script", /cd \.\. && npm test/.test(text) && rootScripts.includes("test"));
check("the typecheck command matches the web app's script", /npm run typecheck/.test(text) && webScripts.includes("typecheck"));
check("the build command matches the web app's script", /npm run build/.test(text) && webScripts.includes("build"));

console.log("\nthe verifier command is spelled correctly\n");
const verifierLine = text.match(/node --experimental-strip-types[^\n]*\n?[^\n]*verify-<name>\.cjs/);
check("it gives the exact flags for running a verifier", verifierLine !== null);
check("it names the alias loader the verifiers need", /alias-register\.mjs/.test(text));
check("it says the conditions flag", /--conditions=react-server/.test(text));

console.log("\nevery path it names exists\n");
const paths = [...new Set([...text.matchAll(/`((?:web|cli|mcp|swamp|contracts|test|examples|scripts)\/[A-Za-z0-9._/[\]-]+)`/g)].map((m) => m[1]))];
check("it names real paths rather than none", paths.length >= 8, String(paths.length));
for (const p of paths) {
  check(`  ${p}`, fs.existsSync(path.join(REPO, p)));
}
for (const d of ["web", "web/app", "web/lib", "web/scripts", "web/supabase", "contracts", "test", "cli", "mcp", "examples"]) {
  check(`  ${d}/ exists`, fs.existsSync(path.join(REPO, d)));
}

console.log("\nthe verifiers it points at exist\n");
const verifiers = [...new Set([...text.matchAll(/verify-[a-z0-9-]+\.cjs/g)].map((m) => m[0]))];
check("it names the suite files it tells an agent to read", verifiers.length >= 3, String(verifiers.length));
for (const v of verifiers) {
  check(`  ${v}`, fs.existsSync(path.join(REPO, "web", "scripts", v)));
}

console.log("\nit carries no credential\n");
check("no machine token", !/swp_[0-9a-f]{16,}/i.test(text));
check("no password assigned in a command", !/(PGPASSWORD|SUPABASE_SERVICE_ROLE_KEY|SWAMP_BEAT_SECRET)=\S+/.test(text));
check("it says where credentials come from instead", /environment variables/i.test(text));

console.log(`\n${failed === 0 ? "AGENTS.md: all checks passed" : `AGENTS.md: ${failed} check(s) FAILED`}\n`);
process.exitCode = failed === 0 ? 0 : 1;
