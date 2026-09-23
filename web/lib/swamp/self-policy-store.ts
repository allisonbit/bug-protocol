import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appendEvent, appendSystemEvent } from "@/lib/agents/ingest";
import type { Agent } from "@/lib/agents/types";
import { REFLEX_RULES } from "./policy";
import {
  amendmentFromPayload,
  amendmentSummary,
  amendmentVotePayload,
  checkOpsBundle,
  composeAmendedPolicy,
  composedDigest,
  type PolicyOp,
} from "./self-policy";

/**
 * THE SELF-POLICY STORE: THE VOTE IS THE GATE, THE EXECUTOR IS THE ONLY WRITER.
 *
 * Same three doors as practices, because the pattern already earned its trust:
 * a proposal binds validated ops to a ballot and writes nothing else; the
 * executor's adoption on a CARRIED vote re-validates and re-composes before it
 * writes; and the read is what observations serve every resident. An amendment
 * is only adopted if the composed list actually differs from the base — a vote
 * whose ops are all no-ops resolves as passed, not executed.
 */

export async function proposeSelfPolicyVote(
  sb: SupabaseClient,
  agent: Agent,
  input: { ops: unknown; body?: string | null },
): Promise<{ ok: true; voteId: string; closesAt: string } | { ok: false; status: number; error: string }> {
  const refuse = (status: number, error: string) => ({ ok: false as const, status, error });
  const check = checkOpsBundle(input.ops);
  if (!check.ok) return refuse(400, check.reason);
  const ops = check.ops as PolicyOp[];

  // Compose now, at proposal time, so a ballot is never spent on ops the base
  // list cannot take (an unknown rule id, a bundle that exceeds the ceiling).
  if (!composeAmendedPolicy(REFLEX_RULES, ops)) {
    return refuse(400, "these ops do not compose against the current default policy: a rule id is unknown or the list would exceed its ceiling");
  }

  const summary = amendmentSummary(ops);
  const flags = await sb.from("platform_flags").select("key,value").in("key", ["vote_window_hours"]);
  const hours = Number((flags.data as { key: string; value: unknown }[] | null)?.find((r) => r.key === "vote_window_hours")?.value ?? 24);
  const closesAt = new Date(Date.now() + (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3_600_000).toISOString();

  const { data: voteRow, error } = await sb
    .from("votes")
    .insert({
      proposer_agent: agent.id,
      kind: "self_policy",
      title: `Amend the swarm's own policy: ${summary.slice(30, 110)}`,
      body: input.body?.trim().slice(0, 4000) || null,
      payload: amendmentVotePayload(ops),
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
      text: `proposed amending the swarm's own policy: ${summary.slice(31)}`,
      title: summary,
      kind: "self_policy",
      vote_id: v.id,
      proposal: true,
    },
    signature: null,
    provenance: "runtime",
  });
  return { ok: true, voteId: v.id, closesAt: v.closes_at };
}

/** The executor's write on a carried vote. Re-validates; refuses no-op bundles. */
export async function adoptSelfPolicy(
  sb: SupabaseClient,
  payload: unknown,
  ctx: { voteId: string },
): Promise<{ ok: true; digest: string; ops: PolicyOp[] } | { ok: false; reason: string }> {
  const ops = amendmentFromPayload(payload);
  if (!ops || ops.length === 0) return { ok: false, reason: "the vote payload does not name a bounded policy amendment" };

  const composed = composeAmendedPolicy(REFLEX_RULES, ops);
  if (!composed) return { ok: false, reason: "the ops no longer compose against the default policy" };
  const digest = composedDigest(composed);

  const { data: existing } = await sb.from("policy_amendments").select("id").eq("vote_id", ctx.voteId).maybeSingle();
  if (existing) return { ok: false, reason: "this vote already produced an amendment" };

  const { data: inserted, error } = await sb
    .from("policy_amendments")
    .insert({
      vote_id: ctx.voteId,
      ops,
      summary: amendmentSummary(ops),
      digest,
      status: "active",
    })
    .select("id")
    .single();
  if (error) return { ok: false, reason: error.message };

  // The platform announces its own act — `appendSystemEvent`, not `appendEvent`
  // with a cast null agent, which throws inside the writer before the insert and
  // would leave every amendment adopted-but-unannounced.
  try {
    await appendSystemEvent(sb, {
      topic: "policy.amended",
      payload: {
        text: amendmentSummary(ops),
        amendment_id: (inserted as { id: string }).id,
        digest,
        vote_id: ctx.voteId,
        ops,
      },
    });
  } catch {
    // The row is written and readable; the bus row is best effort, as with practices.
  }
  return { ok: true, digest, ops };
}

/** Active amendments, oldest first, so composition is deterministic. */
export async function listActiveAmendments(sb: SupabaseClient): Promise<{ id: string; ops: PolicyOp[]; digest: string; voteId: string; adoptedAt: string }[]> {
  const { data, error } = await sb
    .from("policy_amendments")
    .select("id, ops, digest, vote_id, adopted_at")
    .eq("status", "active")
    .order("adopted_at", { ascending: true })
    .limit(24);
  if (error || !data) return [];
  return (data as { id: string; ops: PolicyOp[]; digest: string; vote_id: string; adopted_at: string }[]).map((r) => ({
    id: r.id,
    ops: r.ops,
    digest: r.digest,
    voteId: r.vote_id,
    adoptedAt: r.adopted_at,
  }));
}

/** Suspend or reinstate, by vote or by the operator's emergency stop. */
export async function setAmendmentStatus(
  sb: SupabaseClient,
  input: { id: string; status: "active" | "suspended" | "withdrawn"; reason?: string },
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await sb
    .from("policy_amendments")
    .update({ status: input.status, updated_at: new Date().toISOString() })
    .eq("id", input.id);
  if (error) return { ok: false, error: error.message };
  if (input.status !== "active") {
    try {
      await appendSystemEvent(sb, {
        topic: "policy.repealed",
        payload: {
          text: `a policy amendment was ${input.status}${input.reason ? `: ${input.reason.slice(0, 200)}` : ""}`,
          amendment_id: input.id,
          status: input.status,
          reason: input.reason ?? null,
        },
      });
    } catch {
      // The status change is the fact; the bus row is best effort.
    }
  }
  return { ok: true };
}

/** Re-export so the executor's practice-shaped branch stays symmetric. */
export { amendmentSummary };
