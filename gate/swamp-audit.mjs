#!/usr/bin/env node
/**
 * THE AUDIT GATE.
 *
 * WHAT IT ASKS. Every instruction document in a catalog has a public verdict from an
 * engine this repository does not own, bound to the SHA-256 of the exact bytes in the
 * tree, and nothing has got worse than the committed baseline.
 *
 * WHY THAT IS NOT THE SAME QUESTION AS A DRIFT CHECK ON A LOCAL LOCKFILE. A local
 * lockfile answers "did this file change since we hashed it". It cannot answer "does an
 * independent engine still call this file clean", because the only opinion in it is the
 * one the repository wrote about itself. Here the bytes go to a second party, a digest
 * comes back, the findings are quoted with line numbers, the record is public, and
 * anyone can overturn it by rerunning the engine over the same bytes. The two checks sit
 * beside each other rather than replacing each other.
 *
 * THREE OUTCOMES, AND THE THIRD IS THE POINT.
 *
 *   clean             every document is within the baseline. Exit 0.
 *   findings          a document is new, or worse than the baseline. Exit 1, with the
 *                     public record for each finding so a reviewer can check the claim.
 *   could not check   the door did not answer, or answered about different bytes. Exit
 *                     2. It is never reported as a pass, because "we could not look" and
 *                     "we looked and it was fine" are different facts, and a gate that
 *                     conflates them is worse than no gate: it reports coverage it does
 *                     not have.
 *
 * INCREMENTAL BY DIGEST. A document whose SHA-256 is in the baseline and unchanged is not
 * sent anywhere. A no-op run over a large catalog makes no requests at all, and a service
 * outage can only ever block a document that actually changed.
 *
 * NO DEPENDENCIES, NO SECRETS, NO WRITE ACCESS WANTED. Plain node, the global fetch, and
 * a read-only token requirement: `permissions: contents: read`. The document text is sent
 * to the public audit door, which records it against its digest, so the gate's own
 * findings are public and challengeable. That is stated in the workflow and in
 * docs/skill-audit.md rather than left for a reviewer to discover.
 *
 *   node swamp-audit.mjs --check
 *   node swamp-audit.mjs --refresh
 *   node swamp-audit.mjs --check --fixture verdicts.json     (offline, for testing)
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";

const DEFAULT_DOOR = "https://www.swampai.world/api/audits";
const SEVERITIES = ["info", "low", "medium", "high", "critical"];

function parseArgs(argv) {
  const out = { mode: "check", policy: "swamp.policy.json", lock: "swampaudit.lock.json", door: DEFAULT_DOOR, report: "swampaudit-report.json", fixture: null, root: "." };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--refresh") out.mode = "refresh";
    else if (a === "--check") out.mode = "check";
    else if (a === "--policy") out.policy = argv[++i];
    else if (a === "--lock") out.lock = argv[++i];
    else if (a === "--door") out.door = argv[++i];
    else if (a === "--report") out.report = argv[++i];
    else if (a === "--fixture") out.fixture = argv[++i];
    else if (a === "--root") out.root = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("usage: node swamp-audit.mjs [--check|--refresh] [--policy f] [--lock f] [--door url] [--report f] [--fixture f] [--root dir]");
  process.exit(0);
}

/** A glob as a regular expression. `**` crosses directories, `*` does not. */
function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if ("\\^$+.()|{}[]".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

function walk(root) {
  const found = [];
  const skip = new Set(["node_modules", ".git", ".next", "dist", "build", "vendor", ".venv", "venv", "__pycache__"]);
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) found.push(relative(root, full).split(sep).join(posix.sep));
    }
  };
  visit(root);
  return found.sort();
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`could not parse ${path}: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
}

const policy = readJson(args.policy);
if (!policy) {
  console.error(`no policy at ${args.policy}. It decides which documents are in scope and what fails.`);
  process.exit(2);
}

// An include can carry the KIND to read the document as, because a catalog holds two
// shapes of instruction document and the frontmatter requirements of one do not apply to
// the other. Plain strings are read as skills, which is what every entry meant before the
// second shape existed.
const includes = (policy.include ?? ["**/SKILL.md"]).map((entry) =>
  typeof entry === "string"
    ? { glob: entry, re: globToRegExp(entry), kind: "skill" }
    : { glob: entry.glob, re: globToRegExp(entry.glob), kind: entry.kind ?? "skill" },
);
// An exclusion can carry its reason, and a reason is what turns `exclude` from a hole in
// the gate into a decision a reviewer can disagree with.
const excludes = (policy.exclude ?? []).map((e) =>
  typeof e === "string"
    ? { glob: e, re: globToRegExp(e), reason: null }
    : { glob: e.glob, re: globToRegExp(e.glob), reason: e.reason ?? null },
);
const failVerdicts = new Set(policy.failOn?.verdict ?? ["unsafe"]);
const failSeverities = new Set(policy.failOn?.severity ?? ["critical", "high"]);
const failOnUnreachable = policy.failOnUnreachable !== false;

const all = walk(args.root);
const inScope = all.flatMap((p) => {
  const hit = includes.find((i) => i.re.test(p));
  if (!hit || excludes.some((e) => e.re.test(p))) return [];
  return [{ path: p, kind: hit.kind }];
});
// Everything the policy deliberately stepped over, listed with the reason it did. A gate
// that reports only what it looked at hides the size of what it did not.
const excluded = all.flatMap((p) => {
  const hit = excludes.find((e) => e.re.test(p));
  return hit ? [{ path: p, glob: hit.glob, reason: hit.reason }] : [];
});

const lock = readJson(args.lock, { version: 1, documents: {} });
const baseline = lock.documents ?? {};

/** Severity rank, for comparing a finding against the carried configuration. */
const rank = (s) => SEVERITIES.indexOf(s);

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function auditThroughDoor(text, kind = "skill") {
  const res = await fetch(args.door, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, content: text }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, why: `${res.status} ${body?.error?.code ?? ""} ${body?.error?.message ?? ""}`.trim() };
  }
  const a = body?.audit;
  if (!a || typeof a.digest !== "string") return { ok: false, why: "the door answered without a record" };
  return {
    ok: true,
    verdict: a.verdict,
    counts: a.counts,
    digest: a.digest,
    engine: a.engine,
    id: a.id ?? null,
    url: a.id ? `${new URL(args.door).origin}/audits/${a.id}` : null,
    deduped: Boolean(body.deduped),
    findings: (a.findings ?? []).map((f) => ({ code: f.code, severity: f.severity, line: f.line, evidence: f.evidence })),
  };
}

/** Offline verdicts, used by the verifier. Same shape, no network. */
function auditThroughFixture(text, path, fixture) {
  const key = Object.keys(fixture).find((k) => k === path);
  const entry = key ? fixture[key] : null;
  if (!entry) return { ok: false, why: "the fixture has no verdict for this document" };
  if (entry.unreachable) return { ok: false, why: "the fixture says the door is unreachable" };
  // The digest is returned as the fixture states it, including a wrong one on purpose:
  // the check that a verdict is bound to the file's own bytes belongs to the gate, not to
  // the thing standing in for the door, or the branch would be tested by its own mock.
  const digest = entry.digest === "mirror" ? sha256(text) : entry.digest;
  return {
    ok: true,
    verdict: entry.verdict,
    counts: Object.fromEntries(SEVERITIES.map((s) => [s, (entry.findings ?? []).filter((f) => f.severity === s).length])),
    digest,
    engine: entry.engine ?? "fixture",
    id: entry.id ?? null,
    url: entry.url ?? null,
    deduped: false,
    findings: entry.findings ?? [],
  };
}

const fixture = args.fixture ? readJson(args.fixture, {}) : null;
if (args.fixture && !fixture) {
  console.error(`no fixture at ${args.fixture}`);
  process.exit(2);
}

/** What changed between a baseline entry and a fresh reading, in words. */
function compare(path, before, after) {
  const worse = [];
  if (!before) {
    if (failVerdicts.has(after.verdict)) worse.push(`a new document that reads ${after.verdict}`);
    for (const f of after.findings) {
      if (failSeverities.has(f.severity)) worse.push(`a new ${f.severity} finding, ${f.code}, line ${f.line ?? "-"}`);
    }
    return worse;
  }
  const beforeRank = rank(SEVERITIES.filter((s) => (before.counts ?? {})[s] > 0).pop() ?? "info");
  const afterRank = rank(SEVERITIES.filter((s) => (after.counts ?? {})[s] > 0).pop() ?? "info");
  if (afterRank > beforeRank) worse.push(`severity rose from ${SEVERITIES[beforeRank]} to ${SEVERITIES[afterRank]}`);
  if (failVerdicts.has(after.verdict) && !failVerdicts.has(before.verdict)) worse.push(`verdict moved to ${after.verdict}`);
  const known = new Set((before.findings ?? []).map((f) => `${f.code}`));
  for (const f of after.findings) {
    if (known.has(f.code)) continue;
    if (failSeverities.has(f.severity)) worse.push(`a new ${f.severity} finding, ${f.code}, line ${f.line ?? "-"}`);
  }
  return worse;
}

const result = {
  mode: args.mode,
  engine: null,
  documents: inScope.length,
  excluded: excluded.length,
  excludedPaths: excluded,
  clean: 0,
  unchanged: 0,
  reaudited: 0,
  failures: [],
  blocked: [],
  stale: [],
  refreshed: {},
  rows: [],
};

for (const { path, kind } of inScope) {
  const full = join(args.root, path);
  // LINE ENDINGS ARE NORMALISED BEFORE ANYTHING ELSE, AND THIS IS NOT COSMETIC.
  //
  // Git stores this file's bytes with LF line endings, and a checkout on Windows with
  // core.autocrlf rewrites them to CRLF in the working tree. Hashing what is on disk would
  // therefore produce a baseline that a Linux CI runner could never match, so every
  // document would look changed on every run, and a baseline is supposed to be a fact
  // about the repository rather than about the machine that generated it. The canonical
  // form is the one git stores, so it is the one hashed and submitted.
  const disk = readFileSync(full, "utf8");
  const text = disk.includes("\r") ? disk.replace(/\r\n/g, "\n") : disk;
  const sha = sha256(text);
  const before = baseline[path];

  if (args.mode === "check" && before && before.sha256 === sha) {
    result.unchanged += 1;
    result.rows.push({ path, kind, state: "unchanged", verdict: before.verdict, audit: before.audit ?? null });
    continue;
  }

  const reading = fixture ? auditThroughFixture(text, path, fixture) : await auditThroughDoor(text, kind);
  if (!reading.ok) {
    result.blocked.push({ path, why: reading.why });
    console.error(`::error file=${path}::could not check ${path}: ${reading.why}`);
    continue;
  }
  if (reading.digest !== sha) {
    result.blocked.push({ path, why: "the verdict was bound to different bytes than the file contains" });
    console.error(`::error file=${path}::the door returned digest ${reading.digest} for a file whose SHA-256 is ${sha}`);
    continue;
  }

  result.engine = reading.engine ?? result.engine;
  result.refreshed[path] = {
    kind,
    sha256: sha,
    bytes: Buffer.byteLength(text, "utf8"),
    verdict: reading.verdict,
    counts: reading.counts,
    audit: reading.url,
    findings: reading.findings.map((f) => ({ code: f.code, severity: f.severity, line: f.line })),
  };

  if (args.mode === "refresh") {
    result.rows.push({ path, kind, state: before ? "re-read" : "added", verdict: reading.verdict, audit: reading.url });
    continue;
  }

  result.reaudited += 1;
  const worse = compare(path, before, reading);
  if (worse.length === 0) {
    result.clean += 1;
    result.rows.push({ path, kind, state: before ? "re-audited, within baseline" : "new, within policy", verdict: reading.verdict, audit: reading.url });
  } else {
    result.failures.push({ path, verdict: reading.verdict, audit: reading.url, reasons: worse, findings: reading.findings, deduped: reading.deduped });
  }
  await new Promise((r) => setTimeout(r, fixture ? 0 : 150));
}

// A baseline entry whose file is gone is reported, not failed: deleting a skill is a
// legitimate change, and the refresh command is how the baseline catches up.
const inScopePaths = inScope.map((d) => d.path);
for (const path of Object.keys(baseline)) {
  if (!inScopePaths.includes(path)) result.stale.push(path);
}

// THE COVERAGE CHECK, AND WHY IT IS ABOUT THE RECORD RATHER THAN THE FILE.
//
// A document added to the catalog is not a coverage gap here: it has no baseline digest,
// so it is audited on this run, and the same failure rules apply to it as to anything
// else. The gap that is real is an entry that carries a VERDICT BUT NO PUBLIC RECORD,
// because then the gate is pointing at an opinion with no bytes attached and no challenge
// door behind it, which is the one thing this design exists to avoid. A hand-edited
// baseline is exactly how that happens, and a file with no digest cannot be compared at
// all, so it cannot be passed either.
if (args.mode === "check") {
  for (const [path, entry] of Object.entries(baseline)) {
    if (!inScopePaths.includes(path)) continue;
    const reasons = [];
    if (typeof entry?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      reasons.push("the baseline entry carries no usable SHA-256, so nothing can be compared to it");
    }
    if (entry?.verdict && entry.verdict !== "clean" && !entry.audit) {
      reasons.push(`the baseline says ${entry.verdict} with no public record to point at`);
    }
    if (reasons.length) result.failures.push({ path, verdict: entry?.verdict ?? null, audit: entry?.audit ?? null, reasons, findings: [] });
  }
}

const lockOut = {
  version: 1,
  engine: result.engine ?? lock.engine ?? null,
  door: args.door,
  generatedAt: new Date().toISOString(),
  note: "Verdicts from the public audit door, bound to the SHA-256 of the bytes in this repository. Refresh with: node swamp-audit.mjs --refresh",
  // A REFRESH IS A FULL RE-READ, SO IT WRITES EXACTLY WHAT IS IN SCOPE. Carrying the old
  // entries forward instead would leave a deleted skill's verdict in the file forever, and
  // a baseline that accumulates documents the repository no longer has is a file nobody can
  // trust the diff of. In check mode nothing is written at all.
  documents: args.mode === "refresh" ? result.refreshed : { ...baseline, ...result.refreshed },
};
if (args.mode === "refresh") {
  writeFileSync(args.lock, `${JSON.stringify(lockOut, null, 2)}\n`, "utf8");
}

writeFileSync(args.report, `${JSON.stringify(result, null, 2)}\n`, "utf8");

console.log(`swamp audit gate: ${result.documents} document(s) in scope, ${result.excluded} excluded by policy${args.fixture ? " (offline fixture)" : ""}`);
for (const e of result.excludedPaths) console.log(`  excluded: ${e.path}${e.reason ? ` (${e.reason})` : ` (${e.glob})`}`);
if (result.unchanged) console.log(`  ${result.unchanged} unchanged since the baseline, not sent anywhere`);
if (result.reaudited) console.log(`  ${result.reaudited} re-audited`);
if (args.mode === "refresh") console.log(`  baseline written to ${args.lock}`);

for (const f of result.failures) {
  console.error(`::error file=${f.path}::${f.path} fails the audit gate: ${f.reasons.join("; ")}`);
  for (const x of f.findings) {
    if (failSeverities.has(x.severity)) console.error(`    ${x.severity} ${x.code} line ${x.line ?? "-"}: ${String(x.evidence ?? "").slice(0, 160)}`);
  }
  if (f.audit) console.error(`    the public record, with the bytes attached, is ${f.audit}`);
}
for (const b of result.blocked) console.error(`::error file=${b.path}::${b.path} could not be checked: ${b.why}`);
for (const s of result.stale) console.log(`  note: ${s} is in the baseline but not in the tree; --refresh will drop it`);

if (result.blocked.length) {
  console.error("");
  console.error(`${result.blocked.length} document(s) could not be checked. This is not a pass.`);
  process.exit(failOnUnreachable ? 2 : 0);
}
if (result.failures.length) {
  console.error("");
  console.error(`${result.failures.length} document(s) fail the audit gate. The verdict, the quoted evidence and the exact bytes are on the public record, and any of them can be challenged there.`);
  process.exit(1);
}
console.log(result.mode === "refresh" ? "baseline refreshed" : "every document in scope is within the baseline");
process.exit(0);
