/**
 * The 2026-07-28 revision, identity, binding and payment: what was claimed, checked.
 *
 * WHY THIS FILE EXISTS. Four separate things landed at once, and three of them are
 * claims about compatibility rather than behaviour anybody can see:
 *
 *   1. This server says it speaks MCP 2026-07-28 while still serving 2025-06-18 as
 *      deprecated. If a field name here is wrong, no local test fails, because
 *      nothing local reads the spec: a real client just quietly misbehaves. So every
 *      name the spec fixes is asserted from the module that emits it.
 *   2. The DID documents are published at paths a resolver derives from the
 *      identifier. A typo in a directory name produces a 404 nobody notices until an
 *      outside checker says the identity does not exist, so the paths are asserted
 *      against the DID strings themselves.
 *   3. The task binding is recorded as the RESULT of a check. A verifier signing a
 *      real message and confirming both outcomes (right key, wrong key) is the only
 *      way to know the recorded field means what it says.
 *   4. A payment door that accepts what it should not is worse than one that does
 *      not exist, so every refusal branch of the pure check is exercised, including
 *      the fail-closed case with no address configured.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-mcp-2026.cjs
 */
const fs = require("fs");
const path = require("path");

(async () => {
  const protocol = await import("../lib/mcp/protocol.ts");
  const tasks = await import("../lib/mcp/tasks.ts");
  const identity = await import("../lib/identity/did.ts");
  const binding = await import("../lib/identity/binding.ts");
  const x402 = await import("../lib/payments/x402.ts");
  const app = await import("../lib/mcp/app.ts");
  const crypto = await import("../lib/agents/crypto.ts");
  const ed = await import("@noble/ed25519");
  const { sha512 } = await import("@noble/hashes/sha2");
  const { concatBytes, utf8ToBytes, bytesToHex } = await import("@noble/hashes/utils");

  // noble's sync API needs a sha512 wired in, exactly as lib/agents/crypto.ts does.
  ed.etc.sha512Sync = (...m) => sha512(concatBytes(...m));

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else {
      console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
      failed += 1;
    }
  };
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

  console.log("\nprotocol revisions");
  check("leads with 2026-07-28", protocol.PROTOCOL_2026 === "2026-07-28", protocol.PROTOCOL_2026);
  check("serves 2025-06-18 as deprecated", protocol.isDeprecated("2025-06-18"));
  check("2026-07-28 is not deprecated", !protocol.isDeprecated("2026-07-28"));
  const deprecated = protocol.PROTOCOL_REVISIONS.find((r) => r.status === "deprecated");
  check("deprecation states a removal date", deprecated?.removalNotBefore === "2027-07-28", deprecated?.removalNotBefore);
  check(
    "negotiation prefers the header",
    protocol.negotiateProtocol({ header: "2025-06-18", metaVersion: "2026-07-28" }) === "2025-06-18",
  );
  check(
    "negotiation falls back to _meta",
    protocol.negotiateProtocol({ header: null, metaVersion: "2025-06-18" }) === "2025-06-18",
  );
  check("negotiation defaults to the current revision", protocol.negotiateProtocol({}) === protocol.PROTOCOL_2026);

  console.log("\nself-contained requests");
  const meta = {
    "io.modelcontextprotocol/clientInfo": { name: "probe", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/tasks": {} } },
  };
  const client = protocol.clientFromMeta(meta, null);
  check("client identity is read from _meta", client?.name === "probe", JSON.stringify(client));
  check("task support is read from declared extensions", protocol.clientSupportsTasks(client));
  check("a client with no identity has no task support", !protocol.clientSupportsTasks(null));

  console.log("\nresult shapes");
  const capabilityShape = protocol.serverCapabilities();
  check("tasks extension is advertised", Boolean(capabilityShape.extensions["io.modelcontextprotocol/tasks"]));
  check("apps extension is advertised", Boolean(capabilityShape.extensions["io.modelcontextprotocol/apps"]));
  const discover = protocol.discoverPayload({ server: { name: "x" }, instructions: "y" });
  check("discovery carries a result discriminator", discover.resultType === "complete", discover.resultType);
  check("discovery carries a cache lifetime", typeof discover.ttlMs === "number");
  check("discovery carries a cache scope", discover.cacheScope === "public");
  const complete = protocol.completeResult({ content: [{ type: "text", text: "hi" }] });
  check("a complete result is discriminated", complete.resultType === "complete");
  const asked = protocol.ask({ key: "url", question: "?", field: "url", description: "target" });
  const elicitation = asked.inputRequests.url;
  check("MRTR uses the elicitation method", elicitation.method === "elicitation/create", elicitation.method);
  check("MRTR asks with a schema", elicitation.params.requestedSchema?.properties?.url?.type === "string");
  const elicitationResult = protocol.inputRequiredResult(asked);
  check("an input_required result is discriminated", elicitationResult.resultType === "input_required");
  const task = protocol.taskResult({ taskId: "abc", status: "working" });
  check("a task result is discriminated", task.resultType === "task");
  check("a task result carries a handle", task.task.taskId === "abc");
  check("a task result carries a poll interval", task.task.pollInterval === protocol.TASK_POLL_MS);
  check("terminal states are immutable in the model", protocol.isTerminal("completed") && protocol.isTerminal("cancelled") && !protocol.isTerminal("working"));

  console.log("\ntask states translate, they are not invented");
  check("submitted is working to a polling client", tasks.taskStatusOf("submitted") === "working");
  check("working stays working", tasks.taskStatusOf("working") === "working");
  check("the queue's canceled becomes the extension's cancelled", tasks.taskStatusOf("canceled") === "cancelled");
  check("failed stays failed", tasks.taskStatusOf("failed") === "failed");
  const unmapped = tasks.taskStatusOf("something-new");
  check("an unknown queue state is not reported as finished", !protocol.isTerminal(unmapped), unmapped);

  console.log("\nidentity documents resolve where the DID says they do");
  const host = identity.didHost();
  check("the host has no scheme", !host.includes("://"), host);
  const platformDid = identity.platformDid();
  check("the platform DID is did:web on this host", platformDid === `did:web:${host}`, platformDid);
  check("an agent DID nests under the platform", identity.agentDid("atlas") === `${platformDid}:agents:atlas`, identity.agentDid("atlas"));
  check("handles are lowercased into the DID", identity.agentDid("ATLAS") === identity.agentDid("atlas"));
  check("did:web is served at the well-known path the method requires", fs.existsSync(path.join(__dirname, "..", "app", ".well-known", "did.json", "route.ts")));
  check("an agent's did:web document is served at agents/<handle>/did.json", fs.existsSync(path.join(__dirname, "..", "app", "agents", "[handle]", "did.json", "route.ts")));
  const platformDoc = identity.platformDidDocument();
  check("the platform document names itself", platformDoc.id === platformDid, String(platformDoc.id));
  check(
    "the platform document never publishes a key it cannot have",
    Array.isArray(platformDoc.verificationMethod) || typeof platformDoc.note === "string",
  );
  if (Array.isArray(platformDoc.verificationMethod)) {
    const vm = platformDoc.verificationMethod[0];
    check("the platform key is an Ed25519 JWK", vm.publicKeyJwk?.kty === "OKP" && vm.publicKeyJwk?.crv === "Ed25519");
    check("the platform key is also published as multibase", /^z/.test(String(vm.publicKeyMultibase ?? "")));
    check("the assertion method points at that key", platformDoc.assertionMethod?.[0] === vm.id);
  }
  const bad = await identity.agentDidDocument("not a handle!");
  check("a malformed handle is refused before any lookup", bad.ok === false && bad.status === 400, JSON.stringify(bad));

  // The selector in the identity module against the schema it reads. A column named in
  // a Supabase select that does not exist is a runtime 500 on a document an outside
  // checker fetches, and the client at that boundary is untyped, so nothing else here
  // would catch it. This is the check that would have: `registered_at` was asked for
  // and has never existed in this database.
  const schema = read("supabase/swamp.sql");
  const agentsBlock = schema.slice(
    schema.indexOf("public.agents"),
    schema.indexOf("public.agents") + schema.slice(schema.indexOf("public.agents")).indexOf("\n);"),
  );
  const didSource = read("lib/identity/did.ts");
  const selector = (didSource.match(/\.from\("agents"\)\s*\.select\("([^"]+)"\)/) ?? [])[1] ?? "";
  const selectedColumns = selector.split(",").map((c) => c.trim()).filter(Boolean);
  const missingColumns = selectedColumns.filter((c) => !new RegExp(`\\b${c}\\b`).test(agentsBlock));
  check(
    "every column the identity document reads exists in the agents table",
    selectedColumns.length > 0 && missingColumns.length === 0,
    missingColumns.length ? `not in the schema: ${missingColumns.join(", ")}` : `selector: ${selector}`,
  );

  console.log("\ntask binding");
  const signed = binding.taskBindingMessage({ caller: "atlas", text: "check the pump", externalId: null });
  check("the signed bytes are canonical JSON", signed === '{"caller":"atlas","external_id":null,"text":"check the pump"}', signed);
  check("the same task signs to the same bytes", signed === binding.taskBindingMessage({ caller: "atlas", text: "check the pump" }));
  check("a different text signs to different bytes", signed !== binding.taskBindingMessage({ caller: "atlas", text: "check the valve" }));
  check("a binding needs a 65 byte signature", binding.bindingOf({ binding: { signature: "0x" + "ab".repeat(65), keyId: "k" } }) === "invalid");
  check("a malformed binding is refused, not ignored", binding.bindingOf({ binding: { signature: "nope", keyId: "k" } }) === "invalid");
  check("an absent binding is allowed", binding.bindingOf({}) === null);
  const shortSig = binding.bindingOf({ binding: { signature: "ab".repeat(64), keyId: "agent-signing-key" } });
  check("a well-formed binding is accepted", shortSig && shortSig.keyId === "agent-signing-key");

  const kp = crypto.generateKeypair();
  const sigHex = bytesToHex(await ed.signAsync(utf8ToBytes(signed), kp.privateKey));
  const fakeSb = (row) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }),
  });
  const good = await binding.verifyTaskBinding({
    sb: fakeSb({ handle: "atlas", public_key: kp.publicKey }),
    caller: "atlas",
    text: "check the pump",
    externalId: null,
    binding: { signature: sigHex, keyId: "agent-signing-key" },
  });
  check("a real signature verifies", good.verified === true, String(good.reason));
  check(
    "a verified binding records the digest of the signed bytes",
    good.message_sha256 === crypto.sha256Hex(signed),
    `${good.message_sha256} vs ${crypto.sha256Hex(signed)}`,
  );
  const wrongKey = crypto.generateKeypair();
  const mismatched = await binding.verifyTaskBinding({
    sb: fakeSb({ handle: "atlas", public_key: wrongKey.publicKey }),
    caller: "atlas",
    text: "check the pump",
    externalId: null,
    binding: { signature: sigHex, keyId: "agent-signing-key" },
  });
  check("a signature from another key does not verify", mismatched.verified === false, String(mismatched.verified));
  const stranger = await binding.verifyTaskBinding({
    sb: fakeSb(null),
    caller: "nobody",
    text: "x",
    externalId: null,
    binding: { signature: sigHex, keyId: "agent-signing-key" },
  });
  check("an unregistered caller is recorded as unchecked, not as failed", stranger.verified === null, String(stranger.verified));

  console.log("\nx402 refusals, every branch");
  const previous = { ...process.env };
  delete process.env.X402_PAY_TO;
  const unconfigured = x402.paymentRequirements();
  check("with no address there is no catalogue", unconfigured.accepts.length === 0);
  check("and it says which variable is missing", /X402_PAY_TO/.test(unconfigured.error ?? ""));
  const closed = x402.checkProof({ proof: { x402Version: 1 }, catalogue: unconfigured, nowSeconds: 1 });
  check("with no address every proof is refused", closed.ok === false && closed.code === "NOT_CONFIGURED", closed.code);

  process.env.X402_PAY_TO = "0x1111111111111111111111111111111111111111";
  delete process.env.X402_TESTNET;
  const catalogue = x402.paymentRequirements({ amountAtomic: "100000" });
  check("a configured door publishes a catalogue", catalogue.configured === true && catalogue.accepts.length > 0);
  check("testnets are not offered by default", catalogue.accepts.every((a) => !a.network.includes("sepolia")));
  const base = catalogue.accepts.find((a) => a.network === "base");
  check("the requirement names the exact scheme", base.scheme === "exact");
  check("the requirement names a known token address", /^0x[0-9a-fA-F]{40}$/.test(base.asset), base.asset);
  const now = 1_800_000_000;
  const proofOf = (over = {}) => ({
    x402Version: 1,
    scheme: "exact",
    network: "base",
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: {
        from: "0x2222222222222222222222222222222222222222",
        to: "0x1111111111111111111111111111111111111111",
        value: "100000",
        validAfter: now - 60,
        validBefore: now + 60,
        nonce: "0x" + "cd".repeat(32),
        ...over,
      },
    },
  });
  const refused = (proof, code, label) => {
    const r = x402.checkProof({ proof, catalogue, nowSeconds: now });
    check(label, r.ok === false && r.code === code, r.ok === true ? "accepted" : r.code);
  };
  check("a well formed proof passes the pure checks", x402.checkProof({ proof: proofOf(), catalogue, nowSeconds: now }).ok === true);
  refused({ ...proofOf(), x402Version: 2 }, "BAD_VERSION", "a proof from another revision is refused");
  refused({ ...proofOf(), scheme: "upto" }, "BAD_SCHEME", "a scheme this door does not implement is refused");
  refused({ ...proofOf(), network: "robinhood" }, "UNKNOWN_NETWORK", "an unknown network is refused");
  refused({ ...proofOf({ to: "0x3333333333333333333333333333333333333333" }) }, "WRONG_RECIPIENT", "paying somebody else is refused");
  refused({ ...proofOf({ value: "99999" }) }, "UNDERPAID", "underpayment is refused");
  refused({ ...proofOf({ nonce: "0x1234" }) }, "BAD_NONCE", "a short nonce is refused");
  refused({ ...proofOf({ validBefore: now - 1 }) }, "EXPIRED", "an expired authorization is refused");
  refused({ ...proofOf({ validAfter: now + 60 }) }, "NOT_YET_VALID", "an authorization from the future is refused");
  refused({ ...proofOf(), payload: { signature: "0x00", authorization: {} } }, "BAD_SIGNATURE_SHAPE", "a malformed signature is refused");
  const signature = await x402.verifyProofSignature(proofOf({}), "base");
  check("a fabricated signature does not verify against the chain and token", signature.ok === false, signature.reason);
  check("testnet is offered only when asked for", (() => {
    process.env.X402_TESTNET = "1";
    const withTestnet = x402.paymentRequirements();
    delete process.env.X402_TESTNET;
    return withTestnet.accepts.some((a) => a.network === "base-sepolia");
  })());
  check("settlement is off unless enabled", x402.shouldSettle() === false);
  const settlement = await x402.settleViaFacilitator({ proof: proofOf(), requirement: base });
  check("no facilitator means nothing is relayed", settlement.attempted === false && settlement.reason.includes("No facilitator"), String(settlement.reason));
  process.env = previous;

  console.log("\nthe app resource renders the same facts");
  const appHtml = app.habitatAppHtml({
    world: { total: 2, lit: 1, trouble: 1, totals: { agents: 15 }, structures: [{ kind: "machine", zone: "Harbour", floors: 1, lit: true, trouble: false, label: "atlas <b>", cites: "machine", href: "/machines" }] },
    activity: { spans: [{ created_at: "2026-09-21T10:00:00Z", agent_handle: "atlas", payload: { span: { brain: "reflex", "swamp.actions.ran": 1, "gen_ai.usage.input_tokens": 0, "swamp.degraded": "model call failed" } } }] },
    siteUrl: "https://www.swampai.world",
  });
  check("the app is a complete document", appHtml.startsWith("<!doctype html>") && appHtml.trim().endsWith("</html>"));
  check("structure labels are escaped", appHtml.includes("atlas &lt;b&gt;") && !appHtml.includes("atlas <b>"));
  check("the trouble mark is rendered", appHtml.includes("trouble"));
  check("the degraded reason is rendered", appHtml.includes("model call failed"));
  check("the app names the tools its numbers came from", appHtml.includes("read_world") && appHtml.includes("read_activity"));
  const appError = app.habitatAppHtml({ world: null, activity: null, worldError: "backend down", activityError: "backend down", siteUrl: "https://x.test" });
  check("an unreadable world is stated, not rendered as empty", appError.includes("backend down"));
  check("the app URI is published by the protocol module too", protocol.serverCapabilities().extensions["io.modelcontextprotocol/apps"].resources.includes(app.HABITAT_APP_URI));

  console.log("\nwiring, where this class of bug actually ships");
  const mcpRoute = read("app/api/mcp/route.ts");
  check("the route serves server/discover", mcpRoute.includes('case "server/discover"'));
  check("the route reads the protocol version header", mcpRoute.includes('req.headers.get("mcp-protocol-version")'));
  check("an unsupported revision is refused rather than downgraded", mcpRoute.includes("Unsupported protocol revision"));
  check("the route serves the tasks extension methods", ["tasks/get", "tasks/update", "tasks/cancel"].every((m) => mcpRoute.includes(`case "${m}"`)));
  check("initialize is answered and marked deprecated", mcpRoute.includes('case "initialize"') && mcpRoute.includes("use_instead"));
  check("tools/call can return input_required", mcpRoute.includes("inputRequiredResult(") && mcpRoute.includes("missingRequired("));
  check("a declared task client gets a task handle", mcpRoute.includes("env.wantsTasks && name === \"send_task\""));
  check("the app resource is served", mcpRoute.includes("HABITAT_APP_URI") && mcpRoute.includes("habitatAppHtml("));
  check("the tool catalogue carries the cache hints", mcpRoute.includes("...CACHE"));

  const toolsSource = read("lib/mcp/tools.ts");
  check("exactly one tool declares an interface", (toolsSource.match(/_meta: \{ ui: \{ resourceUri: HABITAT_APP_URI \} \}/g) ?? []).length === 1);
  check("the tool that declares it is read_world", /t\.name === "read_world" \? \{ _meta/.test(toolsSource));

  const a2a = read("app/api/a2a/route.ts");
  check("the A2A door verifies a binding before writing", a2a.indexOf("verifyTaskBinding(") < a2a.indexOf('.from("a2a_tasks")'));
  check("the binding record reaches the row", a2a.includes("binding: bindingRecord"));
  check("the binding is served back with the task", a2a.includes("messageSha256"));
  // The invariant is narrower than it used to be, and narrower is stronger. A gated
  // task is written BEFORE any payment exists, on purpose: the caller is quoted terms
  // and the work is held, and nothing is owed yet. What must never happen is a task
  // becoming visible to the swarm, or an existing held task being released, on the
  // strength of a proof that has not been checked. So the assertion is that every
  // write of `state: "submitted"` comes after the verifier ran.
  const paidTaskWrites = [...a2a.matchAll(/state: "submitted"/g)].map((m) => m.index);
  check(
    "no task is queued before its payment is verified",
    paidTaskWrites.length >= 2 && paidTaskWrites.every((i) => i > a2a.indexOf("acceptPayment(")),
    `${paidTaskWrites.length} write(s) of state submitted`,
  );
  check("a gated task is held in input-required, not queued", a2a.includes('state: "input-required"'));
  check("the gate records the terms it quoted", a2a.includes("payment_gate:"));
  check("the extension is activated by its header and echoed", a2a.includes("extensionRequested(req)") && a2a.includes("extensionHeaders(req)"));
  check("the payment is attached to the task it paid for", a2a.includes("bindPaymentToTask("));

  const x402Route = read("app/api/x402/route.ts");
  check("the payment door publishes its catalogue", x402Route.includes("paymentRequirements()"));
  check("the door distinguishes verified from settled", x402Route.includes("settled means a"));
  check("a refusal carries the catalogue with it", x402Route.includes("...paymentRequirements(),\n        error"));

  console.log("\nadvertising, or nobody knows it exists");
  const skill = read("lib/skill.ts");
  check("the contract mentions the new revision", skill.includes("2026-07-28"));
  check("the contract mentions the payment door", skill.includes("/api/x402"));

  console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
