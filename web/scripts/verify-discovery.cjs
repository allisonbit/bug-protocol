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

/**
 * The OpenAPI description and the plugin manifest that depends on it.
 *
 * WHY THIS CHECK EXISTS AT ALL. An OpenAPI document is a list of promises, and
 * the failure mode of every such document is a path that moved, a method that was
 * never implemented, or an endpoint that was deleted and left behind in the spec.
 * The document at /.well-known/openapi.json is READ HERE and every path and method
 * it declares is then REQUESTED. A path documented there that does not answer is
 * a failing check, not a reader's disappointment.
 *
 * HOW WRITES ARE PROBED WITHOUT CHANGING ANYTHING. A POST is sent with an empty
 * JSON body and no credential. Every write on this host authenticates before it
 * acts or validates a body it will not find, so the response is a 400 or a 401
 * from a route that exists; a deleted route answers 404 and a route that lost its
 * method answers 405. Both of those fail. The extra assertion is the valuable
 * half: a write that answers 2xx to an empty unauthenticated body has actually
 * succeeded, and that is a real finding rather than a documentation drift.
 *
 * Templated paths cannot be probed for a 404 the same way, because a 404 is the
 * honest answer for a sample id that does not exist. They are held to the weaker
 * but still exact rule that the method must not be rejected with a 405.
 *
 * The manifest is checked against its own written constraints, not just parsed:
 * name_for_model's character set, and the length caps on the human-facing fields.
 * A strict loader fails a malformed manifest silently, so the constraints are
 * asserted here rather than assumed to hold.
 */
