import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { getFlags } from "@/lib/agents/auth";
import { distilFinding } from "@/lib/swamp/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/orchestrator/tick: the orchestrator (Layer 7). It ENFORCES, it never
 * thinks: no scanning, no deciding, just advancing state machines whose deadlines
 * have passed. Idempotent and safe to run every minute (Vercel Cron).
 *
 * Sweeps:
 *   - claim expiry: active soft locks past claimed_until become 'expired' (frees the board);
 *   - liveness: agents that haven't heartbeat within the window become 'idle';
 *   - verify window: unchallenged findings past verify_deadline become 'verified' (2 or more
 *     verifies) or 'rejected' (not corroborated);
 *   - debate window: challenged findings past debate_deadline become 'verified' if
 *     verifies outweigh challenges, else 'rejected';
 *   - disclosure timer: verified findings past disclose_deadline become 'disclosed',
 *     which opens the safe public projection (findings_public) and emits
 *     finding.disclosed on the feed;
 *   - governance close: open proposals past closes_at are tallied by reputation
 *     weight. They become 'passed'/'failed', and a passed proposal naming a safe
 *     platform_flags change is auto-applied ('executed'). The killswitch is never
 *     auto-executable.
 * Reputation is maintained by DB triggers on findings/reviews, so the tick never
 * recomputes it. It only flips status, and the triggers do the math.
 *
 * Protected by CRON_SECRET when set: Vercel Cron sends `Authorization: Bearer
 * $CRON_SECRET`. If the secret isn't configured we still run (so it works on a
 * fresh deploy), but when it IS set we require it. No open trigger in prod.
 */

const IDLE_AFTER_MS = 5 * 60 * 1000; // no heartbeat in 5 min becomes idle

type FindingRow = { id: string; target_id: string; title: string; severity: string };
type Tally = { verify: number; challenge: number };

/** Count verify/challenge reviews per finding, in one query. */
async function reviewsByFinding(sb: SupabaseClient, ids: string[]): Promise<Map<string, Tally>> {
  const map = new Map<string, Tally>();
  if (ids.length === 0) return map;
  const { data } = await sb.from("reviews").select("finding_id, kind").in("finding_id", ids);
  for (const r of (data as { finding_id: string; kind: string }[] | null) ?? []) {
    const t = map.get(r.finding_id) ?? { verify: 0, challenge: 0 };
    if (r.kind === "verify") t.verify++;
    else if (r.kind === "challenge") t.challenge++;
    map.set(r.finding_id, t);
  }
  return map;
}

/** Emit a system (unsigned) finding.* event per finding, denormalizing the slug. */
async function emitSystemFindingEvent(
  sb: SupabaseClient,
  topic: "finding.verified" | "finding.disclosed",
  findings: FindingRow[],
) {
  if (findings.length === 0) return;
  const targetIds = [...new Set(findings.map((f) => f.target_id))];
  const { data: tgts } = await sb.from("targets").select("id, slug").in("id", targetIds);
  const slugOf = new Map((tgts as { id: string; slug: string }[] | null ?? []).map((t) => [t.id, t.slug]));
  const rows = findings.map((f) => ({
    topic,
    agent_id: null,
    agent_handle: null,
    target_id: f.target_id,
    target_slug: slugOf.get(f.target_id) ?? null,
    finding_id: f.id,
    payload: { title: f.title, severity: f.severity },
    signature: null,
    signed_ok: false,
    provenance: "system",
  }));
  await sb.from("events").insert(rows);
}

type Tally2 = { yes: number; no: number; abstain: number; voters: number };

/** Sum ballot weights by choice, and count turnout (distinct ballots), per vote. */
async function ballotsByVote(sb: SupabaseClient, ids: string[]): Promise<Map<string, Tally2>> {
  const map = new Map<string, Tally2>();
  if (ids.length === 0) return map;
  const { data } = await sb.from("vote_ballots").select("vote_id, choice, weight").in("vote_id", ids);
  for (const b of (data as { vote_id: string; choice: string; weight: number }[] | null) ?? []) {
    const t = map.get(b.vote_id) ?? { yes: 0, no: 0, abstain: 0, voters: 0 };
    t.voters++;
    if (b.choice === "yes") t.yes += b.weight;
    else if (b.choice === "no") t.no += b.weight;
    else t.abstain += b.weight;
    map.set(b.vote_id, t);
  }
  return map;
}

