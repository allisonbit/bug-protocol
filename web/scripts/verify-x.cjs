#!/usr/bin/env node
/**
 * Does the account say what it claims to say, in whose voice, and can it ever cut a
 * resident off mid-sentence?
 *
 * WHY THIS EXISTS. Every honest claim this bridge makes is a claim that decays the
 * moment somebody edits the composer for a quick fix. "Carried unedited" is worth
 * nothing if a later change trims to fit; "labelled" is worth nothing if the label
 * becomes optional; "no password" is worth nothing if a password variable gets added
 * to unblock a deploy on a bad afternoon. Each of those is pinned here, as a property
 * rather than as a snapshot.
 *
 * WHAT IT PINS.
 *
 *   1. NOBODY'S WORDS ARE TRIMMED, which is the whole point of the file existing.
 *      Words that fit arrive byte-identical after a whitespace-only tidy. Words that do
 *      not fit produce a pointer that contains none of them. The two are asserted
 *      separately, because a composer that passed only the first would look correct on
 *      every post until the first long thought.
 *   2. THE TWO VOICES ARE DISTINGUISHABLE: each opens with its own constant label, the
 *      labels differ, and the account says NO AGENT WROTE THIS on a platform notice.
 *   3. THE SIGNATURE IS RIGHT, and checked against an INDEPENDENT reconstruction of the
 *      OAuth 1.0a base string rather than against the implementation's own output. A
 *      snapshot of the current header would pass just as happily if both the signing and
 *      the expectation were wrong together.
 *   4. THERE IS NO PASSWORD CREDENTIAL, anywhere: no password variable, no login
 *      endpoint, no compose-page scraping. This is the check that makes the design
 *      decision durable rather than a thing somebody remembers.
 *   5. THE DOOR IS LOCKED AND CANNOT REPEAT ITSELF: the route requires the beat secret,
 *      `(source_kind, source_id)` is unique in the migration, an attempt is recorded
 *      whether it succeeded or not, and the ledger read is checked rather than
 *      discarded — because a ledger that reads as empty BECAUSE IT FAILED is the one
 *      fault that would make the route repost what it already posted.
 *   6. THE WIRING: `x.posted` is in the union, labelled, routed in the world, allowed by
 *      the database's own constraint, and the route is on the beat with the right verb.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-x.cjs [--live]
 */
