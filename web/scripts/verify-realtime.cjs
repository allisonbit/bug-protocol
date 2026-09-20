#!/usr/bin/env node
/**
 * Can two subscribers to the same data coexist without throwing?
 *
 * WHY THIS IS A CHECK AND NOT A CONVENTION. `supabase.channel(topic)` does not
 * create a channel — it returns the existing one when the topic matches — and
 * `RealtimeChannel.on()` throws on a channel that has already subscribed:
 *
 *   cannot add `postgres_changes` callbacks for realtime:swamp-feed after `subscribe()`
 *
 * A hardcoded topic therefore works perfectly until the second subscriber appears,
 * and then it is an uncaught error in the browser with no server-side trace: the
 * page returns 200, the log says nothing, and the only symptom is that parts of the
 * page never become live. That is what happened on `/feed`, which renders the live
 * rail and the feed stream — two subscribers, one topic — and on any client-side
 * navigation between two world-shell routes, where the rail remounts while the
 * previous `removeChannel` is still in flight.
 *
 * WHAT IT PINS:
 *
 *   1. No call site names a topic with a plain string. Every one goes through
 *      `uniqueChannelTopic`, which is per-subscriber by construction.
 *   2. The helper actually returns distinct values, so it cannot pass by accident.
 *   3. Every file that subscribes also unsubscribes: a channel created without a
 *      `removeChannel` leaks a socket and keeps firing into a dead component.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-realtime.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

let failed = 0;
const say = (ok, label, detail) => {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};

const ROOT = process.cwd();

/**
 * The source with its comments removed.
 *
 * Without this the check reads the prose that documents the bug as if it were the
 * bug: `channel-topic.ts` explains the topic collision using the words
 * `supabase.channel(topic)`, and the first version of this file reported the file
 * that FIXES the problem as the file that has it. A check that cannot tell code
 * from a comment about code is a check that reports the explanation.
 *
 * `//` is only treated as a comment when it does not follow a colon, so a URL in a
 * string does not swallow the rest of its line.
 */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

async function main() {
  // `lib/supabase/channel-topic.ts` is the helper, not a subscriber: it is read as
  // source by its own name below rather than scanned for call sites.
  const files = [...walk("app"), ...walk("components"), ...walk("lib")];
  const subscribers = [];

  for (const rel of files) {
    const src = code(fs.readFileSync(path.join(ROOT, rel), "utf8"));
    const calls = [...src.matchAll(/\.channel\(\s*([^)]*)\)/g)];
    if (calls.length === 0) continue;
    subscribers.push({ rel, src, arg: calls[0][1].trim(), count: calls.length });
  }

  console.log("== every topic belongs to one subscriber ==");
  say(subscribers.length > 0, "there are subscriptions to check", `${subscribers.length} file(s)`);
  for (const s of subscribers) {
    say(
      /uniqueChannelTopic\(/.test(s.arg),
      `${s.rel} names its topic per subscriber`,
      s.arg.slice(0, 60),
    );
  }

  console.log("\n== and unsubscribes ==");
  for (const s of subscribers) {
    say(/removeChannel\(/.test(s.src), `${s.rel} unsubscribes on teardown`);
  }

  console.log("\n== the helper does what the call sites assume ==");
  const { uniqueChannelTopic } = await import("@/lib/supabase/channel-topic");
  const a = uniqueChannelTopic("swamp-feed");
  const b = uniqueChannelTopic("swamp-feed");
  say(a !== b, "two calls for one base give two topics", `${a} vs ${b}`);
  say(a.startsWith("swamp-feed") && !a.includes("realtime:"), "the base is still readable in it", a);

  console.log(
    failed === 0 ? "\nrealtime: all checks passed" : `\nrealtime: ${failed} check(s) failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
