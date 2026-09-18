"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { bountyAbi, severityIndexOf } from "@/lib/contract";
import { useProtocolMeta, useBounty } from "@/lib/reads";
import { useTx } from "@/lib/useTx";
import { assetInfo, chainMeta, SUPPORTED_CHAINS } from "@/lib/chains";
import { fmtAmount, short } from "@/lib/format";
import { Button, Card, Copyable, Field, Select } from "@/components/ui";
import { severityMeta, SEVERITIES, type Severity } from "@/lib/db";

type QueueItem = {
  id: number;
  programId: number;
  hunter: string;
  commitHash: string;
  reportURI: string;
  submittedAt: number;
  triagedAt: number;
  triageDeadline: number;
  escalatedFromPending: boolean;
  bond: string;
  program: {
    id: number;
    status: number;
    pending: number;
    pool: string;
    bond: string;
    freePool: string;
    rewardToken: string;
    tiers: string[];
  } | null;
};

/**
 * The arbiter's console.
 *
 * Everything shown is read from the chain, because an arbiter is normally neither
 * the hunter nor the program owner and the index deliberately hides those rows
 * from everyone else. The authority to rule is `onlyArbiter` in the contract, so
 * this screen doesn't pretend to gate anything. It explains the case and lets the
 * arbiter sign, and the contract rejects anyone else.
 *
 * The one thing it insists on saying out loud: if the pool can't cover the award,
 * the client's $SWARM bond is forfeited to the hunter pro rata, as a penalty rather
 * than a make whole. Ruling "valid" is not free, and whoever rules should know it.
 */
