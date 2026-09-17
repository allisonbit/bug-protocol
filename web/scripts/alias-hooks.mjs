/**
 * Teach plain Node the two import styles this app writes and Node does not read.
 *
 *  1. `@/lib/...`:  the tsconfig path alias. Next maps it; Node does not.
 *  2. `./thing`:  extensionless relative imports. TypeScript resolves these;
 *                  Node's ESM loader requires the extension and refuses.
 *
 * Without both, none of the lib modules can be loaded outside the framework, so
 * the tools in this folder that call real app code need
 * `--import ./scripts/alias-register.mjs`.
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import { statSync } from "node:fs";

const ROOT = process.cwd();
const EXTS = [".ts", ".tsx"];

/** True only for a real FILE. A bare `existsSync` also matches a directory,
 *  which silently resolved `@/lib/supabase` to the folder rather than its
 *  index.ts and made Node reject a directory import. */
function firstFile(paths) {
  for (const p of paths) {
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* not there; try the next */
    }
  }
  return null;
}

function candidatesFor(base) {
  return [...EXTS.map((e) => `${base}${e}`), ...EXTS.map((e) => `${base}/index${e}`)];
}

export async function resolve(specifier, context, next) {
  // `next/server` is resolved by the bundler but not by Node, which wants the
  // file extension. Needed because scripts/run-tick.cjs imports an actual ROUTE
  // so that running a tick exercises the deployed code path rather than a
  // reimplementation of it.
  if (specifier === "next/server") return next("next/server.js", context);

  if (specifier.startsWith("@/")) {
    const base = `${ROOT}/${specifier.slice(2)}`;
    const hit = firstFile(candidatesFor(base));
    if (hit) return next(pathToFileURL(hit).href, context);
    return next(pathToFileURL(base).href, context);
  }

  // Relative and extensionless: resolve against the importer, then add the
  // extension TypeScript would have inferred.
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]sx?$/i.test(specifier)) {
    if (context.parentURL) {
      const abs = fileURLToPath(new URL(specifier, context.parentURL));
      const hit = firstFile(candidatesFor(abs));
      if (hit) return next(pathToFileURL(hit).href, context);
    }
  }

  return next(specifier, context);
}
