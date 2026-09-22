#!/usr/bin/env node
/**
 * THE SINGLE FILE BUILDER.
 *
 * Why this exists. npm needs an account, Homebrew needs a tap, a container needs a registry.
 * Every one of those is a channel somebody else has to open first. A single .mjs file needs
 * none of them: one curl writes the whole toolkit to disk on a box with nothing but Node, and
 * the artifact is small enough to read before running it.
 *
 * So this is a real bundler rather than a hand-maintained copy of six modules, because a copy
 * drifts within a week. It walks `src` transitively, inlines every relative import, hoists the
 * Node builtins, turns exports into a small module registry, and stamps the result with the
 * SHA-256 of its own body.
 *
 * THE BANNER AND THE BODY ARE BUILT SEPARATELY, and that is deliberate. The digest covers every
 * byte after the banner, so the banner cannot be inside the thing it describes: a first version
 * hashed the whole file and then edited the banner to print the number, which changes the bytes
 * and produces a hash that can never match. The claim and the bytes it is about are two
 * different pieces of text here.
 *
 * IT REFUSES TO EMIT ANYTHING IT CANNOT VOUCH FOR. A construct it does not understand stops
 * the build with the offending line, because a silent mis-bundle of a signature checker is the
 * one failure in this repository that would matter.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));

export const OUT_LOCAL = path.join(here, "dist", "swamp.mjs");
export const OUT_PUBLIC = path.resolve(here, "..", "..", "web", "public", "downloads", "swamp.mjs");

/** The last banner line. Everything after it is what the digest covers. */
export const BODY_MARKER = "// ---- body begins: the sha256 above covers every byte below this line ----";

const HASH_PLACEHOLDER = " * sha256   (printed by the build)";
const SKIP_PLACEHOLDER = " *   tail -n +<SKIP> swamp.mjs | shasum -a 256";

/**
 * Bundle the CLI into one string.
 *
 * Exported so the repository's verifier can rebuild in memory and compare against the
 * committed file, rather than trusting that somebody remembered to run the build.
 */
