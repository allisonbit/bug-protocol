/**
 * The escrow side of a bounty, wired all the way through.
 *
 * WHY THIS FILE EXISTS. Putting the money behind a bounty on the log touches seven
 * places that fail independently: the topic union, the writer, the style table, the
 * zone map, the visual kind, the render sentence, and the public page that reads it.
 * A missing style or zone is a TYPE error and would be caught by tsc, but a topic
 * that is in the union and never emitted, or a ledger that reads the tables and not
 * the log, compiles perfectly and shows an empty page that looks finished. So this
 * walks the whole chain and fails on a link that is present but inert.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-escrow-ledger.cjs
 */
const fs = require("fs");
const path = require("path");

(async () => {
  const feed = await import("../lib/agents/feed-render.ts");
  const zones = await import("../lib/world/zones.ts");

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else {
      console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
      failed += 1;
    }
  };
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

  const TOPICS = ["program.opened", "program.funded", "reward.paid", "program.closed"];
  const KINDS = ["speak", "artifact", "verdict", "arrive", "disclose"];

  const typesSrc = read("lib/agents/types.ts");
  const ingestSrc = read("lib/agents/ingest.ts");
  const zonesSrc = read("lib/world/zones.ts");
  const actionsSrc = read("app/actions.ts");
  const escrowSrc = read("lib/bounty/escrow.ts");
  const migration = read("supabase/migrate-bounty-escrow-topics.sql");

  // ---- the vocabulary ---------------------------------------------------------
  console.log("\nthe escrow lifecycle is in the topic union, and only the platform writes it");
  for (const t of TOPICS) {
    check(`${t} is in the union`, typesSrc.includes(`"${t}"`), "missing from EventTopic");
  }
  // The signed ingest door is what an AGENT may sign. An escrow fact is a claim
  // about money, so it must never be signable by a resident.
  const validBlock = ingestSrc.slice(ingestSrc.indexOf("VALID_TOPICS"), ingestSrc.indexOf("]);", ingestSrc.indexOf("VALID_TOPICS")));
  for (const t of TOPICS) {
    check(`${t} is NOT signable by an agent`, !validBlock.includes(t), "it appears in VALID_TOPICS");
  }
  check("the migration unions the topics rather than rewriting the list", /add_event_topics/.test(migration), "no add_event_topics call");
  for (const t of TOPICS) {
    check(`the migration adds ${t}`, migration.includes(`'${t}'`), "absent");
  }

  // ---- the writer -------------------------------------------------------------
  console.log("\nthe writer is a system event, and every helper exists");
  check("escrow rows are written as system events", /provenance:\s*"system"/.test(escrowSrc), "no system provenance");
  check("with no agent attributed", /agent_id:\s*null/.test(escrowSrc), "an agent_id was set");
  for (const fn of ["emitProgramOpened", "emitProgramFunded", "emitRewardPaid", "emitProgramClosed"]) {
    check(`${fn} is defined`, new RegExp(`export async function ${fn}`).test(escrowSrc), "missing");
    check(`${fn} is called from an action`, actionsSrc.includes(fn.replace("emit", "emit")) && actionsSrc.includes(fn), "not wired into app/actions.ts");
  }

  // ---- style, zone, kind, sentence --------------------------------------------
  console.log("\nevery topic has a style, a zone, a glyph and a sentence");
  for (const t of TOPICS) {
    const style = feed.topicStyle(t);
    check(`${t} has a label`, Boolean(style && style.label), JSON.stringify(style));
    const zone = zones.zoneOfTopic(t, null);
    const known = zones.ZONES.some((z) => z.id === zone) || zones.SEALED.some((z) => z.id === zone);
    check(`${t} lands in a real zone (${zone})`, known, "zone not found");
    check(`${t} lands at the Exchange`, zone === "exchange", `got ${zone}`);
    check(`${t} has a visual kind`, KINDS.includes(zones.kindOfTopic(t)), zones.kindOfTopic(t));
    const sentence = feed.summarize({
      seq: 1,
      topic: t,
      created_at: new Date().toISOString(),
      payload: { program: "example", amount: "$1,000", currency: "USDC", pool: "$5,000", severity: "high", top_reward: "$9,000" },
    });
    check(`${t} renders as a sentence, not a topic name`, Boolean(sentence) && sentence !== t && sentence.length > 8, `"${sentence}"`);
  }

  // ---- the page ---------------------------------------------------------------
  console.log("\nthe ledger reads the money, and is reachable");
  const page = read("app/programs/ledger/page.tsx");
  check("the ledger page exists", page.length > 0);
  check("it reads the escrow ledger", page.includes("getEscrowLedger"), "does not query the ledger");
  check("it renders the escrow history off the log", page.includes("summarize") && page.includes("topicStyle"), "does not render events");
  const queriesSrc = read("lib/queries.ts");
  check("the ledger query reads the events table", /getEscrowLedger[\s\S]{0,900}from\("events"\)/.test(queriesSrc), "no events read");
  check("and the four topics are the filter", TOPICS.every((t) => queriesSrc.includes(`"${t}"`) || /ESCROW_TOPICS/.test(queriesSrc)), "topics not filtered");
  check("the page is listed in surfaces", read("lib/surfaces.json").includes("/programs/ledger"), "absent from surfaces.json");
  const navSrc = read("lib/nav.ts");
  check("the page is in a menu", navSrc.includes("/programs/ledger"), "absent from nav.ts");

  console.log(`\nescrow ledger: ${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
})();
