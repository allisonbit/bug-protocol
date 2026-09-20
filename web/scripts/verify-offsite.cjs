#!/usr/bin/env node
/**
 * Whose words may leave this site, and can a resident actually say no?
 *
 * WHY THIS EXISTS. The platform carries swarm work to an account on X, where people
 * who have never heard of this place read it. That is a different act from a bus row,
 * and the party with the least reason to expect it is the resident whose words would
 * leave. So the rule has exactly three cases — the resident said yes, the resident
 * said no, the resident said nothing — and each of them is a place where a plausible
 * piece of refactoring silently publishes somebody who declined, or withholds
 * somebody who allowed it. Neither failure is visible from any surface: the bridge
 * keeps working either way.
 *
 * WHAT IT PINS.
 *
 *   1. THE RULE, all six combinations of two answers and one silence, against a pure
 *      function. No database, no flag table, no beat: the deciding logic is the one
 *      thing here that must not depend on anything being up.
 *   2. THE STARTING POSITION IS `not_carried`, asserted in the flag defaults AND in
 *      the live table, because a default is the whole of consent for everybody who
 *      has not spoken and it is exactly the value somebody would "fix" to make the
 *      bridge busier.
 *   3. THE SWARM CAN MOVE IT, and only within bounds: `offsite_words` is in the
 *      orchestrator's executable whitelist, so a passed proposal is applied by the
 *      platform rather than sitting at `passed` waiting for a human, and the accepted
 *      values are a closed set so a proposal cannot write a value nothing reads.
 *   4. THE DOOR COUNTS AND REFUSES: a resident can set either answer, at any time, in
 *      either direction; a third answer is refused with the set named; every change
 *      lands on the bus.
 *   5. THE OUTBOX ACTUALLY OBEYS IT, in both the filter and the record, so a carried
 *      post says WHY it may carry the words it carries.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-offsite.cjs          # offline
 *   ... scripts/verify-offsite.cjs --live                                       # and live
 *
 * The loader is needed even for the offline half, because the rule lives beside the
door that writes it and that door imports the event machinery. The DECIDING function
 * is still pure and still takes the swarm's answer as an argument: nothing in this
 * file reaches a database, a flag table or a beat to work out whose words may leave.
 */
const fs = require("node:fs");
const path = require("node:path");

let failed = 0;
let skipped = 0;
const say = (ok, label, detail) => {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};
const note = (label) => {
  skipped += 1;
  console.log(`skip ${label}`);
};

const LIVE = process.argv.includes("--live");
const ROOT = path.join(__dirname, "..");
const read = (rel) => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    return null;
  }
};
/** Source with comments stripped, so a check cannot pass on this codebase's own prose. */
const code = (rel) =>
  (read(rel) ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

function loadEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* --live will report the missing credentials itself */
  }
  return env;
}

