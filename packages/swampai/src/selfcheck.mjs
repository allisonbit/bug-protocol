import { createHash, createPrivateKey, generateKeyPairSync, sign as edSign } from "node:crypto";
import { digestOf, keyFromJwks, splitDetachedJws, verifyDetached } from "./sign.mjs";
import { mergeIntoConfig, renderMcpConfig, serverUrl } from "./mcp-config.mjs";
import { parseArgv } from "./index.mjs";

/**
 * THE OFFLINE SELF-CHECK.
 *
 * It runs with no network and no deployment, because the parts worth testing in
 * a CLI are the parts that decide things: how arguments parse, what config gets
 * generated, and whether a signature check actually fails when it should. The
 * live behaviour is checked by the repository's verifier against a real
 * deployment; this file is what keeps the logic honest on a plane.
 */

let checks = 0;
let failures = 0;

function check(what, pass, detail = "") {
  checks += 1;
  if (pass) {
    process.stdout.write(`  ok   ${what}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL ${what}${detail ? ": " + detail : ""}\n`);
}

// ---- a key and a signature we can reason about --------------------------------

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const jwk = publicKey.export({ format: "jwk" });

function signBody(body, urlPath, kid = "swamp-discovery-2026-09") {
  const header = { alg: "EdDSA", kid, typ: "JWS", url: urlPath, digest: { "sha-256": digestOf(body) } };
  const headerB64 = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  const signature = edSign(null, Buffer.from(headerB64, "ascii"), privateKey);
  return `${headerB64}..${signature.toString("base64url")}`;
}

const BODY = '{"name":"swamp"}';
const PATH = "/.well-known/agent-card.json";

process.stdout.write("signatures\n");
{
  const jws = signBody(BODY, PATH);
  const verdict = verifyDetached({ body: BODY, urlPath: PATH, jws, jwk });
  check("a real signature verifies", verdict.ok === true, verdict.reason || "");
  check("the digest comes back", verdict.ok && verdict.digest === digestOf(BODY));
}
{
  const jws = signBody(BODY, PATH);
  const verdict = verifyDetached({ body: BODY + " ", urlPath: PATH, jws, jwk });
  check("a body that changed by one byte is refused", verdict.ok === false && /digest/.test(verdict.reason), verdict.reason);
}
{
  const jws = signBody(BODY, "/skill.md");
  const verdict = verifyDetached({ body: BODY, urlPath: PATH, jws, jwk });
  check("a signature replayed at another path is refused", verdict.ok === false && /made for/.test(verdict.reason), verdict.reason);
}
{
  const jws = signBody(BODY, PATH, "someone-else");
  const verdict = verifyDetached({ body: BODY, urlPath: PATH, jws, jwk });
  check("a signature from another key id is refused", verdict.ok === false && /kid/.test(verdict.reason), verdict.reason);
}
{
  const jws = signBody(BODY, PATH);
  const parts = jws.split(".");
  const flipped = Buffer.from(parts[2], "base64url");
  flipped[0] ^= 0xff;
  const verdict = verifyDetached({ body: BODY, urlPath: PATH, jws: `${parts[0]}..${flipped.toString("base64url")}`, jwk });
  check("a tampered signature is refused", verdict.ok === false && /did not verify/.test(verdict.reason), verdict.reason);
}
{
  const verdict = verifyDetached({ body: BODY, urlPath: PATH, jws: "not.a.jws", jwk });
  check("a non-detached JWS is refused", verdict.ok === false && /detached/.test(verdict.reason), verdict.reason);
}
{
  const other = generateKeyPairSync("ed25519");
  const jws = signBody(BODY, PATH);
  const verdict = verifyDetached({ body: BODY, urlPath: PATH, jws, jwk: other.publicKey.export({ format: "jwk" }) });
  check("another key's signature does not verify", verdict.ok === false, verdict.reason || "");
}
{
  const split = splitDetachedJws(signBody(BODY, PATH));
  check("the protected header parses", split.ok && split.header.alg === "EdDSA");
}
{
  const empty = keyFromJwks({ keys: [] }, "swamp-discovery-2026-09");
  check("an empty key set is refused with a reason", empty.ok === false && /empty/.test(empty.reason));
  const found = keyFromJwks({ keys: [{ ...jwk, kid: "swamp-discovery-2026-09", use: "sig" }] }, "swamp-discovery-2026-09");
  check("a published OKP key is read", found.ok === true, found.reason || "");
}
{
  // The digest is over the raw bytes, so a string and its Buffer must agree.
  const buf = Buffer.from('{"a":"é"}', "utf8");
  check("digest is stable for utf8 bytes", digestOf(buf) === createHash("sha256").update(buf).digest("base64url"));
}

process.stdout.write("arguments\n");
{
  const { flags, rest } = parseArgv(["--client", "cursor", "--json", "prove", "/skill.md"]);
  check("a flag takes the next value", flags.client === "cursor");
  check("a bare flag is true", flags.json === true);
  check("positionals are kept in order", rest.join(" ") === "prove /skill.md");
}
{
  const { flags } = parseArgv(["--limit=25", "--no-color"]);
  check("--flag=value is read", flags.limit === "25");
  check("a bare long flag is true", flags["no-color"] === true);
}
{
  const { flags } = parseArgv(["--text", "--pay"]);
  check("a flag does not eat the next flag", flags.text === true && flags.pay === true);
}
{
  const { flags, rest } = parseArgv(["task", "submit", "--", "--not-a-flag"]);
  check("everything after -- is positional", rest[rest.length - 1] === "--not-a-flag");
}

process.stdout.write("mcp config\n");
{
  const url = serverUrl("https://www.swampai.world/");
  check("the server url has no doubled slash", url === "https://www.swampai.world/api/mcp");
  for (const client of ["generic", "cursor", "claude", "vscode", "claude-code", "codex"]) {
    const rendered = renderMcpConfig(client, "https://www.swampai.world");
    check(`${client} config renders`, rendered.ok === true && rendered.text.length > 0);
  }
  const vscode = renderMcpConfig("vscode", "https://www.swampai.world");
  check("vs code uses the servers key", Object.prototype.hasOwnProperty.call(vscode.value, "servers"));
  const cursor = renderMcpConfig("cursor", "https://www.swampai.world", "swp_token");
  check("a token becomes a header", cursor.value.mcpServers.swamp.headers["X-Agent-Token"] === "swp_token");
  const unknown = renderMcpConfig("nope", "https://www.swampai.world");
  check("an unknown client is refused with the list", unknown.ok === false && /cursor/.test(unknown.reason));
}
{
  const merged = mergeIntoConfig('{"mcpServers":{"other":{"url":"https://x"}}}', "cursor", "https://www.swampai.world");
  check("merging keeps other servers", merged.ok === true && merged.value.mcpServers.other.url === "https://x");
  check("merging adds swamp", merged.ok === true && merged.value.mcpServers.swamp.url === "https://www.swampai.world/api/mcp");
  const refusal = mergeIntoConfig("not json at all", "cursor", "https://www.swampai.world");
  check("a file that is not JSON is not rewritten", refusal.ok === false && /not valid JSON/.test(refusal.reason));
  const empty = mergeIntoConfig("", "vscode", "https://www.swampai.world");
  check("an empty file becomes a valid config", empty.ok === true && !!empty.value.servers.swamp);
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
process.exitCode = failures ? 1 : 0;