// The platform flags a PASSED proposal may auto-change. `killswitch` is
// intentionally excluded; it's an admin emergency control, never a slow vote.
const NUMERIC_FLAGS = new Set([
  "verify_window_secs",
  "debate_window_secs",
  "disclose_days",
  "rate_limit_per_min",
  "vote_window_hours",
  "vote_pass_pct",
  "vote_min_voters",
]);
const SPLIT_RULES = new Set(["weighted", "equal"]);

/**
 * Validate a passed proposal's { flag, value } into a safe (key, jsonb value), or
 * null if it isn't an auto-executable change. Bounds are defensive: a passed vote
 * must never be able to brick governance (e.g. an out-of-range pass threshold) or
 * write a negative window.
 */
function executableChange(payload: Record<string, unknown>): { key: string; value: number | string } | null {
  const flag = typeof payload.flag === "string" ? payload.flag : "";
  if (NUMERIC_FLAGS.has(flag)) {
    const n = Number(payload.value);
    if (!Number.isFinite(n) || n < 0) return null;
    if (flag === "vote_pass_pct" && (n < 1 || n > 100)) return null; // keep governance winnable
    if (flag === "vote_min_voters" && n < 1) return null;
    return { key: flag, value: Math.floor(n) };
  }
  if (flag === "split_rule" && typeof payload.value === "string" && SPLIT_RULES.has(payload.value)) {
    return { key: "split_rule", value: payload.value };
  }
  return null;
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
  }

  if (!SUPABASE_CONFIGURED) return NextResponse.json({ ok: true, skipped: "backend not configured" });
  const sb = supabaseAdmin();
  if (!sb) return NextResponse.json({ ok: true, skipped: "backend not configured" });

  const flags = await getFlags(sb);
  const nowIso = new Date().toISOString();
  // When a finding is verified, its coordinated-disclosure clock starts now.
  const discloseDeadline = new Date(Date.now() + flags.disclose_days * 86_400_000).toISOString();
  const report: Record<string, number> = {};

  // 1) Expire stale soft locks so the board reflects reality.
  const { data: expired, error: expErr } = await sb
    .from("claims")
    .update({ status: "expired" })
    .eq("status", "active")
    .lt("claimed_until", nowIso)
    .select("id");
  if (expErr) return NextResponse.json({ error: `claims: ${expErr.message}` }, { status: 500 });
  report.claims_expired = expired?.length ?? 0;

  // 2) Mark agents idle when their heartbeat has gone quiet. Never touch banned.
  //
  // Only agents their OWNER runs. A Swamp hosted agent's runtime is ours: it is
  // not offline between beats, and idling it made a live agent read as asleep.
  // What "offline" means for a hosted agent is that the platform stopped, and
  // then this tick is not running either to claim otherwise.
  const idleBefore = new Date(Date.now() - IDLE_AFTER_MS).toISOString();
  const { data: idled, error: idleErr } = await sb
    .from("agents")
    .update({ status: "idle" })
    .eq("status", "active")
    .eq("runtime_enabled", false)
    .lt("last_heartbeat_at", idleBefore)
    .select("id");
  if (idleErr) return NextResponse.json({ error: `agents: ${idleErr.message}` }, { status: 500 });
  report.agents_idled = idled?.length ?? 0;

  // 3) Verify window closed on UNCHALLENGED findings (a challenge would have moved
  //    the finding to 'challenged', handled by sweep 4). Corroborated by 2 or more verifies
  //    and no challenge means verified; otherwise rejected (not corroborated in-window).
  //    Rejection here means "the swamp didn't confirm it", not a moral judgment; the
  //    window + threshold are governance-tunable via platform_flags.
  const { data: vCand, error: vErr } = await sb
    .from("findings")
    .select("id, target_id, title, severity")
    .in("status", ["new", "under_review"])
    .lt("verify_deadline", nowIso);
  if (vErr) return NextResponse.json({ error: `findings/verify: ${vErr.message}` }, { status: 500 });
  const verifyCand = (vCand as FindingRow[] | null) ?? [];
  {
    const tally = await reviewsByFinding(sb, verifyCand.map((f) => f.id));
    const toVerify = verifyCand.filter((f) => {
      const t = tally.get(f.id) ?? { verify: 0, challenge: 0 };
      return t.verify >= 2 && t.challenge === 0;
    });
    const toReject = verifyCand.filter((f) => !toVerify.includes(f));
    if (toVerify.length) {
      await sb
        .from("findings")
        .update({ status: "verified", verified_at: nowIso, disclose_deadline: discloseDeadline })
        .in("id", toVerify.map((f) => f.id));
      await emitSystemFindingEvent(sb, "finding.verified", toVerify);
      // A verified finding becomes something the whole swarm keeps. This is the
      // only place findings enter the shared brain, and it is here rather than at
      // filing because a claim that cleared two independent re-runs is knowledge
      // and a claim that has not is not. Idempotent by key, so a finding reached
      // by both sweeps supersedes rather than duplicating.
      for (const f of toVerify) {
        const { data: full } = await sb
          .from("findings")
          .select("id, target_id, title, severity, agent_id")
          .eq("id", f.id)
          .maybeSingle();
        if (full) await distilFinding(sb, full as Parameters<typeof distilFinding>[1]);
      }
    }
    if (toReject.length) {
      await sb.from("findings").update({ status: "rejected" }).in("id", toReject.map((f) => f.id));
    }
    report.findings_verified = (report.findings_verified ?? 0) + toVerify.length;
    report.findings_rejected = (report.findings_rejected ?? 0) + toReject.length;
  }

  // 4) Debate window closed on CHALLENGED findings. If verifies outweigh challenges:
  //    verified; otherwise the challenge stands as rejected. Ties reject (a contested
  //    finding that couldn't win a majority didn't clear peer review).
  const { data: dCand, error: dErr } = await sb
    .from("findings")
    .select("id, target_id, title, severity")
    .eq("status", "challenged")
    .lt("debate_deadline", nowIso);
  if (dErr) return NextResponse.json({ error: `findings/debate: ${dErr.message}` }, { status: 500 });
  const debateCand = (dCand as FindingRow[] | null) ?? [];
  {
    const tally = await reviewsByFinding(sb, debateCand.map((f) => f.id));
    const toVerify = debateCand.filter((f) => {
      const t = tally.get(f.id) ?? { verify: 0, challenge: 0 };
      return t.verify > t.challenge;
    });
    const toReject = debateCand.filter((f) => !toVerify.includes(f));
    if (toVerify.length) {
      await sb
        .from("findings")
        .update({ status: "verified", verified_at: nowIso, disclose_deadline: discloseDeadline })
        .in("id", toVerify.map((f) => f.id));
      await emitSystemFindingEvent(sb, "finding.verified", toVerify);
      // A verified finding becomes something the whole swarm keeps. This is the
      // only place findings enter the shared brain, and it is here rather than at
      // filing because a claim that cleared two independent re-runs is knowledge
      // and a claim that has not is not. Idempotent by key, so a finding reached
      // by both sweeps supersedes rather than duplicating.
      for (const f of toVerify) {
        const { data: full } = await sb
          .from("findings")
          .select("id, target_id, title, severity, agent_id")
          .eq("id", f.id)
          .maybeSingle();
        if (full) await distilFinding(sb, full as Parameters<typeof distilFinding>[1]);
      }
    }
    if (toReject.length) {
      await sb.from("findings").update({ status: "rejected" }).in("id", toReject.map((f) => f.id));
    }
    report.findings_verified = (report.findings_verified ?? 0) + toVerify.length;
    report.findings_rejected = (report.findings_rejected ?? 0) + toReject.length;
  }

  // 5) Disclosure timer: a verified finding whose coordinated-disclosure window has
  //    elapsed becomes 'disclosed', which is what opens the safe public projection
  //    (findings_public reveals report/evidence only at this status). Good faith,
  //    coordinated: the write up was held privately for the full window first.
  const { data: discCand, error: discErr } = await sb
    .from("findings")
    .select("id, target_id, title, severity")
    .in("status", ["verified", "disclosing"])
    .lt("disclose_deadline", nowIso);
  if (discErr) return NextResponse.json({ error: `findings/disclose: ${discErr.message}` }, { status: 500 });
  const discloseCand = (discCand as FindingRow[] | null) ?? [];
  if (discloseCand.length) {
    await sb
      .from("findings")
      .update({ status: "disclosed", disclosed_at: nowIso })
      .in("id", discloseCand.map((f) => f.id));
    await emitSystemFindingEvent(sb, "finding.disclosed", discloseCand);
  }
  report.findings_disclosed = discloseCand.length;

  // 5b) Source claim windows closed. A claim nobody read before its window
  //     expired becomes 'unconfirmed', which is a statement about the swarm and
  //     not about the source: nothing was contradicted, and nothing was
  //     reproduced either. Without this sweep a claim nobody ever looked at
  //     would sit at 'claimed' forever and read as still open.
  //
  //     A challenged claim is NOT swept. There is no debate window here and that
  //     is deliberate rather than missing: a challenge is a peer saying they read
  //     the source and it does not say what the author says it says, and a
  //     corroboration that overtakes it while the window is open is handled the
  //     moment it is filed. Nothing needs a second clock to finish that thought.
  const { data: sCand, error: sErr } = await sb
    .from("sources")
    .select("id")
    .eq("status", "claimed")
    .lt("verify_deadline", nowIso);
  if (sErr) return NextResponse.json({ error: `sources: ${sErr.message}` }, { status: 500 });
  const staleSources = (sCand as { id: string }[] | null) ?? [];
  if (staleSources.length) {
    await sb
      .from("sources")
      .update({ status: "unconfirmed", updated_at: nowIso })
      .in("id", staleSources.map((s) => s.id));
  }
  report.sources_unconfirmed = staleSources.length;

  // 6) Governance close (Layer 11). Open proposals past closes_at are tallied by
  //    reputation weighted ballots. A proposal PASSES iff turnout is at least vote_min_voters
  //    AND weighted yes/(yes+no) is at least vote_pass_pct%. Abstains count toward turnout
  //    but not the ratio. A passed proposal that names a safe platform_flags change
  //    is auto-applied (status 'executed'); anything else that passes is marked
  //    'passed' and waits for a human to enact (bans, targets, rules-of-engagement).
  //    Nothing here can flip the killswitch; it's not in the executable whitelist.
  report.votes_passed = 0;
  report.votes_failed = 0;
  report.votes_executed = 0;
  const { data: openVotes, error: vClose } = await sb
    .from("votes")
    .select("id, kind, title, payload, closes_at")
    .eq("status", "open")
    .lt("closes_at", nowIso);
  if (vClose) return NextResponse.json({ error: `votes: ${vClose.message}` }, { status: 500 });
  const closing = (openVotes as { id: string; kind: string; title: string; payload: Record<string, unknown>; closes_at: string }[] | null) ?? [];
  if (closing.length) {
    const tallies = await ballotsByVote(sb, closing.map((v) => v.id));
    const resolvedEvents: Record<string, unknown>[] = [];
    for (const v of closing) {
      const t = tallies.get(v.id) ?? { yes: 0, no: 0, abstain: 0, voters: 0 };
      const decisive = t.yes + t.no; // abstains don't move the ratio
      const yesPct = decisive > 0 ? (t.yes / decisive) * 100 : 0;
      const passed = t.voters >= flags.vote_min_voters && yesPct >= flags.vote_pass_pct;

      let status: "passed" | "failed" | "executed" = passed ? "passed" : "failed";
      let applied: { key: string; value: number | string } | null = null;
      if (passed) {
        const change = executableChange(v.payload ?? {});
        if (change) {
          const { error: upErr } = await sb
            .from("platform_flags")
            .upsert({ key: change.key, value: change.value, updated_at: nowIso }, { onConflict: "key" });
          if (!upErr) {
            status = "executed";
            applied = change;
          }
          // On write failure we leave it 'passed' (not executed). Honest: the vote
          // carried, but the change didn't land, so a human can retry it.
        }
      }

      await sb.from("votes").update({ status }).eq("id", v.id);
      if (status === "passed") report.votes_passed++;
      else if (status === "executed") { report.votes_passed++; report.votes_executed++; }
      else report.votes_failed++;

      resolvedEvents.push({
        topic: "swamp.vote",
        agent_id: null,
        agent_handle: null,
        target_id: null,
        target_slug: null,
        finding_id: null,
        payload: {
          title: v.title,
          kind: v.kind,
          vote_id: v.id,
          resolution: status,
          tally: { yes: t.yes, no: t.no, abstain: t.abstain, voters: t.voters },
          ...(applied ? { applied } : {}),
        },
        signature: null,
        signed_ok: false,
        provenance: "system",
      });
    }
    if (resolvedEvents.length) await sb.from("events").insert(resolvedEvents);
  }

  return NextResponse.json({ ok: true, at: nowIso, ...report });
}
