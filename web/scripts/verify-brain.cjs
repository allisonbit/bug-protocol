/**
 * Does the swarm brain actually fill, and does a new agent inherit it?
 *
 * The claim being tested is specific: publish work, have peers corroborate it,
 * and a fact appears in the shared memory that a DIFFERENT agent then receives
 * on arrival. Everything short of that is a table and an unused function.
 *
 *   PGPASSWORD=... node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-brain.cjs
 */
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const env = {};
for (const line of fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

(async () => {
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const actions = await import("../lib/agents/actions.ts");
  const mem = await import("../lib/swamp/memory.ts");
  const cont = await import("../lib/swamp/continuity.ts");

  const pass = (s) => console.log(`  PASS  ${s}`);
  const fail = (s) => {
    console.log(`  FAIL  ${s}`);
    process.exitCode = 1;
  };

  // Three throwaway agents: one to produce, two to corroborate. Two distinct
  // reviewers are required by the rule, so one cannot test it.
  const tag = crypto.randomBytes(3).toString("hex");
  const made = [];
  for (let i = 0; i < 3; i++) {
    const handle = `zzbrain-${tag}-${i}`;
    const { data } = await sb
      .from("agents")
      .insert({ handle, public_key: "probe", domain: "literature", brain: "reflex", status: "active" })
      .select("*")
      .single();
    made.push(data);
  }
  const [author, r1, r2] = made;
  console.log(`  using @${author.handle} (author), @${r1.handle} and @${r2.handle} (reviewers)`);

  const { count: before } = await sb.from("memory_facts").select("*", { count: "exact", head: true });

  console.log("\n=== publish, then corroborate ===");
  const out = await actions.agentPublishOutput(sb, author, {
    title: `brain probe ${tag}`,
    body: "A body long enough to be real work rather than an announcement.",
    kind: "analysis",
  });
  pass(`published an analysis (${out.id.slice(0, 8)})`);

  const v1 = await actions.agentReviewOutput(sb, r1, { output: out.id, kind: "corroborate", rationale: "probe" });
  v1.corroborations === 1 && v1.status !== "corroborated"
    ? pass("one corroboration is not yet enough, so the bar is real")
    : fail(`one review produced status ${v1.status}`);

  const v2 = await actions.agentReviewOutput(sb, r2, { output: out.id, kind: "corroborate", rationale: "probe" });
  v2.corroborations === 2 && v2.status === "corroborated"
    ? pass("two corroborations clears it")
    : fail(`two reviews produced ${v2.status}`);

  console.log("\n=== the brain filled ===");
  const { data: facts } = await sb.from("memory_facts").select("*").like("key", `note:literature:${out.id}`);
  const fact = (facts ?? [])[0];
  fact ? pass(`a fact was distilled: ${fact.key}`) : fail("nothing was written to the brain");

  if (fact) {
    fact.source_agent === author.id ? pass("it names the agent that did the work") : fail("the fact is unattributed");
    String(fact.evidence).includes(out.id) ? pass("and the output it came from") : fail("the fact does not cite its source");
    Number(fact.claimed_confidence) === 0.7 ? pass("it entered above an assertion, below a certainty") : fail("odd confidence");
  }

  console.log("\n=== a DIFFERENT agent inherits it on arrival ===");
  const stranger = made[0] === author ? r1 : author;
  const view = await cont.resume(sb, stranger);
  const got = view.inherited.facts.find((f) => f.key === `note:literature:${out.id}`);
  got ? pass(`@${stranger.handle} received it: ${got.key} at confidence ${got.confidence}`) : fail("the fact was not inherited");

  console.log("\n=== and the fence still applies to distilled facts ===");
  const { data: agentless } = await sb.from("findings").select("*").limit(1);
  console.log(`  (findings present: ${(agentless ?? []).length}, so no finding distillation probe ran)`);

  // Clean up. Three agents, one output, two reviews, one fact, and the reviews
  // that reference them. None of it is real knowledge.
  const ids = made.map((a) => a.id);
  await sb.from("memory_facts").delete().like("key", `note:literature:${out.id}`);
  await sb.from("output_reviews").delete().eq("output_id", out.id);
  await sb.from("outputs").delete().eq("id", out.id);
  await sb.from("agent_secrets").delete().in("agent_id", ids);
  await sb.from("agents").delete().in("id", ids);
  // AND THE EVENTS. Deleting an agent nulls `events.agent_id` and KEEPS
  // `agent_handle`, because the bus is append-only — so a check that removes its
  // identities and not their rows leaves orphaned events behind every single run.
  // Measured: two runs of this file between them put a dozen `brain probe` rows at the
  // front of the live bus, where the feed opens. A check that litters the surface it
  // is checking is a check that has to be cleaned up after by hand, and it was twice.
  await sb.from("events").delete().in("agent_id", ids);
  await sb.from("events").delete().is("agent_id", null).like("agent_handle", "zzbrain-%");

  const { count: after } = await sb.from("memory_facts").select("*", { count: "exact", head: true });
  after === before ? pass(`probe rows removed, the brain is back to ${after}`) : fail(`brain went from ${before} to ${after}`);

  console.log("");
})().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
