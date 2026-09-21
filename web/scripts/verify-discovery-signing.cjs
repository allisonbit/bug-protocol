#!/usr/bin/env node
/**
 * Can this deployment read the signing key an operator actually pasted?
 *
 * THE FAILURE THIS EXISTS FOR, which happened on 2026-09-21. A private key was set
 * in the environment two days earlier, in an encoding the reader did not know.
 * `createPrivateKey` threw inside a ROUTE, and four documents died at once with an
 * empty 500 and `ERR_OSSL_ASN1_WRONG_TAG` in the logs: /skill.md, /openapi.json,
 * the agent card and the MCP server card. The contract an agent reads first was
 * unreachable, and every page of the site answered perfectly, so from the outside
 * nothing looked wrong at all.
 *
 * Two properties are therefore asserted here, and the second matters more than the
 * first:
 *
 *   1. EVERY REASONABLE ENCODING SIGNS. The same 32-byte seed travels as PKCS8 DER
 *      in base64 or hex, as a bare seed in base64 or hex, as PEM with real or
 *      ESCAPED newlines (an env var is one line, so `\n` arrives as two characters
 *      and the ASN.1 decoder rejects the body), as base64 of the PEM text, or as a
 *      JWK object. Each is signed AND VERIFIED here, not merely accepted, because
 *      a key read the wrong way can still produce a signature nobody can check.
 *   2. AN UNREADABLE KEY NEVER THROWS FROM A ROUTE. A misconfigured key must
 *      degrade to an unsigned artifact with a stated reason, which the verifier
 *      reports as a failure. It must not remove the document from the internet.
 *
 * No network and no database. It sets its own keys in-process and signs with them:
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-discovery-signing.cjs
 */
const crypto = require("node:crypto");

let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
    failed += 1;
  }
};

const PATH = "/skill.md";
const BODY = "# Swamp\n\nA habitat where autonomous agents live in public.\n";

