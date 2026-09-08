import { createPublicClient, http, formatEther, type Address } from "viem";
import { robinhoodChain, addressUrl } from "@/lib/chain";
import { BOUNTY_ADDRESS, bountyAbi, isDeployed, ProgramStatus } from "@/lib/contract";

export const revalidate = 30;

type ProgramTuple = {
  owner: Address;
  rewardToken: Address;
  scopeHash: `0x${string}`;
  triageDeadline: bigint;
  disclosureDelay: bigint;
  status: number;
  pool: bigint;
  locked: bigint;
  bond: bigint;
  scopeURI: string;
};

type Row = ProgramTuple & {
  id: bigint;
  topTier: bigint;
  pending: bigint;
};

async function readPrograms(): Promise<Row[]> {
  if (!BOUNTY_ADDRESS) return [];
  const client = createPublicClient({ chain: robinhoodChain, transport: http() });
  const base = { address: BOUNTY_ADDRESS, abi: bountyAbi } as const;

  const next = await client.readContract({ ...base, functionName: "nextProgramId" });
  const ids = Array.from({ length: Number(next) - 1 }, (_, i) => BigInt(i + 1));
  if (ids.length === 0) return [];

  const results = await client.multicall({
    contracts: ids.flatMap((id) => [
      { ...base, functionName: "getProgram", args: [id] } as const,
      { ...base, functionName: "topTier", args: [id] } as const,
      { ...base, functionName: "pendingCount", args: [id] } as const,
    ]),
  });

  return ids.flatMap((id, i) => {
    const [p, top, pending] = results.slice(i * 3, i * 3 + 3);
    if (p.status !== "success") return [];
    const g = p.result as ProgramTuple;
    return [
      {
        ...g,
        id,
        topTier: top.status === "success" ? (top.result as bigint) : 0n,
        pending: pending.status === "success" ? (pending.result as bigint) : 0n,
      },
    ];
  });
}

export default async function Programs() {
  let rows: Row[] = [];
  let error: string | null = null;
  if (isDeployed) {
    try {
      rows = await readPrograms();
    } catch (e) {
      error = e instanceof Error ? e.message : "chain read failed";
    }
  }

  return (
    <section className="mx-auto max-w-5xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Programs</h1>
      <p className="mt-3 max-w-2xl leading-relaxed text-mist text-pretty">
        Every row is read live from Robinhood Chain. Escrow shown is real money already locked in
        the contract — a program cannot be listed here without it.
      </p>

      {!isDeployed && (
        <div className="mt-10 rounded-lg border border-line bg-ink-soft p-8">
          <p className="text-sm text-warn">Protocol not deployed yet.</p>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-mist text-pretty">
            The contracts are written and tested; deployment needs the $BUG token address. There is
            deliberately no placeholder data here — an empty list is the honest answer.
          </p>
        </div>
      )}

      {error && (
        <div className="mt-10 rounded-lg border border-warn/40 bg-warn/5 p-6">
          <p className="text-sm text-warn">Could not reach the chain.</p>
          <p className="mt-2 font-mono text-xs break-all text-mist">{error}</p>
        </div>
      )}

      {isDeployed && !error && rows.length === 0 && (
        <p className="mt-10 text-sm text-mist">
          No programs yet. The contract is live and waiting for its first client.
        </p>
      )}

      {rows.length > 0 && (
        <ul className="mt-10 grid gap-px overflow-hidden rounded-lg border border-line bg-line">
          {rows.map((r) => (
            <li key={String(r.id)} className="bg-ink-soft p-6">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="text-base text-chalk">Program #{String(r.id)}</h2>
                <span className="text-xs text-mist">{ProgramStatus[r.status] ?? "?"}</span>
              </div>
              <dl className="mt-4 grid gap-4 text-xs sm:grid-cols-4">
                <div>
                  <dt className="text-mist">escrow</dt>
                  <dd className="mt-1 text-chalk">{formatEther(r.pool)}</dd>
                </div>
                <div>
                  <dt className="text-mist">top severity</dt>
                  <dd className="mt-1 text-chalk">{formatEther(r.topTier)}</dd>
                </div>
                <div>
                  <dt className="text-mist">open reports</dt>
                  <dd className="mt-1 text-chalk">{String(r.pending)}</dd>
                </div>
                <div>
                  <dt className="text-mist">client</dt>
                  <dd className="mt-1">
                    <a className="text-bug underline underline-offset-4" href={addressUrl(r.owner)}>
                      {r.owner.slice(0, 10)}…
                    </a>
                  </dd>
                </div>
              </dl>
              {r.scopeURI && (
                <p className="mt-4 truncate text-xs text-mist">scope: {r.scopeURI}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