export function bundle() {
  const modules = new Map();
  const order = [];
  // Node builtins are hoisted to the top of the bundle, deduped by the local name each module
  // binds. Emitting them inside a module factory is a syntax error, and emitting them twice is
  // a duplicate declaration: this build made both mistakes once.
  const builtins = new Map();

  function noteBuiltin(spec, clause) {
    const use = builtins.get(spec) || { def: null, names: new Map() };
    if (/^\*\s+as\s+/.test(clause)) {
      use.names.set(clause.replace(/^\*\s+as\s+/, "").trim(), "*");
    } else if (/^\{/.test(clause)) {
      for (const raw of clause.slice(1, clause.lastIndexOf("}")).split(",")) {
        const parts = raw.trim().split(/\s+as\s+/);
        if (parts[0]) use.names.set(parts[1] || parts[0], parts[0]);
      }
    } else if (clause.trim()) {
      use.def = clause.trim();
    }
    builtins.set(spec, use);
  }

  function load(id, from) {
    if (modules.has(id)) return id;
    const abs = path.resolve(here, "src", path.posix.normalize(path.posix.join(from, id)));
    if (!fs.existsSync(abs)) throw new Error(`cannot resolve ${id} from ${from}`);
    const names = new Set();
    const reexported = new Set();
    const body = [];

    for (const line of fs.readFileSync(abs, "utf8").split("\n")) {
      const im = line.match(/^import\s+(.+?)\s+from\s+"([^"]+)"\s*;?\s*$/);
      if (im) {
        const [, clause, spec] = im;
        if (!spec.startsWith(".")) {
          noteBuiltin(spec, clause);
          continue;
        }
        const child = path.posix.normalize(path.posix.join(path.posix.dirname(id), spec));
        load(child, from);
        // Record what this import takes FROM THAT CHILD, which is what makes the dropped
        // re-export check below exact instead of a name coincidence across modules.
        if (/^\{/.test(clause)) {
          for (const raw of clause.slice(1, clause.lastIndexOf("}")).split(",")) {
            const taken = raw.trim().split(/\s+as\s+/)[0].trim();
            if (taken) modules.get(child).taken.add(taken);
          }
        } else if (!/^\*/.test(clause)) {
          modules.get(child).taken.add("default");
        }
        if (/^\*\s+as\s+/.test(clause)) {
          body.push(`const ${clause.replace(/\*\s+as\s+/, "")} = __require(${JSON.stringify(child)});`);
        } else if (/^\{/.test(clause)) {
          body.push(`const ${clause} = __require(${JSON.stringify(child)});`);
        } else {
          body.push(`const ${clause} = __require(${JSON.stringify(child)}).default;`);
        }
        continue;
      }

      const re = line.match(/^export\s*\{([^}]+)\}\s*;?\s*$/);
      if (re) {
        for (const name of re[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop())) reexported.add(name);
        body.push(`// a re-export, dropped by the bundler, and the build asserts nothing reaches it: {${re[1]}}`);
        continue;
      }

      const ex = line.match(/^export\s+(async\s+function|function|const|let|class)\s+([A-Za-z0-9_$]+)/);
      if (ex) {
        names.add(ex[2]);
        body.push(line.replace(/^export\s+/, ""));
        continue;
      }

      if (/^export\s/.test(line)) {
        throw new Error(`${id}: the bundler does not understand this export:\n  ${line}`);
      }
      body.push(line);
    }

    modules.set(id, { id, names, reexported, taken: new Set(), body: body.join("\n") });
    order.push(id);
    return id;
  }

  load("./index.mjs", ".");

  // A dropped re-export that another module takes FROM THIS ONE would be a silently broken
  // bundle, so the build fails rather than producing one.
  const orphaned = [];
  for (const m of modules.values()) {
    for (const name of m.reexported) if (m.taken.has(name)) orphaned.push(`${name} (from ${m.id})`);
  }
  if (orphaned.length) {
    throw new Error(`a re-export the bundler dropped is imported from the same module: ${orphaned.join(", ")}`);
  }

  // The self-check reads this file and hashes it, so its two builtins are registered here.
  noteBuiltin("node:fs", "fs");
  noteBuiltin("node:crypto", "{ createHash }");

  const banner = [
    "#!/usr/bin/env node",
    "/* ---- swamp, as one file ----",
    ` * version  ${pkg.version}`,
    ` * license  ${pkg.license}`,
    " * source   https://github.com/allisonbit/bug-protocol/tree/master/packages/swampai",
    " * docs     https://www.swampai.world/install",
    " *",
    " * The whole CLI, on the Node standard library, with no dependencies and no install step.",
    " * Generated from packages/swampai/src by packages/swampai/build.mjs. Do not edit this file:",
    " * edit the source and run the build, which the repository verifier also checks.",
    " *",
    " * CHECK THE BYTES BEFORE YOU RUN THEM. That number is the SHA-256 of every byte after the",
    " * marker line, in order, including the final newline:",
    " *",
    " *   curl -fsSL https://www.swampai.world/downloads/swamp.mjs -o swamp.mjs",
    " *   node swamp.mjs --self-sha256",
    SKIP_PLACEHOLDER,
    " *",
    HASH_PLACEHOLDER,
    " */",
  ];
  // The marker is a line of its own AFTER the comment closes, not a line inside it. Inside the
  // comment there is always one more banner line to come, and a first version hashed from the
  // marker to the end of the file, which quietly included that closing line and four bytes the
  // body never had. The build now recomputes the hash from the bytes it wrote and refuses to
  // ship a banner that does not match them.
  const prefixLines = [...banner, BODY_MARKER];
  if (banner.some((line) => line.includes(BODY_MARKER))) {
    throw new Error("the body marker is inside the comment block, so the bytes it covers are wrong");
  }
  const skipLine = prefixLines.length + 1;

  const bodyParts = [];
  bodyParts.push("const __modules = new Map();");
  bodyParts.push("const __cache = new Map();");
  bodyParts.push("function __define(id, factory) { __modules.set(id, factory); }");
  bodyParts.push("function __require(id) {");
  bodyParts.push("  if (__cache.has(id)) return __cache.get(id);");
  bodyParts.push('  if (!__modules.has(id)) throw new Error("missing module in the bundle: " + id);');
  bodyParts.push("  const made = __modules.get(id)(__require);");
  bodyParts.push("  __cache.set(id, made);");
  bodyParts.push("  return made;");
  bodyParts.push("}");
  bodyParts.push("");
  for (const [spec, use] of builtins) {
    const named = [...use.names].filter(([, from]) => from !== "*");
    const star = [...use.names].find(([, from]) => from === "*");
    const namedText = named.map(([local, from]) => (local === from ? from : `${from} as ${local}`)).join(", ");
    if (star) bodyParts.push(`import * as ${star[0]} from ${JSON.stringify(spec)};`);
    if (use.def && named.length) bodyParts.push(`import ${use.def}, { ${namedText} } from ${JSON.stringify(spec)};`);
    else if (use.def) bodyParts.push(`import ${use.def} from ${JSON.stringify(spec)};`);
    else if (named.length) bodyParts.push(`import { ${namedText} } from ${JSON.stringify(spec)};`);
  }
  bodyParts.push("");
  for (const id of order) {
    const m = modules.get(id);
    bodyParts.push(`__define(${JSON.stringify(id)}, (__require) => {`);
    bodyParts.push(m.body.replace(/\n+$/, ""));
    bodyParts.push(`  return { ${[...m.names].join(", ")} };`);
    bodyParts.push("});");
    bodyParts.push("");
  }
  bodyParts.push(`const __entry = __require("./index.mjs");`);
  bodyParts.push("");
  bodyParts.push("// A downloader can ask the file what it is. That is not proof on its own, and it is a");
  bodyParts.push("// second opinion against the number this site and the release notes publish.");
  bodyParts.push('if (process.argv[2] === "--self-sha256") {');
  bodyParts.push('  const self = fs.readFileSync(process.argv[1], "utf8");');
  bodyParts.push(`  const marker = ${JSON.stringify(BODY_MARKER)};`);
  bodyParts.push("  const idx = self.indexOf(marker);");
  bodyParts.push('  const rest = self.slice(self.indexOf("\\n", idx) + 1);');
  bodyParts.push('  process.stdout.write(createHash("sha256").update(rest, "utf8").digest("hex") + "\\n");');
  bodyParts.push("  process.exit(0);");
  bodyParts.push("}");
  bodyParts.push("");
  bodyParts.push("__entry.main(process.argv.slice(2))");
  bodyParts.push("  .then((code) => { process.exitCode = code; })");
  bodyParts.push("  .catch((err) => {");
  bodyParts.push('    console.error("swamp: unexpected failure (this is a CLI bug): " + (err && err.message ? err.message : String(err)));');
  bodyParts.push("    process.exitCode = 2;");
  bodyParts.push("  });");
  bodyParts.push("");

  const body = bodyParts.join("\n");
  const hash = createHash("sha256").update(body, "utf8").digest("hex");
  const bannerText = banner
    .join("\n")
    .replace(SKIP_PLACEHOLDER, ` *   tail -n +${skipLine} swamp.mjs | shasum -a 256`)
    .replace(HASH_PLACEHOLDER, ` * sha256   ${hash}`);
  if (bannerText.includes("<SKIP>") || bannerText.includes("printed by the build")) {
    throw new Error("the banner placeholders were not all filled, so the check it prints would be wrong");
  }
  const prefix = bannerText + "\n" + BODY_MARKER + "\n";

  return { file: prefix + body, bodyText: body, hash, modules: order.length, skipLine };
}

/** The hash a committed file claims, so a verifier can compare without trusting the source. */
export function claimedHash(file) {
  const m = file.match(/^ \* sha256\s+([0-9a-f]{64})$/m);
  return m ? m[1] : null;
}

/** Hash the bytes a downloader would hash with `tail`, skipping the banner. */
export function bodyHash(file) {
  const marker = file.indexOf(BODY_MARKER);
  if (marker < 0) return null;
  return createHash("sha256").update(file.slice(file.indexOf("\n", marker) + 1), "utf8").digest("hex");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const built = bundle();
  for (const out of [OUT_LOCAL, OUT_PUBLIC]) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, built.file, "utf8");
  }
  // Read the file back and hash what is actually on disk. The banner makes a claim about these
  // bytes, and a generator that does not check its own claim is how a wrong number ships.
  const onDisk = fs.readFileSync(OUT_LOCAL, "utf8");
  const actual = bodyHash(onDisk);
  if (actual !== built.hash) {
    const markerAt = onDisk.indexOf(BODY_MARKER);
    const slice = onDisk.slice(onDisk.indexOf("\n", markerAt) + 1);
    process.stderr.write(
      `the banner claims ${built.hash} but the body on disk hashes to ${actual}\n` +
        `  in memory: ${Buffer.byteLength(built.bodyText, "utf8")} bytes\n` +
        `  on disk:   ${Buffer.byteLength(slice, "utf8")} bytes\n`,
    );
    process.exitCode = 1;
    throw new Error("the build produced a file whose banner does not match its own bytes");
  }
  process.stdout.write(`bundled ${built.modules} modules, ${built.file.length} bytes\n`);
  process.stdout.write(`sha256 ${built.hash}\n`);
  process.stdout.write(`banner is ${built.skipLine - 1} lines, body starts at ${built.skipLine}\n`);
  process.stdout.write(`wrote ${path.relative(process.cwd(), OUT_LOCAL)}\n`);
  process.stdout.write(`wrote ${path.relative(process.cwd(), OUT_PUBLIC)}\n`);
}
