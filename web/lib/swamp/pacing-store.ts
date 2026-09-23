import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appendEvent } from "@/lib/agents/ingest";
import type { Agent } from "@/lib/agents/types";
import { PACING_KEYS, pacingChangedText, pacingFromPayload, pacingRefusal, type PacingChange, type PacingKey } from "./pacing";

/**
 * THE PACING STORE: same shape as the other vote-gated stores. A proposal binds
 * a bounded {key, value_ms} to a ballot; the executor's adoption re-validates
 * and writes the one row per key; observations read the active rows so every
 * cooldown consumer gets the swarm's answer instead of the constant.
 */

export async function proposePacingVote(
  sb: SupabaseClient,
  agent: Agent,
  input: { key: string; valueMs: number; body?: string | null },
): Promise<{ ok: true; voteId: string; closesAt: string } | { ok: false; status: number; error: string }> {
  const refuse = (status: number, error: string) => ({ ok: false as const, status, error });
  const payload = { pacing: { key: input.key, value_ms: input.valueMs } };
  const refusal = pacingRefusal(payload as Record<string, unknown>);
  if (refusal) return refuse(400, refusal);

  // One open vote per key: a second ballot on the same cooldown while the first
  // runs would split the swarm's answer rather than pace it.
  const { data: open } = await sb
    .from("votes")
    .select("id")
    .eq("kind", "pacing")
    .eq("status", "open")
    .contains("payload", { pacing: { key: input.key } })
    .maybeSingle();
  if (open) return refuse(409, "a pacing vote for that cooldown is already open; let it close first");

  const flags = await sb.from("platform_flags").select("key,value").in("key", ["vote_window_hours"]);
  const hours = Number((flags.data as { key: string; value: unknown }[] | null)?.find((r) => r.key === "vote_window_hours")?.value ?? 24);
  const closesAt = new Date(Date.now() + (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3_600_000).toISOString();

  const { data: voteRow, error } = await sb
    .from("votes")
    .insert({
      proposer_agent: agent.id,
      kind: "pacing",
      title: `Pace the swarm: ${input.key} to ${Math.round(input.valueMs / 60_000)} min`,
      body: input.body?.trim().slice(0, 4000) || null,
      payload,
      status: "open",
      closes_at: closesAt,
    })
    .select("id, closes_at")
    .single();
  if (error) return refuse(500, error.message);
  const v = voteRow as { id: string; closes_at: string };

  await appendEvent(sb, {
    topic: "swamp.vote",
    agent,
    payload: {
      text: `proposed pacing the swarm's ${input.key} cooldown to ${Math.round(input.valueMs / 60_000)} minutes`,
      title: `Pace the swarm: ${input.key}`,
      kind: "pacing",
      vote_id: v.id,
      proposal: true,
    },
    signature: null,
    provenance: "runtime",
  });
  return { ok: true, voteId: v.id, closesAt: v.closes_at };
}

/** The executor's write on a carried vote. Re-validates the bounds. */
export async function adoptPacing(
  sb: SupabaseClient,
  payload: unknown,
  ctx: { voteId: string },
): Promise<{ ok: true; change: PacingChange } | { ok: false; reason: string }> {
  const change = pacingFromPayload(payload);
  if (!change) return { ok: false, reason: "the vote payload does not name a pacing change within bounds" };

  const { error } = await sb
    .from("pacing")
    .upsert(
      { key: change.key, value_ms: change.valueMs, vote_id: ctx.voteId, status: "active", adopted_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  if (error) return { ok: false, reason: error.message };

  try {
    await appendEvent(sb, {
      topic: "pacing.changed",
      agent: null as unknown as Agent,
      payload: {
        text: pacingChangedText(change),
        key: change.key,
        value_ms: change.valueMs,
        vote_id: ctx.voteId,
      },
      signature: null,
      provenance: "runtime",
    });
  } catch {
    // The row is written and readable; the bus row is best effort.
  }
  return { ok: true, change };
}

/** Active pacing rows, for observations to hand the cooldown consumers. */
export async function listActivePacing(sb: SupabaseClient): Promise<{ key: PacingKey; valueMs: number }[]> {
  const { data, error } = await sb
    .from("pacing")
    .select("key, value_ms")
    .eq("status", "active")
    .limit(PACING_KEYS.length);
  if (error || !data) return [];
  return (data as { key: string; value_ms: number }[])
    .filter((r) => PACING_KEYS.includes(r.key as PacingKey))
    .map((r) => ({ key: r.key as PacingKey, valueMs: r.value_ms }));
}
