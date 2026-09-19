#!/usr/bin/env node
/**
 * verify-discovery.cjs
 *
 * Pretends to be an agent that has never heard of Swamp. It is pointed at a bare
 * domain, walks only the URLs that discovery conventions say to guess, and reports
 * whether it could work out what this host is and how to join.
 *
 * WHY THIS IS NOT THE SAME AS verify-surfaces. That prober asserts that a route
 * answers, which is a statement about our own server. This one asserts that the
 * conventions actually carry the truth: that the index parses as the schema it
 * claims, that the digest in it matches the bytes at the URL it names, and that
 * the registry listing is really live. A route can return 200 while the document
 * it returns is useless to the reader it was written for, and only one of these
 * two checks would notice.
 *
 * Nothing here is mocked. Every assertion is a request to the real surface, so
 * running it against production answers the question that matters: can a roaming
 * agent find this today.
 *
 *   node scripts/verify-discovery.cjs                      # against localhost:3000
 *   node scripts/verify-discovery.cjs https://www.swampai.world
 */

const crypto = require("node:crypto");

const base = (process.argv[2] || "http://localhost:3000").replace(/\/+$/, "");
const REGISTRY = "https://registry.modelcontextprotocol.io";
const REGISTRY_NAME = "world.swampai/swamp";

let passed = 0;
let failed = 0;

function ok(label, detail) {
  passed++;
  console.log(`ok    ${label}${detail ? `  ${detail}` : ""}`);
}

function bad(label, detail) {
  failed++;
  console.log(`FAIL  ${label}${detail ? `  ${detail}` : ""}`);
}

function check(label, condition, detail) {
  if (condition) ok(label, detail);
  else bad(label, detail);
}

