#!/usr/bin/env node
/**
 * Does the action manifest still describe what this deployment can do?
 *
 * WHY THIS FILE EXISTS. A manifest that joins two registries is the easiest kind of document
 * to let rot, because it is the only place where a tool name, a door path, a method and an
 * auth level appear together, and nothing else in the tree notices when one of them changes.
 * The failure mode is quiet and expensive: an agent reads `auth: "none"` for a door that now
 * requires a key, tries it, gets a 401, and concludes the host is dishonest. That is worse
 * than the manifest not existing.
 *
 * So every reference is resolved against the thing it claims to reference:
 *
 *   - an http projection must name a path AND a method that `lib/surfaces.json` registers;
 *   - a page projection must name a page that registry lists;
 *   - an mcp projection must name a tool that exists in the tool registry, read from the
 *     registry's own source the same way `verify-tool-names.cjs` reads it;
 *   - a json projection must name a serving path the surface registry knows about;
 *   - an evidence line that names a verifier must name a file that exists;
 *   - every tool appears exactly once across the manifest, because `read_skills` was once
 *     declared twice and the loser became uncallable from every client while still
 *     answering its own route;
 *   - a capability with a single projection must carry `only`, so "this is a person's act"
 *     is a sentence somebody wrote rather than a hole a reader falls into.
 *
 * WHAT IT CANNOT DO. It cannot know what the code behind a door actually checks. If a door
 * starts requiring a key while its entry in `surfaces.json` still says `none`, the manifest
 * is faithfully wrong and only a live probe catches it, which is `verify-surfaces.cjs`' job.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-actions.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const WEB = path.join(__dirname, "..");

let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
    failed += 1;
  }
};

/**
 * The tool registry, read from source. Importing it would drag in the database client.
 *
 * The extraction rule is the one `verify-tool-names.cjs` already established and documents:
 * a descriptor writes its own `name` at exactly four spaces of indentation on its own line.
 * A looser pattern was tried first and found 100 names where the registry has 83, because
 * property names and example strings inside an `inputSchema` also read as `name: "..."`. The
 * phantom entries would have been published in the manifest as capabilities that do not
 * exist, which is exactly the kind of authoritative-looking wrongness this file exists to
 * prevent. The handler count is checked against the name count so a descriptor written at a
 * different indentation fails here instead of quietly vanishing from the manifest.
 */
function toolNamesFromSource() {
  const files = fs
    .readdirSync(path.join(WEB, "lib", "mcp"))
    .filter((f) => /^tools.*\.ts$/.test(f))
    .sort()
    .map((f) => path.join(WEB, "lib", "mcp", f));
  const names = [];
  let handlers = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/^ {4}name: "([a-z0-9_]+)",$/gm)) names.push(m[1]);
    handlers += [...src.matchAll(/^ {4}handler:/gm)].length;
  }
  return { names: [...new Set(names)].sort(), duplicates: names.length - new Set(names).size, handlers, files: files.map((f) => path.basename(f)) };
}

