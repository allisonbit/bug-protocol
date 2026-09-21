#!/usr/bin/env node
/**
 * Does any two MCP tools share a name?
 *
 * WHY THIS DESERVES A CHECK. MCP identifies a tool by its name, so a duplicate is
 * not a cosmetic collision: a client keying by name silently shadows one of the
 * two, and the loser keeps working in the source, keeps answering its own route,
 * and is simply unreachable from every client that connects. That is exactly what
 * happened here. `read_skills` was declared twice — once for what agents DECLARE
 * about themselves, once for the skills they WROTE for each other — and the live
 * `tools/list` returned both. The loser was the residents' own skill marketplace,
 * which is the door the swarm most needs open, and nothing failed: no build error,
 * no 500, no log line. The only symptom was a tool nobody could call.
 *
 * WHY IT READS SEVERAL FILES NOW. This check used to read one file, and it read it
 * correctly. Then the toolset outgrew a single module and the capability surfaces
 * (delegation, hardware, the world, the record) arrived as `tools-capabilities.ts`,
 * spread into `TOOLS`. That took eight descriptors out from under this check while
 * it went on reporting a pass — 80 names against 80 handlers, nothing wrong — so a
 * completeness claim was silently covering less than it said. The registry is
 * therefore DISCOVERED rather than typed: every `lib/mcp/tools*.ts` is a registry
 * module, and a third one added later is covered on the commit that adds it.
 *
 * WHAT THIS CHECKS, AND WHAT IT DELIBERATELY DOES NOT. It reads the registry's own
 * source. That is enough to catch the failure mode above, because a descriptor
 * carries its name in the file. It cannot catch a name assembled from variables,
 * and it does not try: if a name ever stops being a literal, the count check below
 * fails first and loudly, rather than the check quietly covering less than it
 * claims. `verify-runtimes.cjs` asserts uniqueness on the LIVE surface as well, so
 * anything this static pass cannot see is still caught at the handshake.
 *
 * No network, no database, no server:
 *
 *   node scripts/verify-tool-names.cjs
 *
 * An optional path argument points it at a single file instead of the discovered
 * set, which is how the check was tested against a copy of the source with the
 * duplicate put back:
 *
 *   node scripts/verify-tool-names.cjs ./some/other/tools.ts
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const REGISTRY_DIR = path.join(ROOT, "lib", "mcp");

const SOURCES = process.argv[2]
  ? [path.resolve(process.argv[2])]
  : fs
      .readdirSync(REGISTRY_DIR)
      .filter((f) => /^tools.*\.ts$/.test(f))
      .sort()
      .map((f) => path.join(REGISTRY_DIR, f));

let failed = 0;
const say = (ok, label, detail) => {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};

/**
 * Descriptor names, taken at exactly four spaces of indentation, which is where a
 * top-level descriptor writes its own `name`. Property names inside an
 * `inputSchema` are objects (`name: { ... }`) rather than string literals and sit
 * deeper, so they cannot be mistaken for a tool name.
 */
function toolNames(source) {
  return [...source.matchAll(/^ {4}name: "([a-z0-9_]+)",$/gm)].map((m) => m[1]);
}

/** Every descriptor has a handler; counting them is how a skipped name is caught. */
function handlerCount(source) {
  return [...source.matchAll(/^ {4}handler:/gm)].length;
}

/**
 * The verdict, kept separate from the reading so it can be tested on a list that
 * is known to contain the bug. A detector nobody can run against a known-bad input
 * is a detector that can rot into always-passing without anybody noticing.
 */
function duplicates(names) {
  const seen = new Map();
  for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1);
  return [...seen.entries()].filter(([, count]) => count > 1).map(([name, count]) => `${name} x${count}`);
}

console.log(`\nreading ${SOURCES.map((s) => path.relative(ROOT, s)).join(", ")}`);
console.log("== the registry as it stands ==");

const names = [];
let handlersTotal = 0;
let everyDescriptorNamed = true;
for (const file of SOURCES) {
  const source = fs.readFileSync(file, "utf8");
  const found = toolNames(source);
  const handlers = handlerCount(source);
  names.push(...found);
  handlersTotal += handlers;
  const ok = found.length > 0 && found.length === handlers;
  if (!ok) everyDescriptorNamed = false;
  console.log(
    `  ${ok ? "ok  " : "FAIL"} ${path.relative(ROOT, file)}  ${found.length} name(s), ${handlers} handler(s)`,
  );
}

say(
  names.length > 0,
  "descriptors were found",
  `${names.length} names in ${SOURCES.length} file(s), ${handlersTotal} handlers`,
);
// 1) The reading is complete: one name per descriptor, in every registry file, and
//    no more.
say(
  everyDescriptorNamed,
  "every descriptor contributed a name",
  everyDescriptorNamed
    ? `(${names.length} across ${SOURCES.length} file(s))`
    : "a name is no longer a plain literal in one of these files, so this check is covering less than it claims",
);

// 2) No two tools share a name, across the whole registry rather than within one
//    module. This is the whole point of the file.
const dupes = duplicates(names);
say(dupes.length === 0, "no two tools share a name", dupes.length ? dupes.join(", ") : `(${names.length} unique)`);

// 3) The specific collision that shipped, asserted in both directions, so a future
//    rename cannot be reverted by accident and read as a pass.
say(
  names.includes("read_written_skills"),
  "the residents' skill reading door is reachable as read_written_skills",
);
say(
  names.filter((n) => n === "read_skills").length === 1,
  "read_skills means one thing only: what an agent declares about itself",
  `found ${names.filter((n) => n === "read_skills").length}`,
);

// 4) The detector itself, against an input that is known to be broken.
console.log("== the detector, against the bug it exists for ==");
const historical = ["publish_skill", "read_skills", "read_written_skills", "read_skills"];
const caught = duplicates(historical);
say(
  caught.length === 1 && caught[0] === "read_skills x2",
  "two tools named read_skills are detected",
  caught.join(", ") || "NOT DETECTED",
);
say(duplicates([...new Set(historical)]).length === 0, "and a unique list is not reported as broken");

console.log(failed === 0 ? "\ntool names: all checks passed" : `\ntool names: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
