import "server-only";

import type { Address } from "viem";
import { supabaseAdmin } from "./supabase";
import { readChainSubmission, chainStatusToRowStatus, toHumanAmount, toBugAmount, type ChainSubmission } from "./onchain";
import { PROTOCOL_FALLBACK, INDEX_SEVERITY } from "./contract";
import type { Severity, SubmissionStatus } from "./db";

/**
 * Mirrors one on-chain submission's authoritative state into the index row.
 *
 * This is the ONLY place that writes a chain-decided column (status, reward,
 * severity, timestamps, revealed URI), and it takes exactly one argument: the row
 * id. Nothing about the chain arrives from the caller. A browser can claim any
 * transaction hash it likes, so a mirror that accepted client-supplied status or
 * reward would be a forgery primitive, worse than useless, because
 * `recompute_hunter` would then credit real reputation from it.
 *
 * It runs as the service role, which is also why `guard_submission_columns` has
 * an explicit service bypass: the guard exists to stop a *hunter* self-awarding,
 * not to stop the chain from being indexed.
 *
 * Called from three places, all of which want the same answer: the submit flow
 * (confirm the commit landed), the reveal/escalate/triage flows (stamp the
 * verdict), and /api/chain/tick (repair drift and import what arrived via the CLI
 * or another browser).
 */

export type MirrorOutcome =
  | { ok: true; chain: ChainSubmission; changed: string[] }
  | { ok: false; reason: string };

type RowShape = {
  id: string;
  program_id: string;
  status: SubmissionStatus;
  chain_id: number | null;
  onchain_submission_id: number | null;
  revealed_at: string | null;
  triaged_at: string | null;
  escalated_at: string | null;
  resolved_at: string | null;
  dupe_of: string | null;
  // These come back as strings: PostgREST serialises `numeric` as a string, and
  // comparing them against a number is how we avoid rewriting identical rows.
  reward: string | number | null;
  bond: string | number | null;
  assigned_severity: string | null;
  report_uri: string | null;
  dispute_deadline: string | null;
};

const iso = (seconds: bigint): string | null =>
  seconds > 0n ? new Date(Number(seconds) * 1000).toISOString() : null;

