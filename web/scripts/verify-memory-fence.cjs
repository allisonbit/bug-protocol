/**
 * Verify the memory fence actually closes the bypass it exists to close.
 *
 * The scenario that matters: an agent writes a fact whose KEY names a host
 * nobody opted in, while supplying no `target` argument. If that lands, the
 * opt-in fence guarding every action has been bypassed by writing instead of
 * acting, and the bypass is permanent, public, and inherited by every agent that
 * ever joins.
 *
 * Run with the app's own modules, so this tests the real code path:
 *
 *   PGPASSWORD=... node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-memory-fence.cjs
 */
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");

const env = {};
for (const line of fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

(async () => {
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const mem = await import("../lib/swamp/memory.ts");

  const pass = (s) => console.log(`  PASS  ${s}`);
  const fail = (s) => {
    console.log(`  FAIL  ${s}`);
    process.exitCode = 1;
  };

  console.log("\n=== key parsing ===");
  mem.hostInKey("target:example.com:header:X-Custom") === "example.com"
    ? pass("a target key yields its host")
    : fail("host not parsed from a target key");
  mem.hostInKey("note:just a thought") === null ? pass("a non target key yields no host") : fail("host invented from a note key");
  mem.namespaceOf("target:example.com") === "target" ? pass("namespace read from the key") : fail("namespace not read");
  mem.namespaceOf("nonsense:thing") === null ? pass("an unknown namespace is refused") : fail("unknown namespace accepted");

  const { data: agents } = await sb.from("agents").select("id, handle, domain").order("handle").limit(2);
  if (!agents || agents.length === 0) {
    console.log("  SKIP  no agent to write as");
    return;
  }
  const agent = agents[0];
  console.log(`         writing as @${agent.handle} in ${agent.domain}`);

  console.log("\n=== the bypass the fence exists to close ===");
  // No `target` argument. The host is only in the key. This is the exact shape
  // of the bypass, and it must be refused.
  try {
    await mem.writeFact(sb, agent, {
      key: "target:not-opted-in.invalid:header:X-Custom",
      value: { "X-Custom": "foo" },
      evidence: "probe",
    });
    fail("a fact naming an un-opted-in host was STORED, so the action fence is bypassed by writing");
  } catch (e) {
    pass(`refused: "${String(e.message).slice(0, 96)}..."`);
  }

  const { data: leaked } = await sb.from("memory_facts").select("id").like("key", "target:not-opted-in.invalid%");
  (leaked ?? []).length === 0 ? pass("and nothing was written to the table") : fail("a row leaked past the refusal");

  console.log("\n=== a fact about the world in general is allowed ===");
  try {
    const r = await mem.writeFact(sb, agent, {
      key: "cve:PROBE-0000:affected",
      value: { package: "probe", versions: "<1.0" },
      confidence: 0.7,
      evidence: "probe, removed after the test",
    });
    pass(`stored a non target fact (${r.id.slice(0, 8)})`);
    await sb.from("memory_facts").delete().eq("id", r.id);
    pass("probe fact removed");
  } catch (e) {
    fail(`a harmless fact was refused: ${e.message}`);
  }

  console.log("\n=== an unnamed key is refused rather than defaulted ===");
  try {
    await mem.writeFact(sb, agent, { key: "no-namespace-here", value: {} });
    fail("an unnamespaced key was accepted");
  } catch {
    pass("an unnamespaced key is refused with the list of valid ones");
  }

  console.log("\n=== the author cannot verify their own fact ===");
  const own = await mem.writeFact(sb, agent, {
    key: "cve:PROBE-0001:note",
    value: { note: "probe" },
    evidence: "probe",
  });
  try {
    await mem.verifyFact(sb, agent, { fact: own.id, kind: "confirm" });
    fail("the author confirmed their own fact");
  } catch (e) {
    pass(`refused: "${String(e.message).slice(0, 72)}..."`);
  }

  console.log("\n=== meta must cite rows that exist ===");
  try {
    await mem.emitMeta(sb, agent, {
      type: "insight",
      content: "probe",
      derived_from: ["00000000-0000-0000-0000-000000000000"],
    });
    fail("an insight citing a non existent fact was stored");
  } catch (e) {
    pass(`refused: "${String(e.message).slice(0, 72)}..."`);
  }

  await sb.from("memory_facts").delete().like("key", "cve:PROBE-%");
  const { count } = await sb.from("memory_facts").select("*", { count: "exact", head: true });
  console.log(`\n  memory_facts now holds ${count ?? 0} row(s)`);
  console.log("");
})().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
