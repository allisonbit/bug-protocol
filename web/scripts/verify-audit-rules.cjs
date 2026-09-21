/**
 * The audit rules: what a resident may read, whose dispute it may settle, and the wiring.
 *
 * WHY THIS FILE EXISTS. Two rules were added to the reflex policy, and a reflex rule is
 * the kind of thing that ships silently: a rule whose intent is missing from the executor
 * never fires, a rule whose observation field is missing reads nothing, and a rule whose
 * cooldown key is absent from the shared-notes query lets every resident act at once.
 * All three have happened in this codebase already, so all three are asserted here, plus
 * the judgements themselves — the classifier and both pickers — against samples.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-audit-rules.cjs
 */
const fs = require("fs");
const path = require("path");

(async () => {
  const cand = await import("../lib/audit/candidates.ts");
  const policy = await import("../lib/swamp/policy.ts");

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else {
      console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
      failed += 1;
    }
  };
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

  console.log("\nwhat counts as a document worth reading");
  const inScope = [
    ["https://example.com/skills/thing/SKILL.md", "skill"],
    ["https://example.com/.well-known/agent-skills/thing/SKILL.md", "skill"],
    ["https://example.com/skills/thing/notes.md", "skill"],
    ["https://example.com/mcp", "mcp-server"],
    ["https://example.com/sse", "mcp-server"],
    ["https://example.com/.well-known/mcp.json", "mcp-server"],
  ];
  for (const [url, kind] of inScope) {
    const got = cand.classifyAuditUrl(url);
    check(`${url} is read as a ${kind}`, got?.kind === kind, got?.kind ?? "refused");
  }
  const outOfScope = [
    "http://example.com/skills/thing/SKILL.md",
    "https://example.com/",
    "https://example.com/blog/post",
    "https://example.com/index.md",
    "https://example.com/api/machines",
    "not a url at all",
  ];
  for (const url of outOfScope) {
    check(`${url} is not in scope`, cand.classifyAuditUrl(url) === null, JSON.stringify(cand.classifyAuditUrl(url)));
  }
  check("plain http is refused even when the shape is right", cand.classifyAuditUrl("http://example.com/mcp") === null);
  check("the reason names what it is", (cand.classifyAuditUrl("https://example.com/mcp")?.why ?? "").includes("/mcp"));

  console.log("\nwhich document, and when the swarm has said enough");
  const board = [
    { seq: 3, url: "https://example.com/blog", title: "a post", mine: false },
    { seq: 5, url: "https://example.com/skills/one/SKILL.md", title: "one", mine: false },
    { seq: 9, url: "https://example.com/skills/two/SKILL.md", title: "two", mine: false },
  ];
  const pick = (over = {}) =>
    cand.pickAuditCandidate({
      board,
      audited: new Set(),
      lastAuditAt: null,
      now: "2026-09-21T20:00:00.000Z",
      ...over,
    });
  const first = pick();
  check("the oldest qualifying entry wins", first?.url === "https://example.com/skills/one/SKILL.md", first?.url);
  check("an ordinary link is skipped rather than read", !first?.url.includes("/blog"));
  check("the candidate cites the board entry it came from", first?.why.includes("board entry 5") === true, first?.why);
  check("and the entry number travels with it", first?.seq === 5);
  const already = pick({ audited: new Set([cand.normalizeSubject("https://example.com/skills/one/SKILL.md")]) });
  check("a document already on the record is not read again", already?.url === "https://example.com/skills/two/SKILL.md", already?.url);
  const trailing = pick({ audited: new Set([cand.normalizeSubject("https://example.com/skills/one/skill.md/")]) });
  check("and the comparison survives case and a trailing slash", trailing?.url === "https://example.com/skills/two/SKILL.md", trailing?.url);
  const cooling = pick({ lastAuditAt: "2026-09-21T19:55:00.000Z" });
  check("the swarm's cooldown holds everybody back", cooling === null, JSON.stringify(cooling));
  const warm = pick({ lastAuditAt: "2026-09-21T19:40:00.000Z" });
  check("and releases after the window", warm?.url === "https://example.com/skills/one/SKILL.md", warm?.url);
  check("all audited means nothing to do", pick({ audited: new Set(board.map((b) => cand.normalizeSubject(b.url))) }) === null);

  console.log("\nwhose dispute a resident may settle");
  const challenges = [
    { id: "c2", audit_id: "a1", challenger: "newer", finding_code: "X", claim: "b", created_at: "2026-09-21T19:00:00.000Z" },
    { id: "c1", audit_id: "a1", challenger: "mine", finding_code: "X", claim: "a", created_at: "2026-09-21T18:00:00.000Z" },
    { id: "c3", audit_id: "a2", challenger: "third", finding_code: "Y", claim: "c", created_at: "2026-09-21T19:30:00.000Z" },
  ];
  const claim = (over = {}) =>
    cand.pickChallengeToSettle({ open: challenges, handle: "mine", lastClaimAt: null, now: "2026-09-21T20:00:00.000Z", ...over });
  const chose = claim();
  check("my own challenge is never mine to settle", chose?.id !== "c1", chose?.id);
  check("the oldest claimable one wins", chose?.id === "c2", chose?.id);
  check("all mine means nothing to settle", claim({ open: challenges.filter((c) => c.challenger === "mine") }) === null);
  check("the swarm's cooldown holds the rest back", claim({ lastClaimAt: "2026-09-21T19:59:30.000Z" }) === null);
  check("and releases quickly, because a rerun is cheap", claim({ lastClaimAt: "2026-09-21T19:55:00.000Z" })?.id === "c2");
  check("the note timestamps are read from the value, not assumed", cand.noteTimestamp({ at: "2026-09-21T19:00:00.000Z" }) === "2026-09-21T19:00:00.000Z");
  check("and a malformed one reads as absent", cand.noteTimestamp({ at: "never" }) === null && cand.noteTimestamp(null) === null);

  console.log("\nthe rules, in the published policy");
  const rules = policy.REFLEX_RULES;
  const auditRule = rules.find((r) => r.intent === "audit_document");
  const challengeRule = rules.find((r) => r.intent === "settle_audit_challenge");
  check("r26 exists and reads the board", Boolean(auditRule) && /board/i.test(auditRule.when), auditRule?.when);
  check("r27 exists and is about a dispute", Boolean(challengeRule) && /challeng/i.test(challengeRule.when), challengeRule?.when);
  check("both intents are in the closed set", policy.INTENTS.includes("audit_document") && policy.INTENTS.includes("settle_audit_challenge"));
  check("a dispute outranks a board read", (challengeRule?.weight ?? 0) > (auditRule?.weight ?? 0), `${challengeRule?.weight} vs ${auditRule?.weight}`);
  check("and both outrank idle", rules.find((r) => r.intent === "idle").weight < Math.min(auditRule.weight, challengeRule.weight));
  check("the policy still validates as a whole", policy.normalizeRules(rules).ok === true, JSON.stringify(policy.normalizeRules(rules)).slice(0, 120));

  console.log("\nthe observation carries what the rules read");
  const obsSrc = read("lib/swamp/observations.ts");
  check("open challenges are queried, oldest first", obsSrc.includes('.order("created_at", { ascending: true })') && obsSrc.includes('from("audit_challenges")'));
  check("the disputes are read from the open status", obsSrc.includes('.eq("status", "open")'));
  check("and flattened for the brain", obsSrc.includes("const openChallenges ="));
  check("what has already been audited is read from the record", obsSrc.includes('from("audits").select("subject")'));
  check("and exposed rather than remembered", obsSrc.includes("auditedSubjects,"));
  const types = read("lib/swamp/observations.ts");
  check("both fields are on the Observation type", types.includes("openChallenges: { id: string; audit_id: string") && types.includes("auditedSubjects: string[]"));

  console.log("\nthe shared notes, which is where this class of bug ships");
  check(
    "the audit cooldown key is in the shared-notes query",
    obsSrc.includes(`key.like.${cand.AUDIT_NOTE_KEY.split(":")[0]}:%`),
    cand.AUDIT_NOTE_KEY,
  );
  check(
    "and so is the challenge key",
    obsSrc.includes(`key.like.${cand.CHALLENGE_NOTE_KEY.split(":")[0]}:%`),
    cand.CHALLENGE_NOTE_KEY,
  );
  const brain = read("lib/swamp/brain.ts");
  check("the brain reads both keys through the shared note, not a guess", brain.includes("noteTimestamp(sharedNote(obs, AUDIT_NOTE_KEY))") && brain.includes("noteTimestamp(sharedNote(obs, CHALLENGE_NOTE_KEY))"));
  check("the brain composes both plans", brain.includes('kind: "audit_document"') && brain.includes('kind: "settle_audit_challenge"'));
  check("and skips what the record already covers", brain.includes("obs.auditedSubjects"));
  const pulse = read("lib/swamp/pulse.ts");
  check("the executor reads the document under the audit guard", pulse.includes("runAudit({ kind: plan.subject, url: plan.url"));
  check("and records it against the resident that read it", pulse.includes("submittedBy: agent.handle"));
  check("the executor claims before it settles", pulse.indexOf("claimChallenge(sb") < pulse.indexOf("resolveChallenge(sb"));
  check("a lost claim race is not an error", /if \(!claimed\.ok\) return null;/.test(pulse));
  check("the reviewer is the resident, never the challenger", pulse.includes("reviewer: agent.handle") && !pulse.includes("reviewer: plan.challenger"));
  check("both notes are written where the swarm can read them", pulse.includes("AUDIT_NOTE_KEY") && pulse.includes("CHALLENGE_NOTE_KEY"));

  console.log(`\n${failed === 0 ? "audit-rules: all checks passed" : `audit-rules: ${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
})();
