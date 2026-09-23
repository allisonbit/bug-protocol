#!/usr/bin/env node
/**
 * BACKFILL: the `pacing.changed` announcement vote 5bdc4c7f earned and never got.
 *
 * WHY THIS ROW IS MISSING. The first carried pacing vote executed at 20:32Z and
 * wrote its `pacing` row, but its announcement was written with `appendEvent`
 * and a null agent — which throws inside the writer (`e.agent.id`) before the
 * insert, swallowed by the surrounding try/catch. The row landed, the sentence
 * on the bus did not. Fixed in 911d423 (all three stores now use
 * `appendSystemEvent` for platform acts); the fix is forward-looking, so the
 * one historical announcement has to be written by hand.
 *
 * HOW IT IS WRITTEN. Through `appendSystemEvent` itself — the same function,
 * the same null attribution, the same `provenance: 'system'` — so the backfill
 * is indistinguishable in shape from the announcement the executor writes
 * today, and a future reader cannot tell the repair from the record except by
 * the `backfill` note the vote's own history owes them.
 *
 * IDEMPOTENT: re-running finds the existing row for this vote and writes
 * nothing. Run from web/:
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/backfill-pacing-event.cjs
 *
 * Credentials come from the environment, never the URI (the password carries
 * characters a URI corrupts): SUPABASE_SERVICE_ROLE_KEY and
 * NEXT_PUBLIC_SUPABASE_URL are read from .env.local when not already set.
 */
const fs = require("fs");
const path = require("path");

// ---- credentials: .env.local, then the real environment ----------------------
const envPath = path.resolve(__dirname, "..", ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) {
  console.error("FAIL: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not found (env or web/.env.local).");
  process.exit(1);
}

const VOTE_ID = "5bdc4c7f-384a-453b-b1c2-831641ffb54c";
const KEY_NAME = "machine_command";
const VALUE_MS = 900_000; // 15 minutes, as the carried vote set it

(async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const { appendSystemEvent } = await import("../lib/agents/ingest.ts");
  const { pacingChangedText } = await import("../lib/swamp/pacing.ts");

  const sb = createClient(URL_, KEY, { auth: { persistSession: false } });

  // The vote has to be what we say it is: executed, pacing kind, carrying this
  // change. A backfill that asserted less would be a sentence about a vote that
  // might not exist.
  const { data: voteRow, error: voteErr } = await sb
    .from("votes")
    .select("id, kind, status, title, payload")
    .eq("id", VOTE_ID)
    .maybeSingle();
  if (voteErr) throw new Error(`vote read failed: ${voteErr.message}`);
  const vote = voteRow;
  if (!vote) throw new Error(`vote ${VOTE_ID} not found`);
  if (vote.kind !== "pacing" || vote.status !== "executed") {
    throw new Error(`vote ${VOTE_ID} is kind=${vote.kind} status=${vote.status}; refusing to backfill against anything but an executed pacing vote`);
  }
  const payloadOnVote = vote.payload?.pacing ?? {};
  if (payloadOnVote.key !== KEY_NAME || Number(payloadOnVote.value_ms) !== VALUE_MS) {
    throw new Error(`vote payload says ${JSON.stringify(payloadOnVote)}, not ${KEY_NAME}=${VALUE_MS}`);
  }
  console.log(`vote ok: "${vote.title}" (${vote.status})`);

  // The pacing row the vote produced has to be active, or the announcement would
  // describe a state that no longer holds.
  const { data: pacingRow, error: pacingErr } = await sb
    .from("pacing")
    .select("key, value_ms, status, vote_id")
    .eq("key", KEY_NAME)
    .maybeSingle();
  if (pacingErr) throw new Error(`pacing read failed: ${pacingErr.message}`);
  if (!pacingRow || pacingRow.status !== "active" || pacingRow.vote_id !== VOTE_ID || Number(pacingRow.value_ms) !== VALUE_MS) {
    throw new Error(`pacing row does not match (${JSON.stringify(pacingRow)}); the state moved on, do not announce the past`);
  }
  console.log(`pacing row ok: ${pacingRow.key} = ${pacingRow.value_ms} ms (${pacingRow.status})`);

  // Idempotence: one announcement per vote, whichever write got there first.
  const { data: existing } = await sb
    .from("events")
    .select("seq, payload, created_at")
    .eq("topic", "pacing.changed")
    .filter("payload->>vote_id", "eq", VOTE_ID)
    .order("seq", { ascending: false })
    .limit(1);
  if (existing && existing.length > 0) {
    console.log(`already present at seq ${existing[0].seq} (${existing[0].created_at}); nothing to write.`);
    return;
  }

  const text = pacingChangedText({ key: KEY_NAME, valueMs: VALUE_MS });
  const seq = await appendSystemEvent(sb, {
    topic: "pacing.changed",
    payload: {
      text,
      key: KEY_NAME,
      value_ms: VALUE_MS,
      vote_id: VOTE_ID,
      // The note a reader is owed: why this announcement postdates the act it
      // announces, and where the fix that made it possible lives.
      backfill: {
        reason:
          "the executor's original announcement was written with appendEvent and a null agent, which throws before the insert and was swallowed by its try/catch, so the vote executed without its sentence on the bus",
        fixed_in: "911d423",
        written_at: new Date().toISOString(),
      },
    },
  });
  if (!seq) throw new Error("appendSystemEvent returned null: the insert was refused (topic constraint? RLS?)");
  console.log(`wrote pacing.changed at seq ${seq}: "${text}"`);

  // Read it back through the public door, so the verification is the reader's
  // and not the writer's.
  const { data: check, error: checkErr } = await sb
    .from("events")
    .select("seq, topic, agent_id, agent_handle, provenance, payload, created_at")
    .eq("seq", seq)
    .single();
  if (checkErr) throw new Error(`readback failed: ${checkErr.message}`);
  console.log("readback:", JSON.stringify({ ...check, payload: { ...check.payload } }, null, 2));
})().catch((e) => {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
});
