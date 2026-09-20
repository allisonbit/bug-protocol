#!/usr/bin/env node
/**
 * Does anything in the brain layer write without ever finding out whether the write
 * happened?
 *
 * WHY THIS EXISTS AT ALL. The measured defect of 2026-09-20 was not a wrong value, it
 * was a MISSING ONE. `pulse.ts` inserted a cabal roster, `cabal_members` refused the
 * whole insert with `23505` because the payload named the same agent twice, and the
 * result was discarded one line after a neighbouring insert checked its own error.
 * Both cabals this swarm has ever formed therefore stood with zero members, every
 * reader filters `left_at is null` and drew a team with nobody in it, and their own
 * purpose lines announced five agents. Nothing was broken in a way any status code or
 * page could show: a refusal nobody reads is indistinguishable from a write that
 * happened.
 *
 * So this file is a rule about shape rather than a rule about behaviour, and it is the
 * only kind of check that catches that class: every write under `lib/swamp/` — the
 * layer that decides what the swarm does — must read its own result.
 *
 * WHAT IT PINS.
 *
 *   1. `lib/swamp/**`: ZERO unchecked writes. Not a baseline, not an allowance. The
 *      brain, the pulse, the hand that commits changes, the shared memory and the
 *      skill publisher all report a refusal through `lib/swamp/refusal.ts`.
 *   2. `app/**`: a frozen count. Those routes predate this rule and carry real
 *      pipeline behaviour, so they are a recorded backlog rather than a rewrite: the
 *      number may not grow, and when it shrinks the baseline is meant to be lowered
 *      deliberately. A backlog that can grow silently is the defect, not the backlog.
 *
 * A statement counts as checked when it destructures `error` out of the awaited call
 * (the codebase's own idiom, `const { error } = await ...`) or chains a `.catch(...)`.
 * `.then(ok, err)` deliberately does NOT count: three writes in `land.ts` used it to
 * swallow both outcomes, and one of them was the note that records a refusal.
 *
 * COMMENTS ARE STRIPPED FIRST, because this file's own prose is full of examples.
 * Without that, the first run reported its own documentation as a violation.
 *
 *   node scripts/verify-write-results.cjs
 *
 * Fully offline. Exit code is 1 if anything is unchecked where it must not be.
 */
const fs = require("node:fs");
const path = require("node:path");

let failed = 0;
const say = (ok, label, detail) => {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};

const ROOT = process.cwd();

/**
 * The app/ backlog, measured when this check was written. It may only go down.
 *
 * These are the orchestrator tick, the Moltbook bridges, the registration route and a
 * handful of REST updates. Fixing them is a separate pass with its own risk: several
 * are status transitions whose refusal changes what the pipeline does next, which is a
 * behaviour change and not a logging one. What is not acceptable is the number rising.
 */
const APP_BASELINE = 19;

const WRITE = /\.(insert|upsert|update|delete)\s*\(/;

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\/\/[^\n]*$/gm, " ");
}

function filesUnder(dir) {
  const out = [];
  if (!fs.existsSync(path.join(ROOT, dir))) return out;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (["node_modules", ".next", ".freebuild", ".freebuff"].includes(e.name)) continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(e.name)) {
        out.push(p);
      }
    }
  })(path.join(ROOT, dir));
  return out;
}

/** Every awaited write whose failure nobody reads. */
function uncheckedWrites(files) {
  const found = [];
  for (const file of files) {
    const src = stripComments(fs.readFileSync(file, "utf8"));
    // Statements, not lines: these chains wrap across five or six lines and a line by
    // line scan would report the middle of every single one.
    for (const stmt of src.replace(/\s+/g, " ").split(";")) {
      if (!stmt.includes("await")) continue;
      if (!WRITE.test(stmt) || !/\.from\s*\(/.test(stmt)) continue;
      const checked =
        /(const|let|var)\s*\{[^}]*\berror\b[^}]*\}\s*=\s*await/.test(stmt) || /\.catch\s*\(/.test(stmt);
      if (!checked) found.push({ file: path.relative(ROOT, file), stmt: stmt.trim().slice(0, 120) });
    }
  }
  return found;
}

// ---- 1) the brain layer: zero tolerance -------------------------------------

const swamp = uncheckedWrites(filesUnder("lib/swamp"));
say(
  swamp.length === 0,
  "no write under lib/swamp is made without reading its own result",
  swamp.length === 0 ? "" : `${swamp.length} unchecked`,
);
for (const w of swamp) console.log(`       ${w.file} :: ${w.stmt}`);

// ---- 2) the shared helper exists, and is what they use ----------------------

const helper = path.join(ROOT, "lib/swamp/refusal.ts");
say(fs.existsSync(helper), "the refusal helper exists to be reported through");
if (fs.existsSync(helper)) {
  const users = ["pulse.ts", "land.ts", "memory.ts", "listings.ts", "skills.ts", "changes.ts"].filter(
    (f) => {
      const p = path.join(ROOT, "lib/swamp", f);
      return fs.existsSync(p) && /from "\.\/refusal"/.test(fs.readFileSync(p, "utf8"));
    },
  );
  say(
    users.length === 6,
    "every module that writes a row reports through it",
    `${users.length}/6: ${users.join(", ")}`,
  );
}

// ---- 3) the recorded backlog on the routes ---------------------------------

const app = uncheckedWrites(filesUnder("app"));
say(
  app.length <= APP_BASELINE,
  "the app/ backlog has not grown",
  `${app.length} unchecked, baseline ${APP_BASELINE}`,
);
for (const w of app) console.log(`       ${w.file} :: ${w.stmt}`);
if (app.length < APP_BASELINE) {
  console.log(
    `note the backlog shrank from ${APP_BASELINE} to ${app.length}: lower APP_BASELINE in this file so it cannot creep back up.`,
  );
}

// ---- 4) the topic this defect's own news needs -------------------------------

const types = fs.readFileSync(path.join(ROOT, "lib/agents/types.ts"), "utf8");
say(
  types.includes('"cabal.roster_failed"'),
  "a group with no roster has a topic of its own to be news on",
);
say(
  fs.readFileSync(path.join(ROOT, "lib/swamp/pulse.ts"), "utf8").includes("roster_note"),
  "a refused roster is written down on the cabal itself, not only logged",
);

console.log(`\nwrite-results: ${failed === 0 ? "all checks passed" : `${failed} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
