#!/usr/bin/env node
/**
 * Remove the route types a dev server was killed while writing.
 *
 * WHY THIS EXISTS, AND IT IS NOT HYPOTHETICAL. `tsconfig.json` includes
 * `.next/dev/types/**\/*.ts`, because Next adds that entry so `next dev` can check
 * route handlers as you write them. Those files are written IN PLACE while the dev
 * server compiles, so a dev server that is killed mid-write leaves
 * `.next/dev/types/validator.ts` TRUNCATED: the file ends inside a block, with the
 * closing brace of a block whose opening brace was never written.
 *
 * The consequence is out of all proportion to the cause. `tsc --noEmit` fails with
 * TS1128 pointing at line 714 of a file nobody wrote, `next build` then refuses to
 * type check, and the deploy stops — with every symptom appearing in the project's
 * own source while the actual fault is a half-written file in a build directory.
 * Measured in this repository: a dev server killed during a bulk crawl left exactly
 * that, and the next build failed with `.next/dev/types/validator.ts(714,1):
 * error TS1128: Declaration or statement expected.` Removing the file fixed both the
 * typecheck and the build with no other change.
 *
 * WHY IT ONLY DELETES A BROKEN ONE. A healthy `.next/dev/types` belongs to a running
 * dev server, and deleting it out from under one is a needless risk. So this reads
 * the file and checks the only property that matters — whether its braces balance —
 * and removes the directory only when they do not. The file is machine-generated with
 * a rigid shape, so that is a reliable signal here; and if it ever misjudged, the
 * cost is a regenerable dev-only artefact rather than anything a person wrote.
 *
 * WHY NOT JUST DROP `.next/dev/types` FROM tsconfig. Next re-adds the entry, so the
 * fix would be undone the next time anybody ran the dev server. Removing the broken
 * output is the thing that actually holds.
 *
 * Runs from `prebuild`, so a wedged build heals itself instead of needing somebody to
 * know this story.
 */
const fs = require("fs");
const path = require("path");

const TYPES = path.join(__dirname, "..", ".next", "dev", "types");

/** Does every `{` in this file have a `}`? In a generated validator, that is health. */
function unbalanced(source) {
  let depth = 0;
  for (const ch of source) {
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    if (depth < 0) return true;
  }
  return depth !== 0;
}

if (!fs.existsSync(TYPES)) {
  console.log("clear-dev-types: nothing to check (no .next/dev/types)");
  process.exit(0);
}

const broken = [];
for (const name of fs.readdirSync(TYPES)) {
  const full = path.join(TYPES, name);
  if (!fs.statSync(full).isFile() || !name.endsWith(".ts")) continue;
  if (unbalanced(fs.readFileSync(full, "utf8"))) broken.push(name);
}

if (broken.length === 0) {
  console.log("clear-dev-types: the dev-generated route types are complete, leaving them alone");
  process.exit(0);
}

fs.rmSync(TYPES, { recursive: true, force: true });
console.log(
  `clear-dev-types: removed .next/dev/types — ${broken.join(", ")} was left incomplete, ` +
    `which fails the typecheck and the build. A dev server regenerates it on start; ` +
    `next build writes its own to .next/types.`,
);
