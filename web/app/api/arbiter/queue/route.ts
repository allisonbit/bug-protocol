import { NextResponse } from "next/server";
import { DEFAULT_CHAIN_ID, chainMeta } from "@/lib/chains";
import { readChainSubmission, readChainProgram, readNextSubmissionId } from "@/lib/onchain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/arbiter/queue: the escalated submissions waiting on a ruling.
 *
 * This reads the chain and nothing else, which is the point. An arbiter is a
 * protocol-level role: they are usually neither the hunter nor the program owner,
 * so the index's row-level security would hide the case from them entirely. Rather
 * than reach around RLS with the service role and leak private reports to whoever
 * can load a page, the console is built from public chain state: the commit, the
 * escalation ground, the program's escrow, plus whatever the hunter has chosen to
 * reveal, which is public on chain by definition.
 *
 * That has a pleasant consequence: this route needs no authorization at all, since
 * there is nothing here a determined person couldn't read off the block explorer.
 * The authority to rule lives in the contract (`onlyArbiter`), where it belongs.
 *
 * Discovery is a bounded scan of submission ids rather than a log query. `getLogs`
 * from the genesis block is unreliable across the chains we support, and this
 * protocol is young enough that a window of the most recent submissions covers the
 * whole history. As it grows this should be replaced by a real indexer; the window
 * is explicit in the response so a caller can tell the difference between "nothing
 * is escalated" and "we only looked at 40 ids".
 */
const MAX_WINDOW = 60;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const chainId = Number(url.searchParams.get("chain") ?? DEFAULT_CHAIN_ID);
  if (!chainMeta(chainId).bounty) {
    return NextResponse.json(
      { error: `The protocol isn't deployed on ${chainMeta(chainId).label}.` },
      { status: 400 },
    );
  }

  const next = await readNextSubmissionId(chainId);
  if (next === null) {
    return NextResponse.json({ error: "Couldn't read the contract. Check the RPC for this chain." }, { status: 502 });
  }
  const last = next - 1n;
  if (last < 1n) return NextResponse.json({ chainId, scanned: 0, escalated: [] });

  const toParam = url.searchParams.get("to");
  const fromParam = url.searchParams.get("from");
  const to = toParam && /^\d+$/.test(toParam) ? BigInt(toParam) : last;
  const requestedFrom = fromParam && /^\d+$/.test(fromParam) ? BigInt(fromParam) : 0n;
  const from = requestedFrom > 0n ? requestedFrom : to - BigInt(MAX_WINDOW) + 1n;
  const start = from < 1n ? 1n : from;
  if (start > to) {
    return NextResponse.json({ error: "from is after to." }, { status: 400 });
  }

  const ids: bigint[] = [];
  for (let i = start; i <= to && ids.length < MAX_WINDOW; i++) ids.push(i);

  const rows = await Promise.all(ids.map((id) => readChainSubmission(chainId, id)));
  const escalated = rows.filter((r) => r !== null && r.status === "escalated");

  // One program read per distinct program, for the escrow position the arbiter
  // needs: whether the pool can actually cover the award they're about to make.
  const programIds = [...new Set(escalated.map((e) => e!.programId))];
  const programs = await Promise.all(programIds.map((id) => readChainProgram(chainId, id)));
  const programById = new Map(
    programs
      .filter((p) => p !== null)
      .map((p) => [
        String(p!.id),
        {
          id: Number(p!.id),
          status: p!.status,
          pending: Number(p!.pending),
          pool: p!.pool.toString(),
          bond: p!.bond.toString(),
          freePool: p!.freePool.toString(),
          rewardToken: p!.rewardToken,
          // Indexed 1..4 (Low..Critical), as base-unit decimal strings.
          tiers: p!.tiers.slice(1).map((t) => t.toString()),
        },
      ]),
  );

  return NextResponse.json({
    chainId,
    scanned: ids.length,
    window: { from: Number(start), to: Number(to) },
    escalated: escalated.map((e) => ({
      id: Number(e!.id),
      programId: Number(e!.programId),
      hunter: e!.hunter,
      commitHash: e!.commitHash,
      reportURI: e!.reportURI,
      submittedAt: Number(e!.submittedAt),
      triagedAt: Number(e!.triagedAt),
      triageDeadline: Number(e!.triageDeadline),
      escalatedFromPending: e!.escalatedFromPending,
      bond: e!.bond.toString(),
      program: programById.get(String(e!.programId)) ?? null,
    })),
  });
}