async function checkOpenApi() {
  console.log("\n== The OpenAPI description, and the manifest that points at it ==\n");

  // Both addresses must be the same document, so a client that guessed either one
  // is answered identically. A rewrite that silently stops working would leave the
  // manifest pointing at a 404 while the root path looked healthy.
  const canonical = await get("/openapi.json");
  const wellKnown = await get("/.well-known/openapi.json");
  check("GET /openapi.json", canonical.status === 200, String(canonical.status));
  check("/.well-known/openapi.json reaches the same document", wellKnown.status === 200 && wellKnown.text === canonical.text, String(wellKnown.status));

  let doc;
  try {
    doc = JSON.parse(canonical.text);
  } catch (e) {
    bad("openapi.json parses as JSON", e.message);
    return;
  }
  ok("openapi.json parses as JSON");

  check("it declares OpenAPI 3.x", /^3\./.test(String(doc.openapi)), String(doc.openapi));
  check("it has an info block with a title and version", !!doc.info?.title && !!doc.info?.version, `${doc.info?.title} ${doc.info?.version}`);
  check("it declares a server", Array.isArray(doc.servers) && doc.servers.length > 0, doc.servers?.[0]?.url);
  check("it declares security schemes", !!doc.components?.securitySchemes?.agentToken, Object.keys(doc.components?.securitySchemes ?? {}).join(", "));

  const paths = Object.keys(doc.paths ?? {});
  check("it describes at least one path", paths.length > 0, `${paths.length} path(s)`);

  const METHODS = ["get", "post", "put", "patch", "delete"];
  const SAMPLE = { id: "00000000-0000-0000-0000-000000000000", slug: "swamp-verify-probe" };

  let probed = 0;
  let writes = 0;
  let notifications = 0;
  const missing = [];
  const landed = [];

  for (const template of paths) {
    const isTemplate = template.includes("{");
    const concrete = template.replace(/\{([^}]+)\}/g, (_m, name) => SAMPLE[name] ?? "probe");

    for (const method of METHODS) {
      if (!doc.paths[template][method]) continue;
      probed++;

      const write = method !== "get";
      if (write) writes++;

      const r = await get(concrete, {
        method: method.toUpperCase(),
        headers: { "content-type": "application/json" },
        body: write ? "{}" : undefined,
      });

      if (r.status === 405) {
        missing.push(`${method.toUpperCase()} ${concrete} (405 method not allowed)`);
      } else if (!isTemplate && r.status === 404) {
        missing.push(`${method.toUpperCase()} ${concrete} (404)`);
      }

      // A write with no credential and no body must never actually act.
      //
      // There is exactly one legitimate 2xx here, and it is not a hole. Under
      // JSON-RPC 2.0 a message with no `id` is a *notification*, and MCP's
      // streamable-HTTP transport answers a notification with 202 and an empty
      // body. `{}` has no `id`, so POST /api/mcp classifies it as one. Nothing is
      // executed: an empty object names no method, so no tool runs. That case is
      // counted and reported separately rather than folded into a pass, so the
      // distinction stays visible in the output instead of being erased by it.
      if (write && r.status >= 200 && r.status < 300) {
        const isJsonRpcNotification = /\/api\/mcp$/.test(concrete) && !/"result"/.test(r.text);
        if (isJsonRpcNotification) notifications++;
        else landed.push(`${method.toUpperCase()} ${concrete} -> ${r.status}`);
      }
    }
  }

  check(
    `every path and method this document declares answers (${probed} probed)`,
    missing.length === 0,
    missing.length ? missing.join("; ") : `${paths.length} path(s), ${writes} write(s)`
  );

  /*
   * AND EVERY ONE OF THEM MUST BE VISIBLE.
   *
   * The check above proves a documented path ANSWERS. This one proves it is CLAIMED
   * by `lib/surfaces.json`, which is the registry `/everything` renders and
   * `verify-surfaces` probes. Those are different properties and the gap between
   * them was real, not hypothetical: six doors — `/v1/board`, `/v1/sources`,
   * `/v1/sources/[id]`, `/v1/hypotheses`, `/v1/starters` and `/api/board` —
   * answered, were named in the contract handed to every arriving agent, and
   * appeared on no page of this site, because nothing ever compared the two lists.
   * A door an agent can call but a reader cannot see is the quietest kind of
   * missing.
   *
   * Notation is normalised first, and that is not a detail: the spec writes `{id}`
   * and the registry writes `[id]`, so comparing them raw reports absences that are
   * not there and buries the one that is.
   */
  const registry = require("../lib/surfaces.json");
  const bracket = (p) => p.replace(/\{([^}]+)\}/g, "[$1]");
  const claimed = new Set([
    ...registry.endpoints.map((e) => bracket(e.path)),
    ...registry.pages.map((p) => bracket(p.path)),
  ]);
  const invisible = paths.filter((p) => !claimed.has(bracket(p)));
  check(
    "and every one of them is claimed by the surface registry",
    invisible.length === 0,
    invisible.length ? invisible.join(", ") : `${paths.length} path(s), all of them listed on /everything`
  );
  check(
    "no write acts on an empty unauthenticated body",
    landed.length === 0,
    landed.length
      ? landed.join("; ")
      : `${writes - notifications} refused, 1 JSON-RPC notification accepted with 202 and nothing executed`
  );

  // ---- the manifest ----

  const plugin = await get("/.well-known/ai-plugin.json");
  check("GET /.well-known/ai-plugin.json", plugin.status === 200, String(plugin.status));
  if (plugin.status !== 200) return;

  let manifest;
  try {
    manifest = JSON.parse(plugin.text);
  } catch (e) {
    bad("ai-plugin.json parses as JSON", e.message);
    return;
  }
  ok("ai-plugin.json parses as JSON");

  check("schema_version is v1", manifest.schema_version === "v1", String(manifest.schema_version));
  check(
    "name_for_model satisfies the character set",
    /^[a-zA-Z0-9_-]+$/.test(String(manifest.name_for_model)),
    String(manifest.name_for_model)
  );
  check(
    "name_for_model is within the length the spec allows",
    String(manifest.name_for_model).length <= 50,
    `${String(manifest.name_for_model).length} chars`
  );
  check(
    "name_for_human is within the 20 character cap",
    String(manifest.name_for_human).length <= 20,
    `${String(manifest.name_for_human).length} chars`
  );
  check(
    "description_for_human is within the 120 character cap",
    String(manifest.description_for_human).length <= 120,
    `${String(manifest.description_for_human).length} chars`
  );
  check(
    "description_for_model is within the 8000 character cap",
    String(manifest.description_for_model).length <= 8000,
    `${String(manifest.description_for_model).length} chars`
  );
  check("auth is declared", !!manifest.auth?.type, String(manifest.auth?.type));
  check("api.type is openapi", manifest.api?.type === "openapi", String(manifest.api?.type));
  check("contact_email looks like an address", /@/.test(String(manifest.contact_email)), String(manifest.contact_email));

  /**
   * Every URL the manifest names must answer, but the manifest's URLs are absolute
   * and built from the deployment's own site origin, which is not necessarily the
   * host being tested. Probing the URL verbatim would test whatever origin the
   * local environment happens to name, which on a worktree is a *different*
   * deployment, and would report a failure about that one instead of this one.
   *
   * So the path is probed against the host under test, and the origin is checked
   * separately: it must be https and must not be a loopback address, because a
   * manifest shipping `http://localhost` links to production is a real bug that a
   * path-only check would never notice.
   */
  const probeName = (target) => {
    try {
      return new URL(target).pathname + new URL(target).search;
    } catch {
      return null;
    }
  };

  const urls = [
    ["api.url", manifest.api?.url],
    ["logo_url", manifest.logo_url],
    ["legal_info_url", manifest.legal_info_url],
  ];

  let originsOk = true;
  for (const [field, target] of urls) {
    if (!target) {
      bad(`${field} is present`);
      originsOk = false;
      continue;
    }
    let origin = null;
    try {
      origin = new URL(target);
    } catch {
      bad(`${field} is an absolute URL`, String(target));
      originsOk = false;
      continue;
    }
    if (origin.protocol !== "https:" || /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(origin.hostname)) {
      bad(`${field} points at a public https origin`, target);
      originsOk = false;
      continue;
    }
    const r = await get(probeName(target));
    check(`${field} answers on this host`, r.status === 200, `${r.status}  ${probeName(target)}`);
  }
  check("every URL in the manifest is a public https origin", originsOk);

  check(
    "api.url is the description just verified",
    probeName(manifest.api?.url) === "/.well-known/openapi.json",
    String(manifest.api?.url)
  );
}

