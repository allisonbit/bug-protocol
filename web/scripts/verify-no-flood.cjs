/**
 * Does the swarm repeat itself? Three or more different residents saying the
 * identical sentence inside a window is a flood, and this fails on it.
 *
 * WHY THIS EXISTS. The hardware digest published the same paragraph 1,076 times
 * in seven hours, fifteen residents per beat, and nothing in the suite noticed.
 * It was found by an operator reading the bus, which is the wrong place to
 * find it: a repetition flood is not a subtle bug, it is a rule whose guard is
 * inverted or wired to a key nobody writes, and both of those are the kind of
 * thing a check catches the day it lands rather than the day somebody looks.
 *
 * WHAT IT ASKS. For every distinct text an agent published inside the window:
 * how many different agents said it? Three or more is a failure. Two is printed
 * as a near miss, because a rule that produces one duplicate is a rule whose
 * guard is already failing intermittently, and seeing it early is the point.
 *
 * WHAT IT IGNORES, AND WHY THAT IS NOT A LOOPHOLE.
 *
 *   pulse.span   one trace per agent per beat, by construction. Fifteen agents
 *                carrying the same span summary is the observability record
 *                doing its job, not fifteen agents saying the same thing.
 *   no agent     a reading or a system record has no voice behind it. A machine
 *                reporting the same temperature twice is a machine, not a crowd.
 *   no text      votes, claims and lifecycle events carry structured payloads.
 *                This check is about published sentences.
 *
 * WHAT IT DOES NOT DO. It does not delete anything, and it does not special-case
 * the digest that caused it. The window is time, so the flood above ages out of
 * it within the window and every future one is caught fresh.
 *
 *   FLOOD_WINDOW_MINUTES=15 node --experimental-strip-types \
 *     --import ./scripts/alias-register.mjs scripts/verify-no-flood.cjs
 */
const fs = require("fs");
const path = require("path");

const env = {};
try {
  for (const line of fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  // No env file: the skip below reports it rather than pretending to pass.
}

const windowMinutes = Number(process.env.FLOOD_WINDOW_MINUTES || 15);
const threshold = Number(process.env.FLOOD_AGENTS || 3);

/**
 * Repetitions that are legitimate, each with the reason written down.
 *
 * Empty on purpose. An entry here is a claim that several residents saying the
 * same words is correct behaviour, and a claim like that should have to be
 * written and defended rather than assumed by a threshold nobody reads.
 */
const ALLOWED_REPETITION = [];

(async () => {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("  skip  no credentials in .env.local, so this check did not run");
    console.log("\nno-flood: skipped (nothing was verified)");
    return;
  }

  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const { data, error } = await sb
    .from("events")
    .select("seq, topic, agent_handle, payload, created_at")
    // pulse.span is excluded in the query as well as in prose: it is the only
    // topic that is genuinely per-agent by design, and reading it in would make
    // this check fire on every healthy beat.
    .neq("topic", "pulse.span")
    .not("agent_handle", "is", null)
    .gte("created_at", since)
    .order("seq", { ascending: false })
    .limit(3000);

  if (error) {
    console.log(`  skip  the log could not be read: ${error.message}`);
    console.log("\nno-flood: skipped (nothing was verified)");
    process.exitCode = 1;
    return;
  }

  const rows = data ?? [];
  /** text -> { agents: Map<handle, count>, total, firstSeq, lastSeq, topic } */
  const byText = new Map();
  for (const row of rows) {
    const text = typeof row.payload?.text === "string" ? row.payload.text.trim() : "";
    if (!text) continue;
    let entry = byText.get(text);
    if (!entry) {
      entry = { agents: new Map(), total: 0, firstSeq: row.seq, lastSeq: row.seq, topic: row.topic };
      byText.set(text, entry);
    }
    entry.total += 1;
    entry.agents.set(row.agent_handle, (entry.agents.get(row.agent_handle) ?? 0) + 1);
    entry.firstSeq = Math.min(entry.firstSeq, row.seq);
    entry.lastSeq = Math.max(entry.lastSeq, row.seq);
  }

  const allowed = new Set(ALLOWED_REPETITION.map((a) => a.text));
  const floods = [...byText.entries()]
    .filter(([text, e]) => e.agents.size >= threshold && !allowed.has(text))
    .sort((a, b) => b[1].agents.size - a[1].agents.size);
  const nearMisses = [...byText.entries()].filter(
    ([text, e]) => e.agents.size === threshold - 1 && e.total >= threshold && !allowed.has(text),
  );

  console.log(
    `  read  ${rows.length} event(s) with a voice behind them in the last ${windowMinutes} minute(s)`,
  );

  for (const [text, e] of floods) {
    console.log(
      `  FAIL  ${e.agents.size} agents said the same thing ${e.total} time(s), seq ${e.firstSeq}-${e.lastSeq}, topic ${e.topic}`,
    );
    console.log(`        "${text.slice(0, 120)}${text.length > 120 ? "..." : ""}"`);
    console.log(`        ${[...e.agents.entries()].map(([h, n]) => `${h} x${n}`).join(", ")}`);
  }

  for (const [text, e] of nearMisses) {
    console.log(
      `  note  ${e.agents.size} agents said the same thing ${e.total} time(s) - one more agent and this fails`,
    );
    console.log(`        "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`);
  }

  if (floods.length === 0) {
    console.log(
      `  ok    no text was published by ${threshold} or more different agents inside ${windowMinutes} minute(s)`,
    );
  }

  console.log(
    floods.length === 0
      ? "\nno-flood: all checks passed"
      : `\nno-flood: ${floods.length} repetition flood(s) found`,
  );
  process.exitCode = floods.length === 0 ? 0 : 1;
})().catch((e) => {
  console.error("verify-no-flood could not run:", e.message);
  process.exit(1);
});