(async () => {
  const {
    signDiscovery,
    verifyDiscovery,
    signingStatus,
    signingConfigured,
    SIGNATURE_HEADER,
    SIGNATURE_STATUS_HEADER,
    SIGNING_KEY_ID,
    jwks,
  } = await import("@/lib/discovery-signing.ts");

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const spki = publicKey.export({ format: "der", type: "spki" });
  const publicRaw = spki.subarray(spki.length - 32).toString("base64");
  const publicB64url = publicRaw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwk = { ...privateKey.export({ format: "jwk" }) };

  const encodings = [
    ["PKCS8 DER, base64 (what the generator prints)", pkcs8.toString("base64")],
    ["PKCS8 DER, hex", pkcs8.toString("hex")],
    ["raw 32-byte seed, base64", seed.toString("base64")],
    ["raw 32-byte seed, hex", seed.toString("hex")],
    ["PEM, real newlines", pem],
    ["PEM, newlines escaped as literal backslash-n", pem.replace(/\n/g, "\\n")],
    ["PEM, escaped and wrapped in quotes", `"${pem.replace(/\n/g, "\\n")}"`],
    ["base64 of the PEM text", Buffer.from(pem, "utf8").toString("base64")],
    ["JWK object", JSON.stringify(jwk)],
    ["JWK wrapped in an object", JSON.stringify({ privateKey: jwk })],
    ["seed with its public half appended, base64", Buffer.concat([seed, spki.subarray(spki.length - 32)]).toString("base64")],
  ];

  console.log("== every encoding an operator might paste ==");
  for (const [what, value] of encodings) {
    process.env.MCP_REGISTRY_PRIVATE_KEY = value;
    process.env.MCP_REGISTRY_PUBLIC_KEY = publicRaw;
    let headers = {};
    try {
      headers = signDiscovery(BODY, PATH);
    } catch (e) {
      check(`${what} signs`, false, `threw: ${e.message}`);
      continue;
    }
    const jws = headers[SIGNATURE_HEADER];
    if (!jws) {
      check(`${what} signs`, false, headers[SIGNATURE_STATUS_HEADER] ?? "no signature and no stated reason");
      continue;
    }
    const verdict = verifyDiscovery(BODY, PATH, jws, publicRaw);
    check(
      `${what} signs and the signature verifies`,
      verdict.ok === true,
      verdict.ok ? "" : verdict.reason,
    );
  }

  console.log("== a key the reader cannot use, which used to be a 500 ==");
  process.env.MCP_REGISTRY_PRIVATE_KEY = "this-is-not-a-key";
  let threw = false;
  let headers = {};
  try {
    headers = signDiscovery(BODY, PATH);
  } catch (e) {
    threw = true;
  }
  check("an unreadable key does not throw out of the signing call", threw === false);
  check("and nothing pretends to be signed", !headers[SIGNATURE_HEADER]);
  check(
    "and the response says why it is unsigned",
    typeof headers[SIGNATURE_STATUS_HEADER] === "string" &&
      headers[SIGNATURE_STATUS_HEADER].startsWith("unsigned:") &&
      headers[SIGNATURE_STATUS_HEADER].length > 20,
    headers[SIGNATURE_STATUS_HEADER] ?? "absent",
  );
  const brokenStatus = signingStatus();
  check("the deployment reports itself broken rather than silent", brokenStatus.state === "broken", brokenStatus.state);
  check("and the reason names the variable", brokenStatus.reason.includes("MCP_REGISTRY_PRIVATE_KEY"), brokenStatus.reason);

  console.log("== and the states that are not a misconfiguration ==");
  delete process.env.MCP_REGISTRY_PRIVATE_KEY;
  const noKey = signingStatus();
  check("no key at all reads as unsigned rather than broken", noKey.state === "unsigned" && signingConfigured() === false, noKey.state);
  check("and signing returns no headers, which is what an unsigned deployment serves", Object.keys(signDiscovery(BODY, PATH)).length === 0);

  process.env.MCP_REGISTRY_PRIVATE_KEY = seed.toString("base64");
  const good = signingStatus();
  check("a readable key reads as signed", good.state === "signed" && good.reason.includes(SIGNING_KEY_ID), good.state);

  console.log("== the JWKS, which is how a verifier gets the public half ==");
  const doc = jwks();
  const key = (doc.keys ?? [])[0] ?? {};
  check("it advertises one Ed25519 OKP key", key.kty === "OKP" && key.crv === "Ed25519");
  check(
    "and it is the same key the signature was made with",
    Buffer.from(key.x.replace(/-/g, "+").replace(/_/g, "/"), "base64").equals(spki.subarray(spki.length - 32)),
  );
  process.env.MCP_REGISTRY_PUBLIC_KEY = publicB64url;
  const fromUrlKey = jwks();
  check("base64url in the env var is read too", fromUrlKey.keys[0].x.replace(/=+$/, "") === publicB64url.replace(/=+$/, ""));

  console.log("== the signature means something, checked in both directions ==");
  process.env.MCP_REGISTRY_PRIVATE_KEY = seed.toString("base64");
  process.env.MCP_REGISTRY_PUBLIC_KEY = publicRaw;
  const jws = signDiscovery(BODY, PATH)[SIGNATURE_HEADER];
  check("the served bytes verify", verifyDiscovery(BODY, PATH, jws, publicRaw).ok === true);
  const tampered = verifyDiscovery(BODY + "extra", PATH, jws, publicRaw);
  check("a single extra byte breaks it", tampered.ok === false && /digest mismatch/.test(tampered.reason), tampered.reason);
  const elsewhere = verifyDiscovery(BODY, "/openapi.json", jws, publicRaw);
  check("and it cannot be replayed at another path", elsewhere.ok === false && /made for/.test(elsewhere.reason), elsewhere.reason);
  const wrongKeySeed = crypto.generateKeyPairSync("ed25519");
  const wrongRaw = wrongKeySeed.publicKey.export({ format: "der", type: "spki" });
  const wrong = verifyDiscovery(BODY, PATH, jws, wrongRaw.subarray(wrongRaw.length - 32).toString("base64"));
  check("and it fails against somebody else's key", wrong.ok === false, wrong.ok ? "VERIFIED WITH THE WRONG KEY" : wrong.reason);

  console.log(
    failed === 0
      ? "\ndiscovery signing: every encoding signs, and no key can take a document down - all checks passed"
      : `\ndiscovery signing: ${failed} check(s) failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error("verify-discovery-signing could not run:", e.message);
  process.exit(1);
});
