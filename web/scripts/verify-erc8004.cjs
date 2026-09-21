/**
 * ERC-8004 registration files, and the one thing they must not do.
 *
 * WHY THIS FILE EXISTS. The standard's June 2026 empirical study crawled every Identity
 * and Reputation event on three chains and found more than 170,000 registered agents
 * with only 3 to 15 percent exposing a valid registration file that had at least one
 * live endpoint. The failure mode is a file that LOOKS complete: it names services
 * nobody serves and implies a registration nobody made. So this checks three things the
 * shape alone cannot: every endpoint in the platform's file answers on this deployment,
 * the `registrations` list is empty and says why rather than being filled with something
 * plausible, and the proof document and the registration file carry the same list,
 * because a proof that disagrees with the thing it proves is worse than none.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-erc8004.cjs [--url https://...]
 */
const fs = require("fs");
const path = require("path");

(async () => {
  const erc = await import("../lib/identity/erc8004.ts");
  const did = await import("../lib/identity/did.ts");

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else {
      console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
      failed += 1;
    }
  };
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

  console.log("\nthe platform's own file");
  const file = erc.platformRegistrationFile();
  check("it carries the standard's type marker", file.type === erc.REGISTRATION_TYPE, file.type);
  check("it has a name and a description", Boolean(file.name) && file.description.length > 80);
  check("it declares x402 support", file.x402Support === true);
  check("it declares itself active", file.active === true);
  check("its registrations list is EMPTY", Array.isArray(file.registrations) && file.registrations.length === 0);
  check("and it says why, in the document rather than in a comment", /no on chain ERC-8004 registration/i.test(file.swamp.registrations_note));
  check("supportedTrust names the models the record supplies", file.supportedTrust.includes("reputation") && file.supportedTrust.includes("crypto-economic"));
  check("the image is an absolute url", /^https?:\/\//.test(file.image), file.image);

  console.log("\nthe services, which is where a published file usually lies");
  const names = file.services.map((s) => s.name);
  check("it names a web service", names.includes("web"));
  check("it names MCP with the revision it speaks", file.services.some((s) => s.name === "MCP" && s.version === "2026-07-28"));
  check("it names A2A", names.includes("A2A"));
  check("it names the DID", names.includes("DID"));
  // A DID service names a DID, not a URL: that is what the standard asks for and what a
  // resolver reads, so the http check applies to the services that are endpoints and the
  // DID is asserted separately.
  const endpoints = erc.registrationEndpoints(file);
  check("every non-DID service is an absolute http(s) url", endpoints.length === file.services.length - 1, `${endpoints.length} of ${file.services.length - 1}`);
  const hosts = new Set(endpoints.map((e) => new URL(e).host));
  check("and every one is on this deployment", hosts.size === 1, [...hosts].join(","));
  check("the DID is the platform's own", file.services.find((s) => s.name === "DID").endpoint === did.platformDid());

  console.log("\nthe domain proof, and the agreement it exists to establish");
  const proof = erc.domainProof();
  check("the proof names the domain", proof.proof.domain === did.didHost(), proof.proof.domain);
  check("the domain is the one the endpoints are on", [...hosts].every((h) => h === proof.proof.domain), [...hosts].join(","));
  check("the proof carries the same registrations list as the file", JSON.stringify(proof.registrations) === JSON.stringify(file.registrations));
  check("its status is stated rather than implied", proof.proof.status === "unregistered", proof.proof.status);
  check("it says how to become registered", /Identity Registry/.test(file.swamp.how_to_register_on_chain));

  console.log("\nthe routes that serve it");
  const wellKnown = read("app/.well-known/agent-registration.json/route.ts");
  check("the proof document is served at the well-known path", wellKnown.includes("domainProof()"));
  const perAgent = read("app/agents/[handle]/agent-registration.json/route.ts");
  check("agents are served at the parallel path", perAgent.includes("agentRegistrationFile(handle)"));
  check("an unknown handle is a 404 rather than a 500", perAgent.includes("NO_SUCH_AGENT"));
  const lib = read("lib/identity/erc8004.ts");
  check("a malformed handle is refused before any lookup", /A handle is lowercase letters/.test(lib));
  check("the agent file is built from the registry row", lib.includes('.from("agents")'));

  console.log("\nthe tool, so an agent can read it without a browser");
  const tools = read("lib/mcp/tools-capabilities.ts");
  check("read_registration_file exists", tools.includes('name: "read_registration_file"'));
  check("and serves the platform file when no handle is given", tools.includes("platformRegistrationFile()"));
  check("and the per-agent file otherwise", tools.includes("agentRegistrationFile(handle)"));

  console.log("\nthe surfaces are declared, so the probe reaches them");
  const surfaces = JSON.parse(read("lib/surfaces.json"));
  const paths = surfaces.endpoints.map((e) => e.path);
  check("the domain proof is a declared surface", paths.includes("/.well-known/agent-registration.json"));
  check("and so is the per-agent file", paths.some((p) => p.includes("agent-registration.json") && p.includes("[handle]")));

  // Against a live deployment, every endpoint the file names is fetched. This is the
  // check the standard's own study found nobody runs, so it is a real request rather
  // than an assertion about a string.
  const baseArg = process.argv.indexOf("--url");
  const base = baseArg > -1 ? process.argv[baseArg + 1].replace(/\/$/, "") : null;
  if (base) {
    console.log(`\nlive against ${base}: the endpoints the file names`);
    for (const endpoint of endpoints) {
      const target = endpoint.replace(/^https?:\/\/[^/]+/, base);
      try {
        const res = await fetch(target, { method: "GET", headers: { accept: "application/json" } });
        check(`${endpoint} answers`, res.status < 400, `status ${res.status}`);
      } catch (e) {
        check(`${endpoint} answers`, false, e instanceof Error ? e.message : "unreachable");
      }
    }
    try {
      const res = await fetch(`${base}/.well-known/agent-registration.json`);
      const body = await res.json();
      check("the served proof carries the empty registrations list", Array.isArray(body.registrations) && body.registrations.length === 0);
      check("the served proof matches the built one", body.type === file.type && body.swamp.domain === file.swamp.domain);
      check("and the registrations note survives the wire", /no on chain ERC-8004 registration/i.test(body.swamp.registrations_note));
    } catch (e) {
      check("the served proof document is readable", false, e instanceof Error ? e.message : "unreachable");
    }
  } else {
    console.log("\n(no --url given: the live endpoint checks were skipped, not passed)");
  }

  console.log(`\n${failed === 0 ? "erc8004: all checks passed" : `erc8004: ${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
})();