export async function mirrorChainSubmission(rowId: string): Promise<MirrorOutcome> {
  const sb = supabaseAdmin();
  if (!sb) return { ok: false, reason: "backend not configured" };

  const { data: rowData, error: rowErr } = await sb
    .from("submissions")
    .select(
      "id,program_id,status,chain_id,onchain_submission_id,revealed_at,triaged_at,escalated_at,resolved_at,dupe_of,reward,bond,assigned_severity,report_uri,dispute_deadline",
    )
    .eq("id", rowId)
    .maybeSingle();
  if (rowErr) return { ok: false, reason: rowErr.message };
  const row = rowData as RowShape | null;
  if (!row) return { ok: false, reason: "no such submission" };
  if (!row.chain_id || !row.onchain_submission_id) {
    return { ok: false, reason: "this finding isn't linked to the chain" };
  }

  const { data: progData } = await sb
    .from("programs")
    .select("reward_token")
    .eq("id", row.program_id)
    .maybeSingle();
  const rewardToken = ((progData as { reward_token: string | null } | null)?.reward_token ??
    "0x0000000000000000000000000000000000000000") as Address;

  const chain = await readChainSubmission(row.chain_id, BigInt(row.onchain_submission_id));
  if (!chain) return { ok: false, reason: "couldn't read that submission from the chain" };

  const patch: Record<string, unknown> = {};
  const changed: string[] = [];
  const set = (key: string, value: unknown, current: unknown) => {
    if (value === undefined) return;
    if (value === current) return;
    // Numbers come back as strings from PostgREST for `numeric` columns, so
    // compare loosely for those rather than rewriting every poll.
    if (typeof current === "string" && Number(current) === value) return;
    patch[key] = value;
    changed.push(key);
  };

  set("status", chainStatusToRowStatus(chain.status, row.status), row.status);

  // Severity is only meaningful once the owner has assigned one.
  if (chain.severityIndex >= 1 && chain.severityIndex <= 4) {
    const severity = INDEX_SEVERITY[chain.severityIndex] as Severity;
    set("assigned_severity", severity, row.assigned_severity);
  }

  // The award is in the program's reward token, in base units; the off-chain row
  // (and the reputation trigger) speak human units of the same currency, which is
  // what the tiers on the program row are denominated in.
  set("reward", toHumanAmount(row.chain_id, rewardToken, chain.award), row.reward ?? 0);
  set("bond", toBugAmount(chain.bond), row.bond ?? 0);

  if (chain.reportURI) {
    set("report_uri", chain.reportURI, row.report_uri);
    // The contract records no reveal timestamp, so this is "first observed", not
    // "revealed at". Labelled as such in the UI; it exists so a hunter can see
    // their reveal landed without waiting for an indexer to reconstruct it.
    if (!row.revealed_at) set("revealed_at", new Date().toISOString(), null);
  }

  const triagedAt = iso(chain.triagedAt);
  if (triagedAt) set("triaged_at", triagedAt, row.triaged_at);

  if (chain.status === "escalated" && !row.escalated_at) {
    set("escalated_at", triagedAt ?? new Date().toISOString(), null);
  }

  // A disputed verdict is only disputable for DISPUTE_WINDOW; surfacing the
  // deadline is what lets the hunter see the appeal window rather than guess it.
  if (["rejected", "duplicate", "spam"].includes(chain.status) && chain.triagedAt > 0n) {
    const deadline = new Date(
      Number(chain.triagedAt + PROTOCOL_FALLBACK.disputeWindow) * 1000,
    ).toISOString();
    set("dispute_deadline", deadline, row.dispute_deadline);
  }

  if (chain.status === "resolved" && !row.resolved_at) {
    set("resolved_at", triagedAt ?? new Date().toISOString(), null);
  }

  // Duplicates point at the original row when we've indexed it, so the UI can
  // link "duplicate of #12" to the actual finding instead of a chain number.
  if (chain.dupeOf > 0n && !row.dupe_of) {
    const { data: orig } = await sb
      .from("submissions")
      .select("id")
      .eq("chain_id", row.chain_id)
      .eq("onchain_submission_id", Number(chain.dupeOf))
      .maybeSingle();
    if (orig) set("dupe_of", (orig as { id: string }).id, null);
  }

  if (changed.length === 0) return { ok: true, chain, changed };

  const { error } = await sb.from("submissions").update(patch).eq("id", rowId);
  if (error) return { ok: false, reason: error.message };
  return { ok: true, chain, changed };
}

/**
 * Imports an on-chain submission we have never seen, when it can be attributed to
 * a profile. Attribution is by `profiles.wallet`, the same rule the submit flow
 * enforces, because without it we could not honestly say whose finding it is,
 * and `hunter` is a required foreign key. A submission whose hunter has no linked
 * wallet stays unindexed: the program page's open-report count reads the chain
 * directly, so nothing is hidden, it simply isn't attributed to anyone here.
 */
export async function importChainSubmission(
  chainId: number,
  submissionId: bigint,
  chain: ChainSubmission,
  programRowId: string,
): Promise<{ imported: boolean; reason?: string }> {
  const sb = supabaseAdmin();
  if (!sb) return { imported: false, reason: "backend not configured" };

  const { data: prof } = await sb
    .from("profiles")
    .select("id")
    .ilike("wallet", chain.hunter)
    .maybeSingle();
  if (!prof) return { imported: false, reason: "no profile claims that hunter address" };

  const { error } = await sb.from("submissions").insert({
    program_id: programRowId,
    hunter: (prof as { id: string }).id,
    title: "On-chain finding (not indexed here)",
    severity: "none",
    status: "pending",
    // The preimage, the report URI and its salt, lives only with the hunter.
    // We deliberately don't invent one: a placeholder URI here would be bound
    // into nothing and could never be revealed.
    report: null,
    encrypted: true,
    chain_id: chainId,
    onchain_submission_id: Number(submissionId),
    commit_hash: chain.commitHash,
  });
  if (error) return { imported: false, reason: error.message };
  return { imported: true };
}