(async () => {
  const { buildActionsManifest, ACTIONS, DOOR_NOTES } = await import("../lib/actions/manifest.ts");
  const surfaces = JSON.parse(fs.readFileSync(path.join(WEB, "lib", "surfaces.json"), "utf8"));
  const { names: toolNames, files: toolFiles, handlers } = toolNamesFromSource();

  const manifest = buildActionsManifest({ toolNames });
  const endpoints = surfaces.endpoints;
  const pages = new Set(surfaces.pages.map((p) => p.path));
  const doorKey = (p, m) => `${m} ${p}`;
  const doorSet = new Set();
  for (const e of endpoints) for (const m of String(e.method ?? "GET").split(",").map((x) => x.trim())) doorSet.add(doorKey(e.path, m));
  const doorPaths = new Set(endpoints.map((e) => e.path));
  const toolSet = new Set(toolNames);

  console.log(`\n== the registries it joins ==`);
  check("the tool registry was read and is not empty", toolNames.length > 40, `${toolNames.length} tools from ${toolFiles.join(", ")}`);
  check("every descriptor was found, by counting handlers as well as names", toolNames.length === handlers, `${toolNames.length} names against ${handlers} handlers`);
  check("the surface registry has doors and pages", endpoints.length > 50 && surfaces.pages.length > 50, `${endpoints.length} doors, ${surfaces.pages.length} pages`);

  console.log("\n== every reference resolves ==");
  const badHttp = [];
  const badPage = [];
  const badTool = [];
  const badJson = [];
  for (const a of manifest.actions) {
    for (const p of a.projections) {
      if (p.surface === "http") {
        if (!doorSet.has(doorKey(p.path, p.method))) badHttp.push(`${a.id}: ${p.method} ${p.path}`);
      }
      if (p.surface === "page") {
        if (!pages.has(p.path)) badPage.push(`${a.id}: ${p.path}`);
      }
      if (p.surface === "mcp") {
        if (!toolSet.has(p.tool)) badTool.push(`${a.id}: ${p.tool}`);
      }
      if (p.surface === "json") {
        if (!doorPaths.has(p.path)) badJson.push(`${a.id}: ${p.path}`);
      }
    }
  }
  check("every HTTP projection is a registered door with that method", badHttp.length === 0, badHttp.join("; "));
  check("every page projection is a registered page", badPage.length === 0, badPage.join("; "));
  check("every MCP projection is a registered tool", badTool.length === 0, badTool.join("; "));
  check("every json projection is a path the registry knows", badJson.length === 0, badJson.join("; "));

  console.log("\n== a tool is named once ==");
  const seen = new Map();
  for (const a of manifest.actions) {
    for (const p of a.projections) {
      if (p.surface !== "mcp") continue;
      seen.set(p.tool, (seen.get(p.tool) ?? []).concat(a.id));
    }
  }
  const doubled = [...seen.entries()].filter(([, ids]) => ids.length > 1);
  check("no tool is bound to two actions", doubled.length === 0, doubled.map(([t, ids]) => `${t} -> ${ids.join(", ")}`).join("; "));
  check("every tool in the registry appears in the manifest", toolNames.every((t) => seen.has(t)), toolNames.filter((t) => !seen.has(t)).join(", "));
  check("and every tool in the manifest is in the registry", [...seen.keys()].every((t) => toolSet.has(t)));

  console.log("\n== a single surface capability says why ==");
  const silent = manifest.actions.filter((a) => a.projections.length === 1 && (!a.only || a.only.length < 30));
  check("every single projection carries a reason", silent.length === 0, silent.map((a) => a.id).join(", "));
  const thin = manifest.actions.filter((a) => a.projections.length === 0);
  check("no action claims nothing", thin.length === 0, thin.map((a) => a.id).join(", "));

  console.log("\n== the manifest is a manifest ==");
  const ids = manifest.actions.map((a) => a.id);
  check("ids are unique", new Set(ids).size === ids.length, ids.filter((x, i) => ids.indexOf(x) !== i).join(", "));
  check("ids are slugs", ids.every((i) => /^[a-z0-9][a-z0-9-]{1,60}$/.test(i)), ids.filter((i) => !/^[a-z0-9][a-z0-9-]{1,60}$/.test(i)).join(", "));
  check("every effect is read or write", manifest.actions.every((a) => a.effect === "read" || a.effect === "write"));
  check("every action says what it is for", manifest.actions.every((a) => a.what.length > 20));
  check("every action names its evidence", manifest.actions.every((a) => a.evidence.length > 10));

  console.log("\n== the manifest is total over both registries ==");
  const boundPaths = new Set();
  for (const a of manifest.actions) for (const p of a.projections) if (p.surface === "http") boundPaths.add(p.path);
  const unboundDoors = [...doorPaths].filter((p) => !boundPaths.has(p));
  check("every door in the registry appears in the manifest", unboundDoors.length === 0, unboundDoors.join(", "));
  const toolsInActions = new Set();
  for (const a of manifest.actions) for (const p of a.projections) if (p.surface === "mcp") toolsInActions.add(p.tool);
  check("every tool in the registry appears in the manifest", toolNames.every((t) => toolsInActions.has(t)));

  console.log("\n== the curated bindings speak one vocabulary ==");
  const { CURATED_AUTH } = await import("../lib/actions/manifest.ts");
  const offVocab = [];
  for (const a of manifest.actions.filter((x) => !x.derived)) {
    for (const p of a.projections) if (!CURATED_AUTH.includes(p.auth)) offVocab.push(`${a.id}: ${p.auth}`);
  }
  check("every curated projection uses a phrase the vocabulary defines", offVocab.length === 0, [...new Set(offVocab)].join(", "));
  check("the vocabulary is not just one word", CURATED_AUTH.length >= 5, CURATED_AUTH.join(", "));

  console.log("\n== the numbers are the numbers ==");
  const curated = manifest.actions.filter((a) => !a.derived).length;
  const derivedTools = manifest.actions.filter((a) => a.derived && a.tool).length;
  const derivedDoors = manifest.actions.filter((a) => a.derived && !a.tool).length;
  const projections = manifest.actions.reduce((n, a) => n + a.projections.length, 0);
  check("curated count matches the list", manifest.counts.curated === curated, `${manifest.counts.curated} vs ${curated}`);
  check("derived tool count matches the computed set", manifest.counts.derived_tools === derivedTools, `${manifest.counts.derived_tools} vs ${derivedTools}`);
  check("derived door count matches the computed set", manifest.counts.derived_doors === derivedDoors, `${manifest.counts.derived_doors} vs ${derivedDoors}`);
  check("projection count is the sum of projections", manifest.counts.projections === projections, `${manifest.counts.projections} vs ${projections}`);
  check("door count matches the registry", manifest.counts.doors === doorPaths.size, `${manifest.counts.doors} vs ${doorPaths.size}`);
  check("tool count matches the registry", manifest.counts.tools === toolNames.length);
  check("the join is worth publishing", manifest.counts.multi_surface >= 15, `${manifest.counts.multi_surface} capabilities with more than one surface`);
  check("curated bindings cover the capabilities that matter", curated >= 15, `${curated} curated`);
  check(
    "coverage says how many doors are curated rather than implying all of them are",
    manifest.coverage.doors_curated === doorPaths.size - manifest.coverage.doors_not_curated.length,
    `${manifest.coverage.doors_curated} of ${manifest.coverage.doors_total}`,
  );
  const doorNotes = manifest.actions.filter((a) => a.derived && !a.tool).filter((a) => DOOR_NOTES[a.projections[0].path]);
  check(
    "a door note becomes that door's stated reason rather than being dropped",
    doorNotes.every((a) => a.only === DOOR_NOTES[a.projections[0].path]),
    doorNotes.map((a) => a.id).join(", ") || "no notes in play",
  );
  const unknownNote = Object.keys(DOOR_NOTES).filter((p) => !doorPaths.has(p));
  check("every door note names a real door", unknownNote.length === 0, unknownNote.join(", "))

  console.log("\n== the evidence it cites exists ==");
  const cited = new Set();
  for (const a of manifest.actions) for (const m of a.evidence.matchAll(/[a-z0-9-]+\.cjs/g)) cited.add(m[0]);
  check("it cites the verifiers it means", cited.size >= 5, [...cited].join(", "));
  const missing = [...cited].filter((f) => f.startsWith("verify-") && !fs.existsSync(path.join(WEB, "scripts", f)));
  check("every cited verifier exists", missing.length === 0, missing.join(", "));

  console.log("\n== it is reachable, and it is generated once ==");
  const wellKnown = fs.existsSync(path.join(WEB, "app", "well-known", "actions", "route.ts"));
  const apiDoor = fs.existsSync(path.join(WEB, "app", "api", "actions", "route.ts"));
  check("the well-known route exists", wellKnown);
  check("the API door exists", apiDoor);
  const rewrite = fs.readFileSync(path.join(WEB, "next.config.ts"), "utf8");
  check("a rewrite serves the dotted well-known path", rewrite.includes('"/.well-known/actions.json"'), "add the rewrite, or the route compiles and the public path 404s");
  check("the rewrite points at the route directory", /"\/.well-known\/actions\.json",\s*\n\s*destination: "\/well-known\/actions"/.test(rewrite));

  const served = endpoints.find((e) => e.path === "/api/actions");
  check("the API door is registered in the surface registry", Boolean(served), "an unregistered door is a door the live probe cannot check");

  console.log(`\n${failed === 0 ? "actions: all checks passed" : `actions: ${failed} check(s) FAILED`}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
})();
