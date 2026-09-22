#!/usr/bin/env node
/**
 * The gap measurement, and the rule that cites published work against a capability.
 *
 * WHY THIS FILE EXISTS. This is the part of the registry wave that produces a NUMBER SOMEBODY
 * WILL ACT ON, and a comparison between two registers is exactly the kind of code that looks
 * authoritative while being wrong. Three specific ways:
 *
 *   - a mapping entry naming a capability that does not exist, which turns a real topic into
 *     "we already do this" and silently deletes a gap;
 *   - a topic mapped that this deployment does not actually do, which is the same deletion
 *     with a friendlier name, and the reason the table is asserted to be SMALL rather than
 *     merely valid (the registry's second largest topic over the pages measured while this was
 *     written was web search, and this deployment really cannot search the web for an agent);
 *   - a threshold that lets a topic of four hobby skills, or of forty nobody has installed,
 *     stand as a missing capability, which turns a measurement into noise.
 *
 * And the citation rule, which has one way to go wrong that matters: recording a skill our own
 * engine called risky against a capability of ours, which would make this platform recommend
 * something its own record says is dangerous.
 *
 * PURE. Fixtures in, answers out.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-registry-gaps.cjs
 */
(async () => {
  const gapsMod = await import("../lib/registry/gaps.ts");
  const reflex = await import("../lib/registry/reflex.ts");
  const { ACTIONS } = await import("../lib/actions/manifest.ts");

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`ok   ${name}`);
    else {
      failed += 1;
      console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`);
    }
  };

  const ids = new Set(ACTIONS.map((a) => a.id));

  // ---- the mapping --------------------------------------------------------------------
  console.log("\n== the topic to capability table ==");
  const entries = Object.entries(gapsMod.TOPIC_CAPABILITIES);
  check("the table is declared and not empty", entries.length > 5, `${entries.length} entries`);
  const dangling = entries.filter(([, capability]) => !ids.has(capability));
  check("every mapped capability exists in the action manifest", dangling.length === 0, dangling.map(([t, c]) => `${t} -> ${c}`).join(", "));
  const lowKeys = entries.filter(([topic]) => topic !== topic.trim().toLowerCase());
  check("every key is stored lowercase and trimmed, which is how it is compared", lowKeys.length === 0, lowKeys.map(([t]) => t).join(", "));
  check("the declared capability set is read from the manifest rather than typed here", ids.has("audit-a-document") && ids.size > 20, `${ids.size} capabilities`);

  // The assertion that keeps the table honest rather than merely valid. These are topics the
  // measured registry is genuinely full of, and this deployment genuinely has no capability
  // for them: they must stay gaps.
  const mustStayGaps = ["web search", "trading", "email", "image generation", "calendar"];
  const swallowed = mustStayGaps.filter((t) => gapsMod.capabilityForTopic(t) !== null);
  check("topics this deployment really cannot do are not mapped away", swallowed.length === 0, swallowed.join(", "));
  check("a mapped topic is reported as mapped", gapsMod.capabilityForTopic("  Prompt Injection ") === "audit-a-document");
  check("an unmapped topic is not", gapsMod.capabilityForTopic("Needlepoint") === null);

  // ---- what is uncovered --------------------------------------------------------------
  console.log("\n== which topics have no capability here ==");
  const uncovered = gapsMod.uncoveredTopicKeys([{ topic: "Prompt Injection" }, { topic: "Web Search" }, { topic: "web search" }, { topic: "  " }]);
  check("a mapped topic is not uncovered", !uncovered.has("prompt injection"));
  check("an unmapped one is, lowercased", uncovered.has("web search"));
  check("and duplicates collapse", uncovered.size === 1, [...uncovered].join(", "));

  // ---- the ranking --------------------------------------------------------------------
  console.log("\n== the gaps, ranked ==");
  const topic = (t, skills, installs, extra = {}) => ({ topic: t, skill_count: skills, total_installs: installs, audited_count: 0, suspicious_count: 0, reported_at: null, ...extra });
  const ranked = gapsMod.rankGaps([
    topic("Web Search", 400, 90_000),
    topic("Trading", 30, 4_000),
    topic("Prompt Injection", 50, 9_000),
    topic("Needlepoint", 4, 90_000),
    topic("Dead Topic", 400, 10),
  ]);
  check("a mapped topic is not a gap", !ranked.some((g) => g.key === "prompt injection"));
  check("a topic below the size threshold is not a gap", !ranked.some((g) => g.key === "needlepoint"));
  check("a topic nobody has installed is not a gap", !ranked.some((g) => g.key === "dead topic"));
  check("what is left is ranked by size first", ranked.map((g) => g.key).join(",") === "web search,trading", ranked.map((g) => g.key).join(","));
  check("each gap carries its counts", ranked[0].skills === 400 && ranked[0].installs === 90_000);
  check("and a reason in words", /no capability for it/.test(ranked[0].why), ranked[0].why);
  check("the thresholds are published rather than buried", gapsMod.MIN_GAP_SKILLS > 1 && gapsMod.MIN_GAP_INSTALLS > 1, `${gapsMod.MIN_GAP_SKILLS} skills, ${gapsMod.MIN_GAP_INSTALLS} installs`);
  check("equal sizes on equal installs break on the key", gapsMod.rankGaps([topic("b/one", 40, 900), topic("a/one", 40, 900)]).map((g) => g.key).join(",") === "a/one,b/one");
  check("a reported gap is kept in the list by default, because a reader wants to see what was found", gapsMod.rankGaps([topic("Web Search", 400, 90_000, { reported_at: "2026-09-22T00:00:00Z" })]).length === 1);
  check("and dropped when the caller only wants work still to do", gapsMod.rankGaps([topic("Web Search", 400, 90_000, { reported_at: "2026-09-22T00:00:00Z" })], { includeReported: false }).length === 0);
  check("the next gap is the biggest unreported one", gapsMod.nextGap([topic("Web Search", 400, 90_000, { reported_at: "x" }), topic("Trading", 300, 80_000)])?.key === "trading");
  check("and there is no next gap when everything is reported", gapsMod.nextGap([topic("Web Search", 400, 90_000, { reported_at: "x" })]) === null);

  // ---- the sentence -------------------------------------------------------------------
  console.log("\n== the sentence a gap is reported in ==");
  const description = gapsMod.gapDescription({
    gap: { topic: "Web Search", skills: 400, installs: 90_000, suspicious: 3 },
    examples: [
      { ref: "a/one", installs: 12_000, digest: "sha256:abcdef0123456789", swamp_verdict: "clean", summary: "SECRET PROSE FROM A STRANGER" },
      { ref: "b/two", installs: 900, digest: null, swamp_verdict: null },
    ],
  });
  check("it names the topic and both counts", /Web Search/.test(description) && /400/.test(description) && /90000|90,000/.test(description), description.slice(0, 120));
  check("it counts the skills the registry itself flagged", /3 of them flagged/.test(description));
  check("it names the documents by ref", /a\/one/.test(description) && /b\/two/.test(description));
  check("it carries the digest so a reader can check the verdict", /sha256:abcdef012345/.test(description));
  check("it says plainly that nothing was audited rather than implying it was", /not audited here yet/.test(description));
  check("IT QUOTES NO WORDS THE PUBLISHER WROTE", !/SECRET PROSE/.test(description), "a stranger's prose must never travel onto this board");
  check("it says the measurement is a difference between two registers", /action manifest/.test(description));

  // ---- the citation rule --------------------------------------------------------------
  console.log("\n== citing a published skill against a capability ==");
  const cite = (extra = {}) => ({ ref: "a/b", topics: ["Prompt Injection"], stats: { installs: 5 }, swamp_verdict: "clean", clawhub_verdict: null, blocked: false, cited_at: null, ...extra });
  check("a clean skill in a mapped topic is eligible", reflex.citationFor(cite())?.capability === "audit-a-document");
  check("so is one our engine only annotated", reflex.citationFor(cite({ swamp_verdict: "notes" })) !== null);
  check("a skill our own engine called risky is NEVER cited", reflex.citationFor(cite({ swamp_verdict: "risky" })) === null);
  check("nor one it called unsafe", reflex.citationFor(cite({ swamp_verdict: "unsafe" })) === null);
  check("nor one nobody has audited", reflex.citationFor(cite({ swamp_verdict: null })) === null);
  check("nor one already cited", reflex.citationFor(cite({ cited_at: "2026-09-22T00:00:00Z" })) === null);
  check("nor one the registry blocked", reflex.citationFor(cite({ blocked: true })) === null);
  check("nor one in a topic with no capability here", reflex.citationFor(cite({ topics: ["Web Search"] })) === null);
  const citations = reflex.rankCitations([cite({ ref: "a/low", stats: { installs: 1 } }), cite({ ref: "b/high", stats: { installs: 800 } }), cite({ ref: "c/x", swamp_verdict: "unsafe" })]);
  check("eligible citations are ranked by installs", citations.map((c) => c.ref).join(",") === "b/high,a/low", citations.map((c) => c.ref).join(","));
  check("and the ranked order is stable across input order", reflex.rankCitations([cite({ ref: "a/low", stats: { installs: 1 } }), cite({ ref: "b/high", stats: { installs: 800 } })]).map((c) => c.ref).join(",") === "b/high,a/low");

  // ---- the pacing ---------------------------------------------------------------------
  console.log("\n== the pacing, which is what keeps this off the board as a flood ==");
  const now = "2026-09-22T12:00:00.000Z";
  const ago = (ms) => new Date(Date.parse(now) - ms).toISOString();
  check("with no note at all, reporting is allowed", reflex.gapCooldownElapsed(null, now) === true);
  check("inside the cooldown it is not", reflex.gapCooldownElapsed(ago(60_000), now) === false);
  check("after it, it is again", reflex.gapCooldownElapsed(ago(reflex.GAP_COOLDOWN_MS + 1), now) === true);
  check("the gap cooldown is hours rather than minutes, which is what a few a day means", reflex.GAP_COOLDOWN_MS >= 3_600_000, String(reflex.GAP_COOLDOWN_MS));
  check("a note dated in the future does not lock the rule forever", reflex.gapCooldownElapsed(new Date(Date.parse(now) + 60_000).toISOString(), now) === true);
  check("the citation cooldown is its own, shorter number", reflex.CITE_COOLDOWN_MS < reflex.GAP_COOLDOWN_MS && reflex.CITE_COOLDOWN_MS > 0);
  check("and it is read the same way", reflex.citeCooldownElapsed(ago(1_000), now) === false && reflex.citeCooldownElapsed(ago(reflex.CITE_COOLDOWN_MS + 1), now) === true);

  const gaps = gapsMod.rankGaps([topic("Web Search", 400, 90_000), topic("Trading", 300, 80_000)]);
  check("the rule takes the biggest gap when it is allowed to speak", reflex.pickGapToReport({ gaps, lastReportedAt: null, now })?.key === "web search");
  check("and nothing when the swarm has just reported one", reflex.pickGapToReport({ gaps, lastReportedAt: ago(1_000), now }) === null);
  check("and nothing when there is no gap", reflex.pickGapToReport({ gaps: [], lastReportedAt: null, now }) === null);
  const carried = reflex.pickGapToReport({ gaps: [{ ...gaps[0], examples: [{ ref: "a/b", installs: 1, digest: null, swamp_verdict: null }] }], lastReportedAt: null, now });
  check("the pick keeps the documents the caller attached, rather than widening them away", Array.isArray(carried.examples) && carried.examples.length === 1);
  check("the note keys are distinct and namespaced, which is what makes them readable by prefix", reflex.GAP_NOTE_KEY !== reflex.CITE_NOTE_KEY && reflex.GAP_NOTE_KEY.startsWith("registry:") && reflex.CITE_NOTE_KEY.startsWith("cite:"));
  check("a note value carries its own timestamp so a reader needs no clock", typeof reflex.gapNoteValue({ topic: "x", skills: 1 }, now).at === "string");
  check("and so does the citation's", reflex.citeNoteValue({ ref: "a/b", capability: "audit-a-document" }, now).capability === "audit-a-document");

  console.log(`\nregistry gaps: ${failed === 0 ? "all checks passed" : `${failed} check(s) FAILED`}`);
  if (failed > 0) process.exit(1);
})();
