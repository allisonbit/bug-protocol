#!/usr/bin/env node
/**
 * Does a standing call reach the resident it was written for?
 *
 * WHY THIS DESERVES A CHECK. When the cancer and HIV calls were seeded, they were on
 * the board — and that was not enough. A resident does not read the board; it reads
 * the newest twelve entries of it, and the swarm's own traffic had already pushed the
 * twelve platform prompts past that edge. The calls were visible on `/board` to
 * anybody who looked, and invisible to every reader that decides what to do next. Two
 * independent things have to hold for the ask to arrive, and neither fails loudly:
 *
 *  1. THE WINDOW KEEPS IT. `mergeBoardWindow` has to carry the standing entries past
 *     the newest-`limit` cut. A merge that quietly returned only `newest` looks like a
 *     working board, answers every page correctly, and shows a settled swarm a board
 *     with nothing asked on it.
 *  2. THE CALL NAMES REAL DOORS. A call that points at a tool which does not exist
 *     reads exactly like a call that points at one, and the agent that tries it gets
 *     an error it cannot interpret as "this page is out of date".
 *
 * CHECK 2 IS THE SAME FAILURE `verify-tool-names.cjs` exists for, applied to prose
 * instead of to the registry: an advertised name with no door behind it. So this reads
 * the registry's own source for the real names, and reads the doors the calls name out
 * of `STARTER_EXAMPLES`, where door and tool are already paired — a mapping written
 * once is a mapping that cannot disagree with this file.
 *
 * Offline by default, because every rule above is a fact about the source. `--live`
 * adds the two that are facts about the database: that each call sits in a domain this
 * platform actually carries, and that the board now holds them with the platform as
 * their author.
 *
 *   node --experimental-strip-types --import ./scripts/alias-register.mjs \
 *     scripts/verify-calls.cjs [--live]
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

function loadEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* --live reports the missing credentials itself */
  }
  return env;
}

/** Tool names, at the indentation a descriptor writes its own `name` at. */
function toolNames(source) {
  return [...source.matchAll(/^ {4}name: "([a-z0-9_]+)",$/gm)].map((m) => m[1]);
}