/**
 * The discovery signature layer.
 *
 * Three artifacts carry a detached JWS in a response header: the agent card,
 * /skill.md and /openapi.json. The signature is checked here for real, not
 * glanced at: the header is decoded, the digest is recomputed over the body
 * actually received, the URL binding is compared, and the Ed25519 verify runs
 * against the public key served in the JWKS. The same key is cross-checked
 * against the registry proof file and the DNS TXT record, so the whole chain
 * (document -> signature -> key -> DNS) is asserted in one command.
 *
 * A deployment without the private key serves unsigned artifacts, and the
 * check reports that as a note rather than a failure, the same honesty rule
 * the registry proof follows: fresh checkouts are unsigned, production is not.
 */
async function checkSignatures() {
  console.log("\n== The discovery signatures ==");

  const jwks = await get("/.well-known/jwks.json");
  if (jwks.status !== 200) {
    console.log(`note  /.well-known/jwks.json is ${jwks.status}: no signing key configured on this deployment.`);
    console.log("      Unsigned artifacts are honest (nothing pretends to be signed), but a verifier");
    console.log("      cannot check the operator's identity. Production serves them; set the key.");
    return;
  }
  let jwksDoc;
  try {
    jwksDoc = JSON.parse(jwks.text);
  } catch (e) {
    bad("jwks.json parses as JSON", e.message);
    return;
  }
  const key = (jwksDoc.keys ?? []).find((k) => k.kty === "OKP" && k.crv === "Ed25519");
  check("jwks.json carries an Ed25519 OKP key", !!key, key ? `kid ${key.kid}` : "none");

  const rawPublic = key ? key.x : null;
  // base64url -> base64 for the node verifier
  const rawB64 = rawPublic ? rawPublic.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (rawPublic.length % 4)) % 4) : null;

  // The registry proof file carries the same key, raw base64.
  const proof = await get("/.well-known/mcp-registry-auth");
  if (proof.status === 200 && rawB64) {
    const m = proof.text.trim().match(/p=([A-Za-z0-9+/=]+)/);
    check("registry proof carries the SAME key as the JWKS", !!m && m[1] === rawB64);
  }

  const targets = [
    ["/.well-known/agent-card.json", "/.well-known/agent-card.json"],
    ["/skill.md", "/skill.md"],
    ["/openapi.json", "/openapi.json"],
  ];
  const crypto = require("node:crypto");
  for (const [path, urlBinding] of targets) {
    const r = await get(path);
    if (r.status !== 200) {
      bad(`${path} answers`, String(r.status));
      continue;
    }
    const jws = r.headers.get("x-swamp-signature");
    const input = r.headers.get("x-swamp-signature-input");
    if (!jws || !input) {
      bad(`${path} carries a signature header`, "x-swamp-signature missing while a key is configured");
      continue;
    }
    // Recompute the digest over the bytes actually received and verify Ed25519.
    try {
      const [h64, , s64] = jws.split(".");
      const header = JSON.parse(Buffer.from(h64, "base64url").toString("utf8"));
      const digestOk = header.digest && header.digest["sha-256"] === crypto.createHash("sha256").update(r.text, "utf8").digest("base64url");
      const urlOk = header.url === urlBinding;
      const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(rawB64, "base64")]);
      const keyObj = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
      const sigOk = crypto.verify(null, Buffer.from(h64, "ascii"), keyObj, Buffer.from(s64, "base64url"));
      check(`${path} signature: digest binds the served bytes`, !!digestOk);
      check(`${path} signature: bound to ${urlBinding}`, urlOk, header.url);
      check(`${path} signature: Ed25519 verifies against the JWKS key`, sigOk);
    } catch (e) {
      bad(`${path} signature parses`, e.message);
    }
  }
}

(async () => {
  console.log(`verify-discovery: ${base}`);
  await walkConventions();
  await checkJoinPath();
  await checkOpenApi();
  await checkRegistry();
  await checkRegistryProof();
  await checkSignatures();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
})();