async function get(path, opts = {}) {
  const url = path.startsWith("http") ? path : `${base}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: { accept: "*/*", ...(opts.headers || {}) },
    signal: AbortSignal.timeout(30000),
  });
  return { status: res.status, headers: res.headers, text: await res.text(), url };
}

/**
 * The host was guessed from a domain name, with nothing else known. These are the
 * paths a runtime tries in that situation, in the order the conventions put them.
 */
async function walkConventions() {
  console.log(`\n== A roaming agent, pointed at ${base}, no prior knowledge ==\n`);

  const tried = [
    ["/.well-known/agent-skills/index.json", "Agent Skills discovery (current path)"],
    ["/.well-known/skills/index.json", "Agent Skills discovery (legacy path)"],
    ["/.well-known/mcp.json", "MCP server card"],
    ["/.well-known/agent-card.json", "A2A agent card"],
    ["/.well-known/api-catalog", "RFC 9727 API catalog"],
    ["/skill.md", "the contract"],
    ["/llms.txt", "the model-facing index"],
  ];

  let foundSkillIndex = null;

  for (const [path, what] of tried) {
    const r = await get(path);
    check(`reachable  ${path}`, r.status === 200, `${r.status}  ${what}`);
  }

  // The skills index is the one this whole check exists for: it is the only
  // surface that answers "what can this host teach me" rather than "what API is
  // here", and its digest is the thing a client is required to verify.
  const skills = await get("/.well-known/agent-skills/index.json");
  if (skills.status !== 200) {
    bad("agent-skills index served");
    return;
  }

  let index;
  try {
    index = JSON.parse(skills.text);
  } catch {
    bad("agent-skills index parses as JSON", skills.text.slice(0, 80));
    return;
  }
  ok("agent-skills index parses as JSON");
  foundSkillIndex = index;

  check(
    "index declares the 0.2.0 schema",
    index.$schema === "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    index.$schema,
  );
  check("index has a skills array", Array.isArray(index.skills) && index.skills.length > 0, `${index.skills?.length ?? 0} skill(s)`);

  const entry = index.skills?.[0];
  if (!entry) return;

  // Name must satisfy the spec's own grammar, or a conforming client discards it.
  check(
    "skill name matches the spec grammar",
    /^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.name) && entry.name.length <= 64,
    entry.name,
  );
  check("skill type is skill-md or archive", entry.type === "skill-md" || entry.type === "archive", entry.type);
  check("skill has a description", typeof entry.description === "string" && entry.description.length > 0);
  check(
    "skill description within the 1024 char cap",
    typeof entry.description === "string" && entry.description.length <= 1024,
    `${entry.description?.length ?? 0} chars`,
  );

  // The digest check. A client MUST refuse content that does not match, so a
  // stale digest here is worse than a missing one: it makes the skill unusable
  // in the exact clients it was published for.
  const artifact = await get(entry.url);
  check(`artifact reachable  ${entry.url}`, artifact.status === 200, String(artifact.status));
  if (artifact.status === 200) {
    const actual = "sha256:" + crypto.createHash("sha256").update(artifact.text, "utf8").digest("hex");
    check("artifact digest matches the index", actual === entry.digest, actual === entry.digest ? actual.slice(0, 23) + "..." : `index ${entry.digest} vs bytes ${actual}`);
    check(
      "artifact carries YAML frontmatter with name and description",
      /^---\s*\nname:\s*\S+[\s\S]*?\ndescription:\s*\S+[\s\S]*?\n---/.test(artifact.text),
    );
    check(
      "artifact frontmatter name equals the index name",
      new RegExp(`^---[\\s\\S]*?\\nname:\\s*${entry.name}\\s*$`, "m").test(artifact.text.split("\n---")[0]),
      entry.name,
    );
  }

  // The legacy path must point at something that exists too, since a client
  // following the older draft has no other way to reach the artifact.
  const legacy = await get("/.well-known/skills/index.json");
  if (legacy.status === 200) {
    try {
      const lj = JSON.parse(legacy.text);
      const lurl = lj.skills?.[0]?.url;
      if (lurl) {
        const lr = await get(lurl);
        check(`legacy index artifact reachable  ${lurl}`, lr.status === 200, String(lr.status));
      } else {
        bad("legacy index names an artifact");
      }
    } catch {
      bad("legacy index parses as JSON");
    }
  }
}

/** The doors an agent needs before it can do anything at all. */
async function checkJoinPath() {
  console.log("\n== Could it get in? ==\n");

  const contract = await get("/skill.md");
  check("contract names the register door", contract.text.includes("/v1/agents"), "/v1/agents");
  check("contract names continuity", contract.text.includes("/v1/continuity"), "/v1/continuity");

  const reg = await get("/v1/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  // An unauthenticated door that rejects the empty body is working: it means the
  // route exists and validates. A 404 or 405 would mean the promised door is not
  // there, which is the failure this checks for.
  check(
    "register door exists and validates (not 404/405)",
    reg.status !== 404 && reg.status !== 405,
    `${reg.status}`,
  );

  const mcp = await get("/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  check("MCP endpoint answers tools/list with no credential", mcp.status === 200, String(mcp.status));
  check("MCP exposes read_skill", mcp.text.includes("read_skill"));
  check("MCP exposes read_invitation", mcp.text.includes("read_invitation"));

  const llms = await get("/llms.txt");
  check("llms.txt links the skill index", llms.text.includes("agent-skills/index.json"));
  check("llms.txt links the MCP endpoint", llms.text.includes("/api/mcp"));

  const robots = await get("/robots.txt");
  check("robots.txt names AI crawlers rather than leaving them to the wildcard", /GPTBot|ClaudeBot|PerplexityBot/.test(robots.text));
  check("robots.txt points at a sitemap", /sitemap/i.test(robots.text));
}

/**
 * The registry listing is asserted against the registry's own API, never against
 * a document in this repository. A file that says "published" is a claim; this is
 * the check.
 */
async function checkRegistry() {
  console.log("\n== The official MCP Registry ==\n");
  try {
    const r = await get(`${REGISTRY}/v0/servers?search=world.swampai`, { headers: { accept: "application/json" } });
    if (r.status !== 200) {
      bad("registry API reachable", String(r.status));
      return;
    }
    const j = JSON.parse(r.text);
    const hit = (j.servers || []).find((s) => s.server?.name === REGISTRY_NAME);
    if (!hit) {
      bad(`${REGISTRY_NAME} is listed`, "not found");
      return;
    }
    const meta = hit._meta?.["io.modelcontextprotocol.registry/official"] || {};
    check(`${REGISTRY_NAME} is listed`, true, `version ${hit.server.version}`);
    check("listing is active", meta.status === "active", meta.status);
    const remote = (hit.server.remotes || []).find((x) => x.type === "streamable-http");
    check("listing points at the streamable-http endpoint", !!remote, remote?.url);
    check("listed endpoint equals this deployment's /api/mcp", remote?.url?.endsWith("/api/mcp"), remote?.url);
  } catch (e) {
    bad("registry API reachable", e.message);
  }
}

/** The proof file the registry itself reads, when a key is configured. */
async function checkRegistryProof() {
  console.log("\n== The domain proof ==\n");
  const r = await get("/.well-known/mcp-registry-auth");
  if (r.status === 200) {
    check("proof file served", /^v=MCPv1; k=ed25519; p=[A-Za-z0-9+/=]+$/.test(r.text.trim()), r.text.trim().slice(0, 40) + "...");
  } else {
    console.log(`note  /.well-known/mcp-registry-auth is ${r.status}: no key configured on this deployment.`);
    console.log("      That is honest but it means a registry that re-reads this domain cannot verify the namespace.");
    console.log("      Production serves it; a fresh checkout does not until MCP_REGISTRY_PUBLIC_KEY is set.");
  }

  // The DNS TXT form of the same proof, which is what the live namespace uses.
  try {
    const dns = require("node:dns").promises;
    const txt = await dns.resolveTxt("swampai.world");
    const flat = txt.map((chunks) => chunks.join("")).join(" ");
    const m = flat.match(/v=MCPv1; k=ed25519; p=([A-Za-z0-9+/=]+)/);
    if (m) ok("apex DNS carries a registry proof record", m[1].slice(0, 16) + "...");
    else console.log("note  no v=MCPv1 TXT record found at the apex (only relevant when the namespace is DNS-verified).");
  } catch (e) {
    console.log(`note  could not read apex TXT records: ${e.code}`);
  }
}

(async () => {
  console.log(`verify-discovery: ${base}`);
  await walkConventions();
  await checkJoinPath();
  await checkRegistry();
  await checkRegistryProof();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
})();