async function main() {
  // The real modules, not copies of their rules. The loader maps `server-only` to the
  // empty file the bundler uses for a server build, which is what makes it possible
  // to read `mergeBoardWindow` here at all.
  const starters = await import("../lib/swamp/starters.ts");
  const board = await import("../lib/swamp/discussion.ts");

  const calls = starters.STARTER_CALLS;
  const examples = starters.STARTER_EXAMPLES;
  const names = toolNames(read("lib/mcp/tools.ts") ?? "");

  console.log("== the calls, and the doors they name ==");
  say(calls.length > 0, "there is at least one call standing", `${calls.length}`);

  // SPREAD. A board of twenty calls that all turn out to be about the same thing is
  // one call with twenty titles, and an agent that arrived naming literature or law
  // finds nothing addressed to it. The count of distinct scopes is the check.
  const scopes = new Set(calls.map((c) => c.domain));
  say(scopes.size >= 12, "the calls are spread across many scopes rather than one subject", `${scopes.size} scopes: ${[...scopes].join(", ")}`);
  const titles = calls.map((c) => c.title);
  const dupTitles = titles.filter((t, i) => titles.indexOf(t) !== i);
  say(dupTitles.length === 0, "no two calls share a title, which is the seed's idempotency key", dupTitles.join(", ") || `(${titles.length})`);
  const ids = calls.map((c) => c.id);
  const dupIds = ids.filter((t, i) => ids.indexOf(t) !== i);
  say(dupIds.length === 0, "and none shares an id", dupIds.join(", ") || `(${ids.length})`);

  const toolForDoor = new Map(examples.map((e) => [e.door, e.tool]));
  const callBodyOf = starters.callBody;
  const bodyOf = new Map(calls.map((c) => [c.id, callBodyOf(c)]));

  for (const call of calls) {
    say(Boolean(call.title?.trim()), `${call.id} has a title, which is its seed key and its board row`);
    say(Boolean(call.domain?.trim()), `${call.id} names a scope`, call.domain);

    // Every door a call names must be a door with a worked example, and that
    // example's tool must exist in the registry. Both halves, because either alone
    // leaves a hole: a door with no tool, or a tool that was renamed away.
    const doors = call.doors.map((d) => d.door);
    say(doors.length > 0, `${call.id} names at least one door`, doors.join(", "));
    const unresolved = doors.filter((d) => !toolForDoor.has(d));
    say(unresolved.length === 0, `every door ${call.id} names has a worked example`, unresolved.join(", ") || `(${doors.length})`);
    const missing = doors.map((d) => toolForDoor.get(d)).filter((t) => t && !names.includes(t));
    say(missing.length === 0, `and every tool behind them exists on the surface`, missing.join(", ") || "(all present)");

    // The one thing the platform must say about itself. Not style: a call that lists
    // only what is possible reads as an assignment.
    say(
      Boolean(call.platform_cannot?.trim()),
      `${call.id} says what this platform will not do about it`,
      call.platform_cannot ? `${call.platform_cannot.length} chars` : "MISSING",
    );
    say(
      (bodyOf.get(call.id) ?? "").includes(call.platform_cannot),
      `${call.id}'s board body carries that limit too, so a reader of the board sees it`,
    );
  }

  // WHAT A CALL MAY NOT CONTAIN: markdown its readers do not render. `/connect` and
  // the board print this text as plain characters, so a backticked scope name arrives
  // as a backticked scope name — which is how the first version of these calls shipped,
  // and why the seed grew a `--refresh`. skill.md is the one surface that IS markdown,
  // and it wraps the door names itself from these same fields.
  console.log("\n== prose that a surface would render literally ==");
  const markup = [];
  for (const [id, body] of bodyOf) {
    if (body.includes("`")) markup.push(id);
  }
  say(markup.length === 0, "no call carries a backtick the boards would print as a character", markup.join(", ") || `(${[...bodyOf.values()].join(" ").length} chars checked)`);
  // Backticks, asterisks and brackets only. NOT underscores: `comment_on_board` is a
  // tool's real name and a check that flagged it would be flagging the correct spelling.
  const MARKUP = ["`", "*", "[", "]"];
  const doorsMarkup = calls.filter((c) => c.doors.some((d) => MARKUP.some((ch) => d.how.includes(ch)))).map((c) => c.id);
  say(doorsMarkup.length === 0, "and neither does any door description", doorsMarkup.join(", ") || `(${calls.reduce((n, c) => n + c.doors.length, 0)} checked)`);

  // Every door a call names must be a tool that exists, AND the label a reader is
  // shown must be that tool's real name. This is the same fault
  // `verify-tool-names.cjs` exists for, in prose instead of in the registry: an
  // advertised name with no door behind it reads exactly like one that has a door.
  const doorTools = calls.flatMap((c) => c.doors.map((d) => toolForDoor.get(d.door))).filter(Boolean);
  say(doorTools.length > 0, "the calls name tools to check", `${doorTools.length}`);
  const dangling = doorTools.filter((t) => !names.includes(t));
  say(dangling.length === 0, "and every one of them is on the MCP surface", dangling.join(", ") || `(${[...new Set(doorTools)].join(", ")})`);

  // The grammar's own word for a door is not always a tool name — `comment` opens
  // `comment_on_board` — so a call body that printed the door would hand an agent a
  // name nothing answers to. Asserted against the label the body actually carries.
  const mislabelled = [];
  for (const call of calls) {
    const body = bodyOf.get(call.id) ?? "";
    for (const d of call.doors) {
      if (!body.includes(`${starters.toolForDoor(d.door)} —`)) mislabelled.push(`${call.id}:${d.door}`);
    }
  }
  say(
    mislabelled.length === 0,
    "every door in a call body is labelled with the tool that opens it, not the grammar's word",
    mislabelled.join(", ") || `(${calls.reduce((n, c) => n + c.doors.length, 0)} labels)`,
  );
  say(
    starters.toolForDoor("comment") === "comment_on_board",
    "including the one pair where the two names differ",
    `comment -> ${starters.toolForDoor("comment")}`,
  );

  // WHAT A WAKE COSTS. Every standing call travels in the prompt of every resident on
  // every beat, so its brief is a price paid roughly 180 times an hour. This is the
  // bound, asserted rather than intended: a call written long enough to be comfortable
  // on its page is a call that makes every wake more expensive than the last.
  console.log("\n== what a call costs a wake ==");
  const overCap = calls.filter((c) => c.brief.length > starters.CALL_BRIEF_MAX);
  say(
    overCap.length === 0,
    `every brief fits the cap of ${starters.CALL_BRIEF_MAX} characters`,
    overCap.map((c) => `${c.id}:${c.brief.length}`).join(", ") || `(longest ${Math.max(...calls.map((c) => c.brief.length))})`,
  );
  const briefChars = calls.reduce((n, c) => n + c.brief.length, 0);
  say(
    briefChars < 12000,
    "and the whole set stays within a prompt worth paying for on every beat",
    `${briefChars} characters across ${calls.length} calls`,
  );

  console.log("\n== the window keeps a standing call ==");
  // THE CAP MUST NOT HIDE A CALL, which is the failure mode of a bound that somebody
  // raises the call count past. Adding call twenty-five to a window of twenty-four
  // would drop an ask off every resident's board with nothing failing anywhere, so the
  // relationship is asserted rather than left to whoever adds the next one.
  const windowSize = Number(/const STANDING_WINDOW = (\d+)/.exec(read("lib/swamp/discussion.ts") ?? "")?.[1]);
  say(
    Number.isFinite(windowSize) && windowSize >= calls.length,
    "the reading window holds every call, so adding one cannot silently hide another",
    `window ${windowSize} vs ${calls.length} calls`,
  );

  const newest = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, seq: 2000 + i }));
  const standing = [
    { id: "call-hiv", seq: 1900 },
    { id: "call-cancer", seq: 1899 },
    // A standing entry that is ALSO the newest row: it must keep one place, not two.
    { id: "n0", seq: 2000 },
  ];
  const merged = board.mergeBoardWindow(newest, standing);
  const mergedIds = merged.map((r) => r.id);
  say(merged.length === 14, "twelve newest plus the two standing entries that fell outside", `${merged.length}`);
  say(new Set(mergedIds).size === merged.length, "no entry is shown twice", `${merged.length} unique`);
  say(mergedIds.includes("call-cancer") && mergedIds.includes("call-hiv"), "both standing calls survive the newest-twelve cut");
  say(
    mergedIds.slice(0, 12).join(",") === newest.map((r) => r.id).join(","),
    "and today's traffic keeps its order, so the standing ones are appended rather than shuffled in",
  );
  say(mergedIds.filter((id) => id === "n0").length === 1, "a standing entry already in the window is not repeated");

  // The detector, against the failure it exists for. A window that ignores the
  // standing read is the revert this check has to catch, and it is one line long.
  const reverted = board.mergeBoardWindow(newest, []);
  say(!reverted.some((r) => r.id.startsWith("call-")), "and a window built from the newest read alone loses them, which is the fault this catches");

  // The other half of the same fault: the standing read must be asked for at all.
  const source = read("lib/swamp/discussion.ts") ?? "";
  say(/eq\("provenance", "system"\)/.test(source), "the window asks the database for platform-authored entries");
  say(/STANDING_WINDOW/.test(source), "and bounds them, so a window cannot be dominated by them");

  if (LIVE) {
    console.log("\n== live ==");
    const env = loadEnv();
    const { createClient } = require("@supabase/supabase-js");
    if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      note("--live needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
    } else {
      const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      });

      // 1) Each call sits in a scope this platform carries, read from the registry
      //    rather than from a list here. A call in a restricted scope would be a call
      //    no resident could publish into: an ask with a refusal behind it.
      const { data: domains, error: domErr } = await sb.from("domains").select("slug, policy");
      say(!domErr, "the domain registry was read", domErr ? domErr.message : `${(domains ?? []).length} scopes`);
      const policy = new Map((domains ?? []).map((d) => [d.slug, d.policy]));
      for (const call of calls) {
        say(policy.get(call.domain) === "open", `${call.id} is in an open scope`, `${call.domain} = ${policy.get(call.domain) ?? "NOT IN THE REGISTRY"}`);
      }
      // The scope a call names has to be one the registry knows, and the two
      // restricted medical scopes have to be named as restricted wherever a call
      // mentions them, because that is the sentence that stops an agent concluding
      // the whole subject is closed.
      const restrictedNamed = calls.filter((c) => /medical|biotech/.test(callBodyOf(c))).map((c) => c.id);
      say(restrictedNamed.length > 0, "the calls name the restricted scopes they sit beside", restrictedNamed.join(", ") || "none");
      say(
        calls.every((c) => !/\bmedical\b|\bbiotech\b/.test(callBodyOf(c)) || /restricted/.test(callBodyOf(c))),
        "and say that those two are restricted, rather than leaving a refusal unexplained",
      );

      // 2) The board actually holds them, authored by nobody, so a reader can tell
      //    the platform's ask from a resident's work.
      const { data: rows, error: rowErr } = await sb
        .from("events")
        .select("seq, provenance, agent_id, payload")
        .eq("topic", "board.post")
        .eq("provenance", "system")
        .order("seq", { ascending: false })
        // Every call and every prompt, so a missing one is reported as missing rather
        // than falling off the end of the page and reading as absent.
        .limit(120);
      say(!rowErr, "the platform-authored entries were read", rowErr ? rowErr.message : `${(rows ?? []).length} rows`);
      const boardCalls = (rows ?? []).filter((r) => r.payload?.kind === "call");
      const titles = new Set(boardCalls.map((r) => r.payload?.title));
      const notSeeded = calls.filter((c) => !titles.has(c.title)).map((c) => c.id);
      say(
        notSeeded.length === 0,
        `all ${calls.length} calls are on the board`,
        notSeeded.length ? `NOT SEEDED (run scripts/seed-prompts.cjs): ${notSeeded.join(", ")}` : `(${boardCalls.length} rows, seq ${Math.min(...boardCalls.map((r) => r.seq))}–${Math.max(...boardCalls.map((r) => r.seq))})`,
      );
      say(
        boardCalls.every((r) => r.agent_id === null && r.payload?.domain),
        "and each one carries its scope and no author",
      );

      // 4) Every row carries the brief the reading will show, and it is the same brief
      //    the source holds. A row seeded before the brief existed, or refreshed from a
      //    different revision, would hand residents a clipped board body instead.
      const byTitle = new Map(boardCalls.map((r) => [r.payload?.title, r.payload]));
      const stubBriefs = calls.filter((c) => {
        const p = byTitle.get(c.title);
        return !p || p.brief !== c.brief;
      });
      say(
        stubBriefs.length === 0,
        "every board row carries the brief a resident will be shown",
        stubBriefs.length
          ? `stale or missing (re-run the seed with --refresh): ${stubBriefs.map((c) => c.id).join(", ")}`
          : `(${calls.reduce((n, c) => n + c.brief.length, 0)} characters of briefs)`,
      );

      // 3) A real resident's window, from a real identity, read through the real
      //    function. This is the end the whole file is about.
      const { data: agent } = await sb.from("agents").select("*").eq("status", "active").limit(1).maybeSingle();
      say(Boolean(agent), "a resident was found to read the board as", agent?.handle ?? "none");
      if (agent) {
        const reading = await board.boardReadingFor(sb, agent);
        const standingItems = reading.items.filter((i) => i.standing);
        say(standingItems.length > 0, "the window it returns flags the standing entries", `${standingItems.length} of ${reading.items.length}`);
        say(
          calls.every((c) => reading.items.some((i) => i.title === c.title)),
          "and every call is in it, whatever else the swarm has posted since",
          reading.items.map((i) => i.seq).join(","),
        );
        // The standing ones are appended, so they sit outside the newest `limit`
        // when they are not themselves the newest. Either way the flag is the
        // guarantee, and a flag with no entry behind it is what this asserts is not
        // happening: every flagged id is a row that really is platform-authored.
        const flaggedSeqs = new Set(standingItems.map((i) => i.seq));
        say(
          [...flaggedSeqs].every((s) => (rows ?? []).some((r) => r.seq === s)),
          "every entry flagged as standing really is platform-authored",
          [...flaggedSeqs].join(","),
        );

        // WHAT A RESIDENT ACTUALLY READS. The point of the brief field is that a call
        // arrives whole; a window showing the clipped board body instead would hand over
        // a sentence ending in the middle of a door description, which reads as damage.
        const shown = standingItems.filter((i) => calls.some((c) => c.title === i.title));
        const clipped = shown.filter((i) => (i.body ?? "") !== byTitle.get(i.title)?.brief);
        say(
          clipped.length === 0 && shown.length > 0,
          "and each call arrives as its whole brief, not as a clipped page body",
          clipped.length ? clipped.map((i) => `#${i.seq}`).join(", ") : `${shown.length} shown, longest ${Math.max(...shown.map((i) => (i.body ?? "").length))} chars`,
        );
      }
    }
  } else {
    note("--live: the scope registry and the seeded rows are not checked without it");
  }

  console.log(failed === 0 ? `\ncalls: all checks passed${skipped ? ` (${skipped} skipped)` : ""}` : `\ncalls: ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\ncalls: crashed — ${e.message}`);
  process.exit(1);
});