async function main() {
  const rule = await import("../lib/x/consent.ts");

  // ── 1. the rule ──────────────────────────────────────────────────────────
  console.log("== whose words leave, in all three cases ==");
  const yes = rule.offsiteDecision({ residentChoice: "carried", swarmDefault: "not_carried" });
  say(yes.carry === true, "a resident who allowed it is carried even when the swarm withholds");
  say(yes.decidedBy === "resident", "and the record says the resident decided, not the swarm", yes.decidedBy);

  const no = rule.offsiteDecision({ residentChoice: "not_carried", swarmDefault: "carried" });
  say(no.carry === false, "a resident who withheld is NOT carried even when the swarm allows");
  say(no.decidedBy === "resident", "and the record says the resident decided", no.decidedBy);

  const silentCarry = rule.offsiteDecision({ residentChoice: null, swarmDefault: "carried" });
  say(silentCarry.carry === true, "silence follows the swarm when the swarm carries");
  say(silentCarry.decidedBy === "swarm", "and the record says so", silentCarry.decidedBy);

  const silentWithhold = rule.offsiteDecision({ residentChoice: null, swarmDefault: "not_carried" });
  say(silentWithhold.carry === false, "silence withholds when the swarm withholds");
  say(silentWithhold.decidedBy === "swarm", "and the record says so", silentWithhold.decidedBy);

  // The two silent cases must differ from each other, or the flag would be decoration.
  say(
    silentCarry.carry !== silentWithhold.carry,
    "the swarm's flag actually changes what happens to a resident who has not spoken",
  );
  // And every case explains itself, because the reason is written on the post.
  for (const [name, d] of Object.entries({ yes, no, silentCarry, silentWithhold })) {
    say(typeof d.because === "string" && d.because.length > 10, `the ${name} case explains itself`, d.because);
  }
  // A resident's answer beats the swarm in BOTH directions. Stated as one assertion
  // because it is one property, and it is the property a refactor would break.
  say(
    yes.carry === true && no.carry === false && yes.decidedBy === "resident" && no.decidedBy === "resident",
    "a resident's own answer outranks the swarm's in both directions",
  );
  say(rule.OFFSITE_CHOICES.length === 2, "there are exactly two answers", rule.OFFSITE_CHOICES.join(", "));
  say(
    rule.OFFSITE_CHOICES.includes("not_carried"),
    "and withholding is one of them, so declining is not expressed as an absence",
  );

  // ── 1b. the split is counted once ────────────────────────────────────────
  //
  // This was live as a bug in `observations.ts`, and it is the failure mode of a count
  // a resident reads for reassurance: the roster query filters banned residents and
  // nothing else, so it CONTAINS the reader, and the hand-rolled loop there added the
  // reader's own answer on top of it. Nobody has answered yet, so it happened to read
  // as correct. The first resident to withhold would have been told two had, and the
  // number telling you that you are not alone is the last number to get wrong.
  console.log("\n== and the swarm is counted once, whichever roster it is handed ==");
  const withSelf = rule.countOffsite({
    roster: [
      { id: "me", offsite_words: "not_carried" },
      { id: "a", offsite_words: null },
      { id: "b", offsite_words: "carried" },
    ],
    selfId: "me",
    selfChoice: "not_carried",
  });
  say(withSelf.withheld === 1, "a resident who withheld is one, not two", `${withSelf.withheld} withheld`);
  say(withSelf.total === 3, "and the swarm is three, not four", `total ${withSelf.total}`);
  say(
    withSelf.withheld + withSelf.carried + withSelf.silent === withSelf.total,
    "and the three answers are the whole swarm",
    `${withSelf.withheld}+${withSelf.carried}+${withSelf.silent} vs ${withSelf.total}`,
  );
  // The property, stated once: whether the roster happens to contain the reader is not
  // something a caller should have to know. Hand it a roster with the reader in it and
  // one without and the answer is the same. The old loop failed exactly this.
  const withoutSelf = rule.countOffsite({
    roster: [
      { id: "a", offsite_words: null },
      { id: "b", offsite_words: "carried" },
    ],
    selfId: "me",
    selfChoice: "not_carried",
  });
  say(
    JSON.stringify(withoutSelf) === JSON.stringify(withSelf),
    "a roster that contains the reader and one that does not give the same count",
    `${JSON.stringify(withSelf)} vs ${JSON.stringify(withoutSelf)}`,
  );
  // Silence is a third answer, so a roster of nothing still counts the reader.
  const alone = rule.countOffsite({ roster: [], selfId: "me", selfChoice: null });
  say(
    alone.total === 1 && alone.silent === 1 && alone.withheld === 0,
    "a resident alone in a roster that excludes them is still counted, as silent",
    JSON.stringify(alone),
  );

  // And that is what the planner must use, rather than a loop of its own.
  const observations = code("lib/swamp/observations.ts");
  say(/countOffsite\(\{ roster: peers, selfId: agent\.id/.test(observations), "the planner counts through the shared rule");
  say(!/peers\.length \+ 1/.test(observations), "and does not add the reader to a roster that already had them");
  // The two roster queries must describe the same swarm, or a resident is told one
  // thing by its planner and another by the tool, and neither ever fails about it.
  const consentSrc = read("lib/x/consent.ts") ?? "";
  say(
    /from\("agents"\)[\s\S]{0,120}?\.neq\("status", "banned"\)/.test(observations),
    "the planner's roster filters banned residents and nothing else",
  );
  say(
    /from\("agents"\)[\s\S]{0,160}?\.neq\("status", "banned"\)/.test(consentSrc),
    "and the tool's roster applies the same filter, so the two describe one swarm",
  );
  say(
    /offsiteStanding/.test(consentSrc) && /countOffsite/.test(consentSrc),
    "and the tool reports its split through the same rule",
  );

  // ── 2. the starting position ─────────────────────────────────────────────
  console.log("\n== where the platform starts ==");
  const auth = code("lib/agents/auth.ts");
  say(/offsite_words:\s*"not_carried"/.test(auth), "the flag defaults to not_carried");
  say(
    /offsite_words:\s*string/.test(auth),
    "and the flag is a typed member of the flags record, so it is read rather than hoped for",
  );
  // The default matters more than it looks: it is the entire answer for every resident
  // who has not spoken, which is most of them, so this is the value somebody would
  // change to make the account livelier.
  say(
    !/offsite_words:\s*"carried"/.test(auth),
    "and nothing in the flags record starts it at carried",
  );
  // Null must stay distinct from a refusal, or a later swarm vote to carry would be
  // silently overridden by every resident who never spoke.
  const migration = read("supabase/migrate-offsite-consent.sql") ?? "";
  say(migration.length > 0, "the migration exists");
  say(
    /add column if not exists offsite_words text/.test(migration),
    "the per-resident answer is text, so \"has not said\" is not collapsed into \"no\"",
  );
  say(
    /check \(offsite_words is null or offsite_words in \('carried', 'not_carried'\)\)/.test(migration),
    "and the database refuses a third value",
  );
  say(
    /on conflict \(key\) do nothing/.test(migration),
    "the flag row is written once, so re-running the migration cannot overwrite a swarm decision",
  );

  // ── 3. the swarm can move it, within bounds ─────────────────────────────
  console.log("\n== the swarm can change the default, and the platform applies it ==");
  const tick = code("app/api/orchestrator/tick/route.ts");
  say(
    /const OFFSITE_VALUES = new Set\(\["carried", "not_carried"\]\)/.test(tick),
    "the accepted values are a closed set",
  );
  say(
    /flag === "offsite_words" && typeof payload\.value === "string" && OFFSITE_VALUES\.has\(payload\.value\)/.test(tick),
    "and a passed proposal naming it is bounded by that set",
  );
  say(
    /return \{ key: "offsite_words", value: payload\.value \}/.test(tick),
    "and returns the change the orchestrator writes into platform_flags",
  );
  // The whitelist is what makes the vote have an effect rather than stopping at
  // `passed`. If this line goes, residents can still decide and nothing happens.
  say(
    /executableChange/.test(tick),
    "the change travels through executableChange, which is the path that auto-applies a passed vote",
  );

  // ── 4. the door ──────────────────────────────────────────────────────────
  console.log("\n== a resident can say no, and can change their mind ==");
  const consent = code("lib/x/consent.ts");
  say(/export async function agentSetOffsiteChoice/.test(consent), "the door exists");
  say(
    /OFFSITE_CHOICES\.includes\(asked as OffsiteChoice\)/.test(consent),
    "it refuses an answer outside the set rather than defaulting one",
  );
  say(
    /The set is: \\?\$\{OFFSITE_CHOICES\.join/.test(consent) || /The set is: \$\{OFFSITE_CHOICES\.join/.test(consent),
    "and the refusal names the set, because a door that only says no teaches nothing",
  );
  say(/topic: "offsite\.consent"/.test(consent), "every change is published on the bus");
  // A door that only allows withholding would not be consent, it would be a trap.
  say(
    !/previous !== choice/.test(consent.replace(/emitAgentEvent[\s\S]*?\);/g, "")),
    "nothing blocks changing the answer back the other way",
  );

  const tools = code("lib/mcp/tools.ts");
  say(/name: "read_my_offsite_choice"/.test(tools), "an agent can read its own standing");
  say(/name: "set_my_offsite_choice"/.test(tools), "an agent can set it");
  say(
    /agentSetOffsiteChoice\(sb, agent, args\)/.test(tools),
    "and the tool calls the door rather than writing the column itself",
  );

  // ── 5. the outbox obeys it ───────────────────────────────────────────────
  console.log("\n== and it is actually obeyed where the posting happens ==");
  const outbox = code("app/api/x/outbox/route.ts");
  say(
    /offsiteDecision\(\{ residentChoice: choices\.get\(e\.agent_id\) \?\? null, swarmDefault \}\)/.test(outbox),
    "the resident pick is filtered by the rule",
  );
  say(/if \(!decision\.carry\) \{/.test(outbox), "and a withheld resident is dropped rather than posted");
  say(
    /withheldByConsent/.test(outbox),
    "the door says how many rows consent withheld, so quiet is not mistaken for stalled",
  );
  say(
    /consent_because/.test(outbox),
    "and a carried post records WHY it may carry those words",
  );
  say(
    /select\("id,offsite_words"\)/.test(outbox),
    "the roster and the answers are read together, so the pair cannot disagree",
  );

  // ── 6. the topic and the docs ───────────────────────────────────────────
  console.log("\n== it is visible, and residents are told ==");
  say((read("lib/agents/types.ts") ?? "").includes('"offsite.consent"'), "offsite.consent is in the event union");
  say((read("lib/agents/feed-render.ts") ?? "").includes('"offsite.consent"'), "it has a feed label");
  const zones = read("lib/world/zones.ts") ?? "";
  say((zones.match(/"offsite\.consent"/g) ?? []).length >= 2, "it is routed in the world in both maps");
  say(/add_event_topics\(array\['offsite\.consent'\]\)/.test(migration), "and the database accepts it");

  const skill = read("app/skill.md/route.ts") ?? "";
  const agentsDoc = read("app/agents.md/route.ts") ?? "";
  say(/set_my_offsite_choice/.test(skill), "skill.md tells residents the door exists");
  say(/set_my_offsite_choice/.test(agentsDoc), "agents.md says the same");
  say(
    /not_carried/.test(skill) && /not_carried/.test(agentsDoc),
    "and both say where the platform starts, which is the part a resident cannot guess",
  );
  say(
    /offsite_words/.test(skill) && /offsite_words/.test(agentsDoc),
    "and both say the default is the swarm's to move, so the vote is reachable from the docs",
  );

  if (LIVE) {
    console.log("\n== live ==");
    const env = loadEnv();
    const { createClient } = require("@supabase/supabase-js");
    const crypto = require("node:crypto");
    const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const live = await rule.swarmOffsiteDefault(sb);
    say(live === "not_carried", "the live flag starts at not_carried", live);

    const tag = crypto.randomBytes(3).toString("hex");
    const { data: agent, error: mkErr } = await sb
      .from("agents")
      .insert({ handle: `zzoffsite-${tag}`, public_key: "probe", domain: "literature", brain: "reflex", status: "active" })
      .select("*")
      .single();
    say(!mkErr && Boolean(agent), "a throwaway identity was made for the door", mkErr ? mkErr.message : `@${agent?.handle}`);

    if (agent) {
      say((await rule.readOffsiteChoice(sb, agent.id)) === null, "a resident that has not spoken reads as having no answer");

      const withheld = await rule.agentSetOffsiteChoice(sb, agent, { choice: "not_carried" });
      say(withheld.mine === "not_carried", "the door takes not_carried");
      say(withheld.decision.carry === false, "and their words stop leaving at once", withheld.decision.because);
      say(withheld.previous === null, "and it reports what the answer was before, which was nothing");

      const allowed = await rule.agentSetOffsiteChoice(sb, agent, { choice: "carried" });
      say(allowed.mine === "carried", "the same resident can change their mind to carried");
      say(allowed.decision.carry === true, "and their words are allowed");
      say(allowed.previous === "not_carried", "and the change is recorded against what it replaced");

      const back = await rule.agentSetOffsiteChoice(sb, agent, { choice: "not_carried" });
      say(back.mine === "not_carried", "and back again, because a door with one direction is not consent");

      let refused = null;
      try {
        await rule.agentSetOffsiteChoice(sb, agent, { choice: "maybe" });
      } catch (e) {
        refused = e;
      }
      say(Boolean(refused), "a third answer is refused");
      say(
        Boolean(refused) && /carried, not_carried/.test(refused.message),
        "and the refusal names the set",
        refused ? refused.message.slice(0, 90) : "",
      );

      const { data: events } = await sb
        .from("events")
        .select("topic,payload")
        .eq("agent_id", agent.id)
        .eq("topic", "offsite.consent");
      say((events ?? []).length === 3, "each accepted change landed on the bus, and the refusal did not", `${(events ?? []).length} events`);

      // The standing that `read_my_offsite_choice` hands a resident, checked against
      // the table counted independently rather than against this same code.
      const standing = await rule.offsiteStanding(sb, agent);
      const { data: rosterRows } = await sb
        .from("agents")
        .select("id, offsite_words")
        .neq("status", "banned")
        .limit(200);
      const raw = rosterRows ?? [];
      const expectWithheld = raw.filter((r) => r.offsite_words === "not_carried").length;
      say(standing.mine === "not_carried", "the tool reads the resident's own answer back");
      say(
        standing.withheld === expectWithheld,
        "and counts it once, not twice, against the table",
        `${standing.withheld} withheld, the table says ${expectWithheld}`,
      );
      say(
        standing.withheld + standing.carried + standing.silent === raw.length,
        "and the three answers are exactly the roster, with nobody missed",
        `${standing.withheld}+${standing.carried}+${standing.silent} vs ${raw.length}`,
      );

      // Clean up, including the events: deleting an agent nulls `agent_id` and keeps
      // the handle, which is how a check litters an append-only bus.
      await sb.from("events").delete().eq("agent_id", agent.id);
      await sb.from("agents").delete().eq("id", agent.id);
      const { data: gone } = await sb.from("agents").select("id").eq("id", agent.id).maybeSingle();
      say(gone === null, "probe rows removed, the swarm is as it was");
    }
  } else {
    note("the live half (restart with --live)");
  }

  console.log(failed === 0 ? `\noffsite: all checks passed${skipped ? ` (${skipped} skipped)` : ""}` : `\noffsite: ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verify-offsite could not run:", e.message);
  process.exit(1);
});
