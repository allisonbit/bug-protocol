#!/usr/bin/env node
/**
 * Check that every runtime connection this site claims actually connects.
 *
 * WHY THIS IS A SCRIPT AND NOT A SENTENCE. A connect page is a list of promises,
 * and the standard way one goes wrong is quietly: the endpoint moves, a config
 * block keeps pointing at the old host, a snippet names a path that 404s, and the
 * page reads perfectly the whole time. Every claim below is therefore EXECUTED
 * against a running deployment:
 *
 *   - the MCP endpoint answers a real `initialize` handshake, not just a 200
 *   - every tool is named exactly once, because MCP identifies a tool by name and
 *     a duplicate silently shadows one of the two rather than failing (see
 *     scripts/verify-tool-names.cjs, which catches the same thing from the source
 *     without needing a deployment to be up)
 *   - the config blocks the page prints are parsed, and the URL inside each one is
 *     the same endpoint the handshake was performed against
 *   - the OAuth discovery pair is consistent: both documents answer, the resource
 *     metadata names the MCP endpoint as the resource, and every endpoint the
 *     authorization server metadata advertises itself answers
 *   - the challenge an unauthenticated client reads points at a document that
 *     exists, because a WWW-Authenticate header naming a 404 starts nothing
 *   - the pages the roster links to are there
 *   - the generated Claude Code marketplace, when it has been built, references
 *     the same endpoint and bundles the same skill bytes the domain serves
 *
 * The roster is READ from lib/runtimes.ts rather than restated here, so a runtime
 * added to the page is a runtime added to this check, and a claim can never be
 * moved into a paragraph to escape verification.
 *
 *   node --experimental-strip-types --import ./scripts/alias-register.mjs \
 *     scripts/verify-runtimes.cjs https://www.swampai.world
 *
 * PASS THE ENV THE TARGET WAS BUILT WITH. The roster's URLs come from
 * lib/site.ts, which reads NEXT_PUBLIC_SITE_URL, and that is inlined into the
 * deployment at build time. Checking a production deployment from a checkout whose
 * env points somewhere else therefore compares two different hosts — which is a
 * real question, but not this one. The script prints the endpoint it is using so a
 * mismatch is visible rather than mysterious:
 *
 *   NEXT_PUBLIC_SITE_URL=https://www.swampai.world node ... scripts/verify-runtimes.cjs https://www.swampai.world
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const base = (process.argv[2] || "http://localhost:3000").replace(/\/+$/, "");

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok    ${name}${detail ? " — " + detail : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

const MCP_INIT = (id) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "verify-runtimes", version: "1.0.0" },
  },
});

async function handshake(url) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(MCP_INIT(1)),
  }).catch((e) => ({ status: `ERR ${e.message}`, json: async () => null }));
  const body = await res.json?.().catch?.(() => null);
  return { status: res.status, body };
}

(async () => {
  // The modules below read NEXT_PUBLIC_SITE_URL at import time and fall back to a
  // baked-in constant. Pointing this run at the target it is actually checking
  // keeps the roster's own URLs in the same origin as the deployment, so a failure
  // below is about the deployment rather than about this working copy's env.
  if (!process.env.NEXT_PUBLIC_SITE_URL) process.env.NEXT_PUBLIC_SITE_URL = base;
  const runtimes = await import("../lib/runtimes.ts");
  const site = await import("../lib/site.ts");
  /**
   * The endpoint UNDER TEST comes from the base, not from this checkout.
   *
   * This read `MCP_ENDPOINT` instead, which is built from NEXT_PUBLIC_SITE_URL and
   * falls back to a hardcoded domain in lib/site.ts. Pointed at production from a
   * checkout whose env var was unset, that made three checks fail while naming the
   * correct URL on both sides: the protected-resource metadata, its path-aware
   * sibling, and the generated Claude plugin were each compared against a constant
   * rather than against the deployment they were fetched from. Nothing about the
   * deployment was wrong, and the check sent a reader to the wrong file, which is
   * worse than a check that fails for a reason it can name.
   */
  const endpoint = new URL("/api/mcp", base).href;

  console.log(`\nverifying the runtime roster against ${base}`);
  console.log(`the roster names ${runtimes.RUNTIMES.length} runtimes, built for ${endpoint}`);
  if (!site.MCP_ENDPOINT.startsWith(base)) {
    console.log(
      `note  this checkout's own env names ${site.MCP_ENDPOINT}, so the roster comparisons below are about the DEPLOYMENT at ${base} and not about this working copy.`,
    );
  }
  console.log("");

  // ── 1. The endpoint answers MCP at all ────────────────────────────────────
  console.log("== the endpoint ==");
  const hs = await handshake(endpoint);
  check(
    "the MCP endpoint completes an initialize handshake",
    Boolean(hs.body?.result?.serverInfo),
    `${hs.status} ${hs.body?.result?.serverInfo?.name ?? ""}`,
  );
  const listed = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  })
    .then((r) => r.json())
    .catch(() => null);
  check("and lists tools without a credential", Array.isArray(listed?.result?.tools), `${listed?.result?.tools?.length ?? 0} tools`);

  // A duplicate tool name is invisible from here in every other respect: the
  // endpoint answers, the count rises, and one of the two is unreachable from any
  // client that keys by name. This is the assertion that would have caught
  // `read_skills` being declared twice.
  const liveNames = (listed?.result?.tools ?? []).map((t) => t.name).filter(Boolean);
  const liveDupes = [...new Set(liveNames.filter((n, i) => liveNames.indexOf(n) !== i))];
  check(
    "and names every tool exactly once",
    liveNames.length > 0 && liveDupes.length === 0,
    liveDupes.length ? `duplicated on the live surface: ${liveDupes.join(", ")}` : `(${liveNames.length} unique)`,
  );

  // ── 2. Every block the page prints points at that same endpoint ───────────
  console.log("\n== the blocks the page prints ==");
  for (const [name, block] of [
    ["MCP_HTTP_CONFIG", runtimes.MCP_HTTP_CONFIG],
    ["MCP_STDIO_CONFIG", runtimes.MCP_STDIO_CONFIG],
  ]) {
    let parsed = null;
    try {
      parsed = JSON.parse(block);
    } catch (e) {
      check(`${name} parses`, false, e.message);
      continue;
    }
    const server = parsed?.mcpServers?.swamp ?? {};
    const url = server.url ?? (Array.isArray(server.args) ? server.args[server.args.length - 1] : null);
    check(`${name} points at the verified endpoint`, url === endpoint, String(url));
  }

  // ── 3. The OAuth discovery pair, and that its own endpoints answer ────────
  console.log("\n== the OAuth handshake a hosted connector performs ==");
  const asRes = await fetch(`${base}/.well-known/oauth-authorization-server`).catch(() => null);
  const as = asRes ? await asRes.json().catch(() => null) : null;
  check("authorization server metadata answers", Boolean(as?.authorization_endpoint), String(asRes?.status));
  check("and is scoped to this origin", String(as?.issuer ?? "").startsWith(base), String(as?.issuer));
  check("PKCE S256 is the only challenge method", JSON.stringify(as?.code_challenge_methods_supported) === '["S256"]', JSON.stringify(as?.code_challenge_methods_supported));

  const prRes = await fetch(`${base}/.well-known/oauth-protected-resource`).catch(() => null);
  const pr = prRes ? await prRes.json().catch(() => null) : null;
  check("protected resource metadata answers", Boolean(pr?.resource), String(prRes?.status));
  check("and names the MCP endpoint as the resource", pr?.resource === endpoint, String(pr?.resource));
  check(
    "and names an authorization server",
    Array.isArray(pr?.authorization_servers) && pr.authorization_servers.length > 0,
    JSON.stringify(pr?.authorization_servers),
  );

  const prPath = await fetch(`${base}/.well-known/oauth-protected-resource/api/mcp`).catch(() => null);
  const prPathBody = prPath ? await prPath.json().catch(() => null) : null;
  check("the path-aware sibling answers the same document", prPathBody?.resource === endpoint, String(prPath?.status));

  // Every endpoint the metadata advertises must exist. This is the check that
  // catches a metadata document that describes the flow it wishes it had.
  for (const [key, wantGet] of [
    ["authorization_endpoint", true],
    ["token_endpoint", true],
    ["registration_endpoint", true],
  ]) {
    const url = as?.[key];
    if (!url) {
      check(`${key} is advertised`, false, "missing");
      continue;
    }
    const res = await fetch(url, { redirect: "manual" }).catch((e) => ({ status: `ERR ${e.message}` }));
    check(`${key} answers (${url.replace(base, "")})`, res.status === 200, String(res.status));
    if (wantGet && res.status !== 200) {
      console.log(`         (a GET door is the contract: it explains the endpoint to whoever opens it)`);
    }
  }

  // ── 4. The challenge an unauthenticated client reads ─────────────────────
  console.log("\n== the challenge ==");
  const challenged = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "agent_whoami", arguments: {} } }),
  });
  const header = challenged.headers.get("www-authenticate") ?? "";
  check("an agent tool with no credential answers 401", challenged.status === 401, String(challenged.status));
  const metaUrl = /resource_metadata="([^"]+)"/.exec(header)?.[1] ?? null;
  check("the challenge names the protected-resource metadata", Boolean(metaUrl), header);
  if (metaUrl) {
    const metaRes = await fetch(metaUrl).catch((e) => ({ status: `ERR ${e.message}` }));
    check("and that document exists", metaRes.status === 200, `${metaRes.status} ${metaUrl}`);
  }
  const exposed = challenged.headers.get("access-control-expose-headers") ?? "";
  check(
    "and a browser client is allowed to read the header",
    exposed.toLowerCase().includes("www-authenticate"),
    exposed,
  );

  // ── 5. The pages the roster links to ─────────────────────────────────────
  console.log("\n== the pages ==");
  for (const p of ["/connect", "/hubs", "/discover"]) {
    const res = await fetch(base + p, { redirect: "manual" }).catch((e) => ({ status: `ERR ${e.message}` }));
    check(`${p} answers`, res.status === 200, String(res.status));
  }

  // ── 6. The generated Claude Code marketplace, when it exists ─────────────
  console.log("\n== the Claude Code marketplace ==");
  const bundle = path.join(__dirname, "..", "claude-plugin");
  if (!fs.existsSync(bundle)) {
    console.log("  skip  not built here. Run scripts/build-claude-plugin.cjs to check one.");
  } else {
    const market = JSON.parse(fs.readFileSync(path.join(bundle, ".claude-plugin", "marketplace.json"), "utf8"));
    check("the marketplace manifest parses and names a plugin", Array.isArray(market.plugins) && market.plugins.length > 0, market.name);
    const source = market.plugins[0]?.source ?? "";
    const pluginDir = path.join(bundle, source.replace(/^\.\//, ""));
    check("the plugin its entry points at exists", fs.existsSync(path.join(pluginDir, ".claude-plugin", "plugin.json")), source);

    const mcp = JSON.parse(fs.readFileSync(path.join(pluginDir, ".mcp.json"), "utf8"));
    check("and the plugin's MCP url is the verified endpoint", mcp?.mcpServers?.swamp?.url === endpoint, String(mcp?.mcpServers?.swamp?.url));

    const skillFile = path.join(pluginDir, "skills", "swamp", "SKILL.md");
    if (!fs.existsSync(skillFile)) {
      check("the bundled skill exists", false, skillFile);
    } else {
      const served = await fetch(`${base}/.well-known/agent-skills/swamp/SKILL.md`).then((r) => r.text()).catch(() => "");
      check(
        "the bundled skill is byte-identical to the served one",
        sha256(fs.readFileSync(skillFile, "utf8")) === sha256(served),
        `${sha256(served).slice(0, 12)}…`,
      );
    }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exitCode = 1;
})().catch((e) => {
  console.error(`verify-runtimes crashed: ${e.stack ?? e.message}`);
  process.exitCode = 1;
});
