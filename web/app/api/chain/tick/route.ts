import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { readChainSubmission, readNextSubmissionId } from "@/lib/onchain";
import { mirrorChainSubmission, importChainSubmission } from "@/lib/chainMirror";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/chain/tick: the chain reconciler.
 *
 * The chain is the source of truth and the index is a convenience, so this is the
 * thing that makes the two agree. It has two jobs:
 *
 *  1. **Repair.** Re-read every linked row and stamp what the chain says. This is
 *     what catches the cases where a browser closed mid-transaction, where the
 *     owner triaged from their phone, or where a verdict was disputed after the
 *     fact.
 *
 *  2. **Import.** Scan a window of recent submission ids for findings we have
 *     never seen: those filed through the CLI, the MCP server, or someone
 *     else's browser, and index the ones that can be attributed to a profile by
 *     wallet address.
 *
 * Deliberately shaped like `/api/orchestrator/tick`: idempotent, safe to run every
 * few minutes, and never inventing state. It doesn't decide anything; it copies.
 *
 * Two bounds worth knowing about. Row reads are capped per run, and discovery is a
 * window over submission ids rather than a `getLogs` scan, because log queries
 * from genesis aren't reliable on the chains we support. Both are configurable and
 * both are reported back, so a run that saw less than everything says so instead
 * of looking complete.
 */
const WINDOW = clampInt(process.env.CHAIN_TICK_WINDOW, 1, 300, 60);
const MAX_ROWS = clampInt(process.env.CHAIN_TICK_MAX_ROWS, 1, 200, 50);

function clampInt(raw: string | undefined, lo: number, hi: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

type ProgramRow = {
  id: string;
  chain_id: number | null;
  onchain_program_id: number | null;
  reward_token: string | null;
};

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

  const report: Record<string, number> = { mirrored: 0, repaired: 0, imported: 0, failed: 0, scanned: 0 };

  // ---- 1) Repair: rows we know about, newest first ---------------------------
  const { data: linkedRows, error: linkedErr } = await sb
    .from("submissions")
    .select("id")
    .not("onchain_submission_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS);

  if (linkedErr) return NextResponse.json({ error: `submissions: ${linkedErr.message}` }, { status: 500 });

  for (const row of (linkedRows as { id: string }[] | null) ?? []) {
    const result = await mirrorChainSubmission(row.id);
    if (!result.ok) {
      // A row the chain can't answer for is worth reporting but not fatal. The
      // usual cause is an RPC hiccup or a program id from another deployment.
      report.failed++;
      continue;
    }
    report.mirrored++;
    if (result.changed.length) report.repaired++;
  }

  // ---- 2) Import: recent on-chain submissions we've never indexed ------------
  const { data: programs, error: progErr } = await sb
    .from("programs")
    .select("id,chain_id,onchain_program_id,reward_token")
    .not("onchain_program_id", "is", null);
  if (progErr) return NextResponse.json({ error: `programs: ${progErr.message}` }, { status: 500 });

  const byChain = new Map<number, ProgramRow[]>();
  for (const p of ((programs as ProgramRow[] | null) ?? [])) {
    if (p.chain_id === null || p.onchain_program_id === null) continue;
    const list = byChain.get(p.chain_id) ?? [];
    list.push(p);
    byChain.set(p.chain_id, list);
  }

  for (const [chainId, chainPrograms] of byChain) {
    const next = await readNextSubmissionId(chainId);
    if (next === null) {
      report.failed++;
      continue;
    }
    const last = next - 1n;
    if (last < 1n) continue;

    const from = last - BigInt(WINDOW) + 1n;
    const start = from < 1n ? 1n : from;
    const onchainToRow = new Map(
      chainPrograms.map((p) => [String(p.onchain_program_id), p.id] as const),
    );

    for (let i = start; i <= last; i++) {
      report.scanned++;
      const chain = await readChainSubmission(chainId, i);
      if (!chain) continue;

      const programRowId = onchainToRow.get(String(chain.programId));
      if (!programRowId) continue; // a program on this chain that this site doesn't host

      // Already indexed? The repair pass above covers it, unless it's older than
      // the read cap, in which case this is the first time we've seen it.
      const { data: existing } = await sb
        .from("submissions")
        .select("id")
        .eq("chain_id", chainId)
        .eq("onchain_submission_id", Number(i))
        .maybeSingle();
      if (existing) continue;

      const imported = await importChainSubmission(chainId, i, chain, programRowId);
      if (imported.imported) report.imported++;
      else report.failed++;
    }
  }

  return NextResponse.json({ ok: true, at: new Date().toISOString(), ...report });
}