export function ArbiterConsole() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { meta } = useBounty();
  const protocol = useProtocolMeta();

  const [chain, setChain] = useState<number>(chainId || SUPPORTED_CHAINS[0].id);
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [windowInfo, setWindowInfo] = useState<{ from: number; to: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/arbiter/queue?chain=${chain}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Couldn't read the queue.");
      setQueue(body.escalated as QueueItem[]);
      setWindowInfo(body.window as { from: number; to: number });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read the queue.");
    } finally {
      setLoading(false);
    }
  }, [chain]);

  useEffect(() => {
    void load();
  }, [load]);

  const arbiter = protocol.arbiter;
  const isArbiter = !!address && !!arbiter && address.toLowerCase() === arbiter.toLowerCase();
  const targetMeta = chainMeta(chain);

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-chalk">Arbitration</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-mist">
              Escalated findings, read live from {targetMeta.label}. Resolving one is a plain contract call that only the
              arbiter can make.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={chain} onChange={(e) => setChain(Number(e.target.value))} className="text-xs">
              {SUPPORTED_CHAINS.map((c) => (
                <option key={c.id} value={c.id} disabled={!chainMeta(c.id).bounty}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Button variant="ghost" onClick={load} disabled={loading}>
              {loading ? "..." : "refresh"}
            </Button>
          </div>
        </div>

        <div className="mt-3 rounded border border-line bg-ink p-3 text-[11px]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-mist">arbiter</span>
            {arbiter ? (
              <Copyable value={arbiter} display={short(arbiter)} />
            ) : (
              <span className="text-amber-300">
                unset on {targetMeta.label}. Escalations can&apos;t be ruled on until `setArbiter` is called, and it is
                one shot
              </span>
            )}
          </div>
          {isArbiter ? (
            <p className="mt-2 text-bug">Your connected wallet is the arbiter.</p>
          ) : (
            <p className="mt-2 text-mist">
              {isConnected
                ? "Your connected wallet isn't the arbiter, so the contract will reject any ruling you send. You can still read the cases below."
                : "Connect a wallet to rule."}
            </p>
          )}
        </div>

        {chainId !== chain && isConnected && (
          <button
            onClick={() => switchChain({ chainId: chain })}
            className="mt-2 text-[11px] text-bug underline underline-offset-4"
          >
            Switch wallet to {targetMeta.short}
          </button>
        )}
      </Card>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {queue && queue.length === 0 && (
        <Card className="p-5">
          <p className="text-xs leading-relaxed text-mist">
            Nothing is escalated.{" "}
            {windowInfo && (
              <>
                (Read submissions #{windowInfo.from} through #{windowInfo.to}. The scan is bounded because reading logs from
                genesis is unreliable on these chains, so older escalated ids, if any, wouldn&apos;t appear here.)
              </>
            )}
          </p>
        </Card>
      )}

      {queue?.map((item) => (
        <Case key={item.id} item={item} chainId={chain} canRule={isArbiter && chainId === chain} onDone={load} />
      ))}
    </div>
  );
}

function Case({
  item,
  chainId,
  canRule,
  onDone,
}: {
  item: QueueItem;
  chainId: number;
  canRule: boolean;
  onDone: () => void;
}) {
  const [valid, setValid] = useState(true);
  const [severity, setSeverity] = useState<Severity>("medium");
  const [slash, setSlash] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const tx = useTx(onDone);
  const { address } = useAccount();
  const { meta } = useBounty();

  const tiers: string[] = item.program?.tiers ?? ["0", "0", "0", "0"];
  const rewardToken = (item.program?.rewardToken ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
  const info = assetInfo(chainId, rewardToken);
  const award = BigInt(tiers[severityIndexOf(severity) - 1] ?? "0");
  const pool = BigInt(item.program?.pool ?? "0");
  const shortfall = valid && award > pool ? award - pool : 0n;
  const clientBond = BigInt(item.program?.bond ?? "0");
  // Forfeited pro rata to the unpaid share of the award. A dimensionless ratio,
  // because the bond is $SWARM and the award is the program's reward token.
  const bondForfeit = shortfall > 0n && award > 0n ? (clientBond * shortfall) / award : 0n;

  const grounds = item.escalatedFromPending
    ? "Triage SLA lapsed. The owner never decided, and the escrow covering this finding is still reserved."
    : "The hunter is disputing a recorded verdict, inside the seven day window.";

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-chalk">Submission #{item.id}</h3>
          <p className="mt-1 text-[11px] text-mist">
            program #{item.programId}, hunter {short(item.hunter)}, filed{" "}
            {new Date(item.submittedAt * 1000).toLocaleString()}
          </p>
        </div>
        <div className="text-right text-[11px] text-mist">
          <div>escrow {fmtAmount(pool, info.decimals, info.symbol)}</div>
          <div>open findings {item.program?.pending ?? "?"}</div>
          <div>client bond {fmtAmount(clientBond, 18, "$SWARM")}</div>
        </div>
      </div>

      <p className="mt-3 rounded border border-orange-500/30 bg-orange-500/[0.06] p-2.5 text-[11px] leading-relaxed text-mist">
        {grounds}
      </p>

      <dl className="mt-3 space-y-1 text-[11px]">
        <div className="flex gap-2">
          <dt className="text-mist">commit</dt>
          <dd className="font-mono break-all text-chalk">{item.commitHash}</dd>
        </div>
        {item.reportURI ? (
          <div className="flex gap-2">
            <dt className="text-mist">report</dt>
            <dd className="break-all">
              <a href={item.reportURI} target="_blank" rel="noreferrer" className="text-bug underline underline-offset-4">
                {item.reportURI}
              </a>
            </dd>
          </div>
        ) : (
          <div className="flex gap-2">
            <dt className="text-mist">report</dt>
            <dd className="text-amber-300">
              not revealed. The hunter hasn&apos;t published it yet. Nothing can be ruled on without the evidence, and
              only the hunter can reveal.
            </dd>
          </div>
        )}
        {item.bond !== "0" && (
          <div className="flex gap-2">
            <dt className="text-mist">hunter bond</dt>
            <dd className="text-chalk">{fmtAmount(BigInt(item.bond), 18, "$SWARM")}</dd>
          </div>
        )}
      </dl>

      <div className="mt-4 space-y-3 border-t border-line pt-4">
        <Field label="Finding is a real, in scope vulnerability?">
          <div className="flex gap-2">
            <Button variant={valid ? "primary" : "ghost"} onClick={() => setValid(true)} type="button">
              Valid
            </Button>
            <Button variant={!valid ? "danger" : "ghost"} onClick={() => setValid(false)} type="button">
              Not valid
            </Button>
          </div>
        </Field>

        {valid && (
          <Field label="Severity to pay">
            <div className="flex flex-wrap gap-1.5">
              {SEVERITIES.map((s) => {
                const t = BigInt(tiers[severityIndexOf(s) - 1] ?? "0");
                const on = severity === s;
                return (
                  <button
                    key={s}
                    type="button"
                    disabled={t === 0n}
                    title={t === 0n ? "That tier is zero on chain, so the contract would revert" : undefined}
                    onClick={() => setSeverity(s)}
                    className={`rounded-md border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
                      on ? severityMeta[s].tone + " bg-panel" : "border-line text-mist hover:text-chalk"
                    }`}
                  >
                    {severityMeta[s].label}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-[11px] text-mist">
              Pays <span className="text-bug">{fmtAmount(award, info.decimals, info.symbol)}</span> from the pool.
            </p>
          </Field>
        )}

        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={slash}
            onChange={(e) => setSlash(e.target.checked)}
            className="mt-0.5 size-4 accent-[var(--color-bug)]"
          />
          <span className="text-[11px] leading-relaxed text-mist">
            <span className="text-chalk">Slash the hunter&apos;s bond</span>, and only for a bad faith submission. Losing an
            appeal in good faith must not cost them the bond, which is why this is opt in.
          </span>
        </label>

        {shortfall > 0n && (
          <p className="rounded border border-amber-500/30 bg-amber-500/[0.06] p-2.5 text-[11px] leading-relaxed text-mist">
            The pool can&apos;t cover this award. Escrow pays{" "}
            <span className="text-chalk">{fmtAmount(pool, info.decimals, info.symbol)}</span> and the client&apos;s $SWARM
            bond is forfeited to the hunter pro rata, roughly{" "}
            <span className="text-chalk">{fmtAmount(bondForfeit, 18, "$SWARM")}</span>. That is a penalty on the client,
            not a make whole for the hunter: the bond and the reward are different assets.
          </p>
        )}

        <Button
          disabled={!canRule || tx.busy || !meta.bounty || !address}
          onClick={async () => {
            setNote(null);
            const hash = await tx.run({
              address: meta.bounty!,
              abi: bountyAbi,
              functionName: "resolveEscalation",
              args: [BigInt(item.id), valid, valid ? severityIndexOf(severity) : 0, slash],
            });
            if (hash) setNote("Ruling recorded. The status here refreshes from the chain.");
          }}
        >
          {tx.busy ? "..." : valid ? `Rule valid at ${severity}` : "Rule not valid"}
        </Button>

        {!canRule && (
          <p className="text-[11px] text-mist">Only the arbiter wallet, on this chain, can send this.</p>
        )}
        {tx.error && <p className="text-[11px] text-red-400">{tx.error}</p>}
        {note && <p className="text-[11px] text-bug">{note}</p>}
      </div>
    </Card>
  );
}