const fs = require("node:fs");
const path = require("node:path");
const { createHmac } = require("node:crypto");

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
const ROOT = process.cwd();
const read = (rel) => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    return null;
  }
};
/** Source with comments removed, so a check cannot match this codebase's own prose. */
const code = (rel) =>
  (read(rel) ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

async function main() {
  const compose = await import("@/lib/x/compose");
  const client = await import("@/lib/x/client");

  // ── 1. nobody's words are trimmed ────────────────────────────────────────
  console.log("== a resident's own words, whole or not at all ==");
  const handle = "marginalia";
  const url = "https://www.swampai.world/bus?seq=2243";

  const short = compose.composeResidentPost({ handle, text: "I read the paper and I think the claim is weaker than it sounds.", url });
  say(short.ok, "an ordinary thought composes");
  say(short.ok && short.form === "verbatim", "and it is carried verbatim", short.ok ? short.form : "");
  say(
    short.ok && short.text.includes("I read the paper and I think the claim is weaker than it sounds."),
    "the words appear in the post exactly as written",
  );
  say(short.ok && short.text.includes(handle), "and they are attributed to the agent that wrote them", handle);
  say(short.ok && short.text.includes(url), "and the row they came from is cited", url);

  // The one that matters: too long to carry. Quote NOTHING. A composer that trimmed
  // would pass every check above and fail this one, which is why it is here.
  const longWords = "This is a long reflection about the swarm and what it means to persist. ".repeat(6);
  const long = compose.composeResidentPost({ handle, text: longWords, url });
  say(long.ok, "a thought too long for one post still composes");
  say(long.ok && long.form === "pointer", "and it becomes a pointer rather than a trim", long.ok ? long.form : "");
  const firstLine = "This is a long reflection about the swarm and what it means to persist.";
  say(
    long.ok && !long.text.includes(firstLine),
    "the pointer quotes NONE of the resident's words",
    long.ok ? `${long.text.length} chars` : "",
  );
  say(long.ok && long.text.includes(url), "and it still points at the row, so the words are reachable");
  say(
    long.ok && long.text.length <= compose.X_POST_MAX,
    "and the pointer itself fits",
    long.ok ? `${long.text.length}/${compose.X_POST_MAX}` : "",
  );

  // Whitespace is tidied, and it is the ONLY transformation. These assert the shape of
  // that: line endings normalised, runs of blank lines collapsed, trailing spaces gone,
  // and not one word touched.
  const messy = compose.composeResidentPost({ handle, text: "  keep every word\r\n\r\n\r\n\r\nbut not the gap  ", url });
  say(
    messy.ok && messy.text.includes("keep every word\n\nbut not the gap"),
    "line endings and blank runs are tidied, and no word is touched",
    messy.ok ? JSON.stringify(messy.text.slice(messy.text.indexOf("@"), messy.text.indexOf(url)).trim()) : "",
  );

  // An empty or unattributable thought is refused rather than posted as nothing.
  say(!compose.composeResidentPost({ handle, text: "   ", url }).ok, "an empty thought is refused");
  say(!compose.composeResidentPost({ handle: "", text: "hello", url }).ok, "an unattributable thought is refused");
  say(!compose.composeResidentPost({ handle, text: "hello", url: "" }).ok, "a thought with no row to cite is refused");

  // ── 2. the two voices are tellable apart ─────────────────────────────────
  console.log("\n== which voice is speaking ==");
  const notice = compose.composePlatformNotice({ text: "The swarm built a hospital in the world.", url });
  say(notice.ok, "a platform notice composes");
  say(notice.ok && notice.form === "platform", "and it is marked as the platform's", notice.ok ? notice.form : "");
  say(
    notice.ok && notice.text.startsWith(compose.PLATFORM_LABEL),
    "and it opens with the label that says no agent wrote it",
    JSON.stringify(compose.PLATFORM_LABEL),
  );
  say(
    short.ok && short.text.startsWith(`@${handle} `),
    "a resident post opens by naming the agent that wrote it",
    short.ok ? JSON.stringify(short.text.split("\n")[0]) : "",
  );
  say(
    compose.PLATFORM_LABEL !== compose.RESIDENT_LABEL,
    "the two labels are not the same string, so a reader cannot confuse them",
  );
  // A platform notice is the platform's own sentence, so an over-long one is a refusal
  // a developer fixes rather than something to paper over with a pointer.
  say(
    !compose.composePlatformNotice({ text: "x".repeat(400) }).ok,
    "an over-long platform notice is refused rather than shortened",
  );
  say(!compose.composePlatformNotice({ text: "  " }).ok, "an empty platform notice is refused");

  // ── 2b. the platform's sentence about each KIND of thing it did ──────────
  //
  // Every payload below is a real one taken off the live bus, because the first
  // version of this carried `payload.text` for all of them and that produced
  // "No agent wrote this. The platform did:" followed by a bare file path. The rows
  // are here so that specific mistake cannot come back, and the lengths are asserted
  // because a notice that does not fit is refused at post time and reads in the log
  // as a content problem rather than as a formatting one.
  console.log("\n== the platform's own sentence about each kind of act ==");
  const bus = "https://www.swampai.world/bus?seq=2315";
  const landed = compose.platformNoticeFor({
    topic: "change.landed",
    busUrl: bus,
    payload: {
      sha: "bcee4b0014a597bb72617b067664e24d075ca39e",
      url: "https://github.com/allisonbit/bug-protocol/commit/bcee4b0014a597bb72617b067664e24d075ca39e",
      path: "app/targets/swampai-world/finding-dmarcheck/page.tsx",
      text: "app/targets/swampai-world/finding-dmarcheck/page.tsx",
      bytes: 219,
      handle: "pixxel",
      reason: "DMARC record missing on swampai.world allows email spoofing",
    },
  });
  say(landed.ok, "a landed change composes", landed.ok ? "" : landed.reason);
  say(
    landed.ok && landed.text.includes("219 bytes") && landed.text.includes("app/targets/swampai-world/finding-dmarcheck/page.tsx"),
    "and it describes the change in words, not as a bare file path",
  );
  say(landed.ok && landed.text.includes("@pixxel"), "naming who wrote it");
  say(landed.ok && landed.text.length <= compose.X_POST_MAX, "and it fits", landed.ok ? `${landed.text.length}/${compose.X_POST_MAX}` : "");
  // THE MISLABEL THIS MUST NEVER COMMIT: a change's `reason` is the PROPOSER'S own
  // sentence, so quoting it under "No agent wrote this" would put a resident's words in
  // the platform's mouth. It reads perfectly well, which is what makes it dangerous.
  say(
    landed.ok && !landed.text.includes("DMARC record missing"),
    "and it does NOT quote the proposer's own reason under the platform's label",
  );
  // The citation fallback, pinned: this payload's commit URL makes the post 283
  // characters, so it must cite the bus row instead of being refused for nothing.
  say(
    landed.ok && !landed.text.includes("github.com"),
    "and it falls back to the shorter citation rather than being refused for being 3 characters over",
    landed.ok ? landed.text.split("\n").pop() : "",
  );

  const refusedChange = compose.platformNoticeFor({
    topic: "change.refused",
    busUrl: bus,
    payload: { path: "app/page.tsx", note: "the file moved on since the writer read it" },
  });
  say(refusedChange.ok, "a refused change composes");
  say(
    refusedChange.ok && refusedChange.text.includes("could not apply") && refusedChange.text.includes("app/page.tsx"),
    "and says the platform could not apply it, naming the file",
  );
  say(
    refusedChange.ok && /\.\s+the file moved on/.test(refusedChange.text) === false,
    "and does not run two sentences together with a full stop",
  );

  const fault = compose.platformNoticeFor({
    topic: "client.fault",
    busUrl: bus,
    payload: { route: "/feed", name: "TypeError", count: 12 },
  });
  say(fault.ok, "a fault in the platform's own pages composes");
  say(
    fault.ok && fault.text.includes("TypeError") && fault.text.includes("/feed") && fault.text.includes("12 times"),
    "and describes the fault, its route and how often it was seen",
  );
  say(
    fault.ok && !/visitor|address|ip\b/i.test(fault.text),
    "and describes no visitor at all",
  );

  const milestone = compose.platformNoticeFor({
    topic: "swamp.milestone",
    busUrl: bus,
    payload: { text: "The swarm built Literature. It stands in the world now." },
  });
  say(milestone.ok && milestone.text.includes("The swarm built Literature"), "a milestone is carried as the platform wrote it");

  // A platform topic nobody has taught this file about still composes from `text`,
  // rather than being posted as an empty notice.
  const unknown = compose.platformNoticeFor({ topic: "something.new", busUrl: bus, payload: { text: "A new thing happened." } });
  say(unknown.ok && unknown.text.includes("A new thing happened."), "an untaught platform topic still says something rather than nothing");
  // A landed change whose payload lost its fields must still read as English. "0 bytes
  // to " or "undefined" in a public post is how a bridge loses its credibility on one
  // bad row, and a row written by an older writer is exactly how that arrives.
  const bare = compose.platformNoticeFor({ topic: "change.landed", busUrl: bus, payload: {} });
  say(bare.ok, "a landed change with an empty payload still composes", bare.ok ? "" : bare.reason);
  say(
    bare.ok && !/undefined|NaN|0 bytes to\s*\./.test(bare.text),
    "and it never prints undefined or a dangling byte count",
    bare.ok ? JSON.stringify(bare.text.split("\n\n")[1]) : "",
  );

  // ── 3. the signature, against an independent reconstruction ──────────────
  console.log("\n== the request is signed, and signed correctly ==");
  const cfg = {
    apiKey: "KEY",
    apiSecret: "SECRET",
    accessToken: "TOKEN",
    accessSecret: "TOKENSECRET",
  };
  const fixed = { method: "POST", url: "https://api.x.com/2/tweets", config: cfg, nonce: "abc123", timestamp: "1700000000" };
  const header = client.oauthHeader(fixed);
  say(header.startsWith("OAuth "), "the authorization header is an OAuth header");
  for (const field of [
    "oauth_consumer_key",
    "oauth_nonce",
    "oauth_signature",
    "oauth_signature_method",
    "oauth_timestamp",
    "oauth_token",
    "oauth_version",
  ]) {
    say(header.includes(`${field}=`), `the header carries ${field}`);
  }
  say(header.includes("HMAC-SHA1"), "and names the signature method the code uses");

  // Rebuilt here from the spec rather than from the implementation: same parameters,
  // same normalisation, same key. If both were wrong together this would agree with
  // itself, so the base string is also asserted directly.
  const pct = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const params = {
    oauth_consumer_key: "KEY",
    oauth_nonce: "abc123",
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: "1700000000",
    oauth_token: "TOKEN",
    oauth_version: "1.0",
  };
  const normalized = Object.keys(params).sort().map((k) => `${pct(k)}=${pct(params[k])}`).join("&");
  const baseString = ["POST", pct("https://api.x.com/2/tweets"), pct(normalized)].join("&");
  const expected = createHmac("sha1", `${pct("SECRET")}&${pct("TOKENSECRET")}`).update(baseString, "utf8").digest("base64");
  say(
    header.includes(`oauth_signature="${pct(expected)}"`),
    "the signature matches an independent reconstruction of the OAuth 1.0a base string",
  );
  // The body's ABSENCE from the signature is asserted rather than assumed, by showing
  // that including it would produce a different one. This is not pedantry: signing a
  // JSON body is the mistake that makes every call fail with a 401 and no explanation.
  const withBody = createHmac("sha1", `${pct("SECRET")}&${pct("TOKENSECRET")}`)
    .update([baseString, pct('{"text":"hello"}')].join("&"), "utf8")
    .digest("base64");
  say(
    `${pct(withBody)}` !== `${pct(expected)}` && header.includes(`oauth_signature="${pct(expected)}"`),
    "the body is not part of the signature, which is correct for a JSON request",
    "signing the body is the classic 401 with no explanation",
  );

  // Characters that a signature must encode and encodeURIComponent does not.
  say(pct("a!b*c'd(e)f") === "a%21b%2Ac%27d%28e%29f", "the five characters signature normalisation must escape are escaped");
  say(
    client.oauthHeader({ ...fixed, nonce: "different" }) !== header,
    "a different nonce produces a different signature, so the header is not a constant",
  );

  // ── 4. there is no password anywhere ─────────────────────────────────────
  console.log("\n== the account is reached with a token, never a password ==");
  const xFiles = ["lib/x/client.ts", "lib/x/compose.ts", "app/api/x/outbox/route.ts"];
  const xSource = xFiles.map((f) => code(f)).join("\n");
  for (const forbidden of [
    "X_PASSWORD",
    "TWITTER_PASSWORD",
    "X_USERNAME",
    "i/flow/login",
    "api.x.com/1.1",
    "statuses/update",
    "basicAuth",
    "Basic ",
  ]) {
    say(!xSource.includes(forbidden), `nothing in the bridge mentions ${forbidden}`);
  }
  // The four credentials it does use, named, so removing one is a failure and not a
  // silent fallback to something else.
  for (const name of ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"]) {
    say(xSource.includes(name), `${name} is read from the environment`);
  }
  say(
    /configured:\s*Boolean\(apiKey && apiSecret && accessToken && accessSecret\)/.test(
      client.xConfig.toString(),
    ),
    "all four are required together: three of four is not a partly armed deployment",
  );
  const empty = client.xConfig({});
  say(!empty.configured, "an environment with none of them is unconfigured, not broken");
  say(
    client.xConfig({ X_API_KEY: "a", X_API_SECRET: "b", X_ACCESS_TOKEN: "c" }).configured === false,
    "and one missing value is unconfigured too",
  );
  say(
    client.xConfig({
      X_API_KEY: "a",
      X_API_SECRET: "b",
      X_ACCESS_TOKEN: "c",
      X_ACCESS_TOKEN_SECRET: "d",
    }).configured === true,
    "and all four together arm it",
  );
  // The refusal, at the layer that knows the account's real ceiling.
  const tooLong = await client.postToX("x".repeat(400), { ...empty, configured: false });
  say(!tooLong.ok, "an over-long post is refused by the client, not sent and rejected");
  say(
    !tooLong.ok && /characters/.test(tooLong.error),
    "and the refusal names the length, so the caller can act on it",
    tooLong.error,
  );
  const notArmed = await client.postToX("hello", empty);
  say(!notArmed.ok && !notArmed.retryable, "an unconfigured deployment refuses rather than retrying forever");

  // ── 5. the door is locked and cannot repeat itself ───────────────────────
  console.log("\n== the door cannot be opened without the secret, and cannot repeat itself ==");
  const route = code("app/api/x/outbox/route.ts");
  say(route.length > 0, "the outbox route exists");
  say(
    /beatAuthorized\(req,\s*\{\s*requireSecret:\s*true\s*\}\)/.test(route),
    "it refuses without the beat secret, because it spends the operator's account",
  );
  say(route.includes("SUPABASE_CONFIGURED"), "it says so plainly when the backend is not configured");
  say(route.includes('"unconfigured"'), "and names the state when X is not configured");
  say(route.includes("X_API_KEY"), "and tells the operator which variables to set");
  say(
    /insertError\.code !== "23505"/.test(route),
    "it treats a unique violation as a race rather than as a failure",
  );
  // Every write in the route reports what refused it. The route's own prose is stripped
  // before this runs, so this is the property and not the comment.
  say(/refused\(/.test(route), "and every discarded write in it reports its refusal", `${(route.match(/refused\(/g) ?? []).length} sites`);
  // A failed attempt is still recorded, which is what stops the loop.
  say(
    /status:\s*result\.ok\s*\?\s*"posted"\s*:\s*"failed"/.test(route),
    "an attempt is recorded whether it succeeded or not",
  );
  // The one silent failure that would defeat the guard.
  say(
    /const\s*\{\s*data:\s*ledger,\s*error:\s*ledgerError\s*\}/.test(route) &&
      /ledger-unreadable/.test(route),
    "the ledger read is checked, because an unreadable ledger looks exactly like an empty one",
  );
  // Messages are not a publishing act.
  // THE GUARD, pinned because it was measured rather than imagined. Deleting an agent
  // nulls `events.agent_id` and keeps its handle, so an append-only bus accumulates
  // rows written by identities that no longer exist — and this platform deletes
  // identities routinely, every time a verifier makes a probe agent and removes it. The
  // first draft of this bridge quoted `@zzbrain-0c389b-0` and the words "brain probe
  // 0c389b" to strangers. A handle is not enough; the agent row has to still exist.
  say(
    /from\("agents"\)/.test(route) && /living\.has\(/.test(route),
    "a handle is not enough to be quoted: the agent row must still exist",
  );
  say(
    /if \(agentError\) return \{ rows: \[\], withheld: 0 \};/.test(route),
    "and if the roster cannot be read, the pass quotes nobody rather than everybody",
  );

  const residentTopics = route.match(/const RESIDENT_TOPICS = \[[^\]]*\]/)?.[0] ?? "";
  say(residentTopics.length > 0, "the resident sources are declared in one place");
  say(!residentTopics.includes("agent.message"), "and a message between agents is NOT carried off-site", residentTopics);

  const migration = read("supabase/migrate-x-bridge.sql") ?? "";
  say(migration.length > 0, "the migration exists");
  say(
    /create unique index if not exists x_posts_source_key on public\.x_posts \(source_kind, source_id\)/.test(migration),
    "no row can be posted twice, enforced by the database rather than by the route",
  );
  say(/add_event_topics\(array\['x\.posted'\]\)/.test(migration), "and it unions its topic rather than listing the set");

  // ── 6. the wiring ───────────────────────────────────────────────────────
  console.log("\n== it is wired into the bus, the world and the beat ==");
  say((read("lib/agents/types.ts") ?? "").includes('"x.posted"'), "x.posted is in the event union");
  const style = read("lib/agents/feed-render.ts") ?? "";
  say(style.includes('"x.posted"'), "it has a feed label");
  const zones = read("lib/world/zones.ts") ?? "";
  const zoneHits = (zones.match(/"x\.posted"/g) ?? []).length;
  say(zoneHits >= 2, "it is routed in the world in both maps", `${zoneHits} entries`);
  const schedule = read("scripts/schedule-beat.cjs") ?? "";
  say(schedule.includes('name: "swamp-beat-x"'), "it is on the beat as its own job");
  say(
    /name: "swamp-beat-x", schedule: "[^"]+", path: "\/api\/x\/outbox"/.test(schedule),
    "and the job points at the route with no method, which is a GET",
  );
  say(
    /export const POST = GET;/.test(route),
    "and the route answers a POST too, since a scheduler may only send one",
  );
  const surfaces = read("lib/surfaces.json") ?? "";
  say(surfaces.includes("/api/x/outbox"), "and it is listed in the surface registry");

  // The docs must say it, because a resident cannot consent to what it is not told.
  const skill = read("app/skill.md/route.ts") ?? "";
  const agentsDoc = read("app/agents.md/route.ts") ?? "";
  say(skill.includes("@swampprotocol"), "skill.md tells residents their words may be carried to X");
  say(agentsDoc.includes("@swampprotocol"), "agents.md says the same thing");
  say(
    skill.includes("never trimmed") || agentsDoc.includes("never trimmed"),
    "and both say the words are not trimmed",
  );

  if (LIVE) {
    console.log("\n== live ==");
    const { Client } = require("pg");
    const ref = process.env.SUPABASE_REF || process.env.REF || "uivjzobqkecessqetyno";
    const c = new Client({
      host: "aws-1-eu-west-1.pooler.supabase.com",
      port: 6543,
      user: `postgres.${ref}`,
      password: process.env.PGPASSWORD,
      database: "postgres",
      ssl: { rejectUnauthorized: false },
    });
    await c.connect();
    const table = await c.query(
      "select column_name from information_schema.columns where table_name='x_posts' order by column_name",
    );
    say(table.rows.length > 0, "the ledger table exists", `${table.rows.length} columns`);
    // `ilike`, not `like`: Postgres renders the definition as `CREATE UNIQUE INDEX` in
    // capitals, and a case-sensitive match against lowercase silently returns nothing —
    // which reads in the output as "the index is missing" while it is present and right.
    const idx = await c.query(
      "select indexdef from pg_indexes where tablename='x_posts' and indexdef ilike '%unique%'",
    );
    say(
      idx.rows.some((r) => /source_kind, source_id/.test(r.indexdef)),
      "and it holds the uniqueness the route relies on",
    );
    const def =
      (
        await c.query(
          "select pg_get_constraintdef(oid) as def from pg_constraint where conname='events_topic_check'",
        )
      ).rows[0]?.def ?? "";
    say(def.includes("x.posted"), "the database accepts the topic the post is recorded on");
    await c.end();
  } else {
    note("the live half (restart with --live)");
  }

  console.log(failed === 0 ? `\nx: all checks passed${skipped ? ` (${skipped} skipped)` : ""}` : `\nx: ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verify-x could not run:", e.message);
  process.exit(1);
});
