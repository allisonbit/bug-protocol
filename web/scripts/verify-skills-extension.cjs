/**
 * Skills over MCP (SEP-2640): the manifest, the addresses, and the digests.
 *
 * WHY THIS FILE EXISTS. The extension is a compatibility claim, and every part of it
 * fails silently if it is wrong. A digest that does not match the bytes it describes
 * turns a client's mandatory integrity check into a refusal. A skill URI whose last
 * segment is not the declared name cannot be resolved by a client that was told the
 * name and nothing else. A capability undeclared is an extension a client never asks
 * for. None of those produces a local error, so each is asserted from the module that
 * emits it and from the route that serves it.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-skills-extension.cjs
 */
const fs = require("fs");
const path = require("path");
const { createHash } = require("node:crypto");

(async () => {
  const skills = await import("../lib/mcp/skills.ts");
  const protocol = await import("../lib/mcp/protocol.ts");
  const skill = await import("../lib/skill.ts");

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else {
      console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
      failed += 1;
    }
  };
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

  console.log("\nthe skill, addressed the way the extension requires");
  const uri = skills.skillUri();
  const fileUri = skills.skillFileUri();
  const name = skills.declaredSkillName();
  check("the frontmatter declares a name", Boolean(name), name);
  check("the name is the skill's own name", name === skill.SKILL_NAME, `${name} vs ${skill.SKILL_NAME}`);
  check("the skill uri is a skill:// uri", uri.startsWith("skill://"), uri);
  const segments = uri.replace("skill://", "").split("/");
  check("its final path segment equals the declared name", segments[segments.length - 1] === name, uri);
  check("the file lives under the skill", fileUri.startsWith(uri + "/"), fileUri);
  check("and is named for the artifact", fileUri.endsWith("/SKILL.md"), fileUri);
  check("the authority is a resolvable host", segments[0] === "www.swampai.world", segments[0]);
  check("the server claims its own uris", skills.ownsSkillUri(uri) && skills.ownsSkillUri(fileUri));
  check("and disclaims another server's", !skills.ownsSkillUri("skill://someone.else/thing/SKILL.md"));

  console.log("\nthe manifest, which is what a client verifies against");
  const entry = skills.skillEntry();
  check("the entry carries the skill uri", entry.uri === uri, entry.uri);
  check("the frontmatter is rendered as text, not as an object", typeof entry.frontmatter === "string" && entry.frontmatter.includes("name:"));
  check("the frontmatter is the file's own, verbatim", skill.SKILL_MD.includes(entry.frontmatter));
  check("resources is a complete manifest, not the dynamic marker", Array.isArray(entry.resources), typeof entry.resources);
  const only = entry.resources[0];
  check("the artifact is declared", only.uri === fileUri, only.uri);
  check(
    "its digest is the sha256 of the bytes served",
    only.digest === `sha256:${createHash("sha256").update(skill.SKILL_MD, "utf8").digest("hex")}`,
    only.digest,
  );
  check("the digest is spelled the way the extension spells it", /^sha256:[0-9a-f]{64}$/.test(only.digest));
  check("its size is the byte length", only.size === Buffer.byteLength(skill.SKILL_MD, "utf8"), String(only.size));
  check("the manifest is under the extension's file limit", entry.resources.length <= 512);
  check("and under its byte limit", entry.resources.reduce((n, r) => n + r.size, 0) <= 16 * 1024 * 1024);

  console.log("\nthe capability and the methods, declared where a client looks");
  check("the extension id is the spec's", protocol.EXTENSIONS.skills === "io.modelcontextprotocol/skills", protocol.EXTENSIONS.skills);
  const caps = protocol.serverCapabilities();
  const declared = caps.extensions[protocol.EXTENSIONS.skills];
  check("the capability declares directoryRead", declared?.directoryRead === true, JSON.stringify(declared));
  check("and names both methods", declared.methods.includes("skills/list") && declared.methods.includes("skills/get"));
  check("discovery carries it too, not only initialize", JSON.stringify(protocol.discoverPayload({ server: {}, instructions: "" }).capabilities).includes("skills"));
  const card = read("lib/mcp/server-card.ts");
  check("the server card reuses the same capabilities", card.includes("capabilities: serverCapabilities()"));

  console.log("\nwiring, where an extension nobody serves would look finished");
  const route = read("app/api/mcp/route.ts");
  check("skills/list is served", route.includes('case "skills/list"'));
  check("skills/get is served", route.includes('case "skills/get"'));
  check("skills/get refuses a uri it does not own", route.includes("This server publishes one skill"));
  check("the artifact is served over resources/read", route.includes("if (uri === skillFileUri())"));
  check("the read carries the digest with the bytes", route.includes('"io.modelcontextprotocol/skills": { digest: skillFileDigest()'));
  check("the skill uri itself answers with the manifest", route.includes("if (uri === skillUri())"));
  check("the file is listed as a resource as well", route.includes("...skillResourceListEntry()"));
  check("the catalogue read carries the cache hints", route.includes("skills: [skillEntry()], ...CACHE"));
  check("the resource listing carries them too", /resources: \[[\s\S]*\.\.\.CACHE/.test(route));
  const skillsSrc = read("lib/mcp/skills.ts");
  check("the digest is computed from the served string, never typed in", skillsSrc.includes('createHash("sha256").update(SKILL_MD'));
  check("the name is parsed rather than repeated", skillsSrc.includes("parseFrontmatter(SKILL_MD)"));

  console.log(`\n${failed === 0 ? "skills: all checks passed" : `skills: ${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
})();
