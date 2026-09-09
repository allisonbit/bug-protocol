"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { keccak256, parseEther, parseUnits } from "viem";
import { bountyAbi, type ProgramView } from "@/lib/contract";
import { useTx } from "@/lib/useTx";
import { useApprove } from "@/lib/useApprove";
import { useBounty, useExplorer } from "@/lib/reads";
import { assetInfo } from "@/lib/chains";
import { fmtAmount, isNative } from "@/lib/format";
import { Button, Card, Field, Input, SectionTitle, Textarea } from "@/components/ui";

const SEV = ["Low", "Medium", "High", "Critical"] as const;

export function OwnerPanel({
  programId,
  program,
  topTier,
  freePool,
  pending,
  tiers,
  minProgramBond,
  bugToken,
  onDone,
}: {
  programId: bigint;
  program: ProgramView;
  topTier: bigint;
  freePool: bigint;
  pending: bigint;
  tiers: readonly bigint[];
  minProgramBond: bigint;
  bugToken?: `0x${string}`;
  onDone: () => void;
}) {
  const { address } = useAccount();
  const { address: bounty, chainId } = useBounty();
  const explorer = useExplorer();
  const tx = useTx(onDone);
  const approve = useApprove();

  // The reward asset drives symbol + decimals so ETH and USDC both parse/format.
  const asset = assetInfo(chainId, program.rewardToken);
  const dec = asset.decimals;
  const sym = asset.symbol;
  const nativeReward = isNative(program.rewardToken);

  const [fund, setFund] = useState("");
  const [bond, setBond] = useState("");
  const [wd, setWd] = useState("");
  const [scopeText, setScopeText] = useState("");
  const [scopeURI, setScopeURI] = useState(program.scopeURI);
  const [tierEdit, setTierEdit] = useState<Record<string, string>>({ Low: "", Medium: "", High: "", Critical: "" });

  const canLive =
    program.scopeHash !== "0x0000000000000000000000000000000000000000000000000000000000000000" &&
    topTier > 0n &&
    program.pool >= topTier &&
    program.bond >= minProgramBond;

  const checklist = [
    { ok: topTier > 0n, label: "at least one payout tier set" },
    { ok: program.pool >= topTier && topTier > 0n, label: `escrow ≥ top tier (${fmtAmount(topTier, dec, sym)})` },
    { ok: program.bond >= minProgramBond, label: `client bond ≥ ${fmtAmount(minProgramBond, 18, "$BUG")}` },
  ];

  // Native reward funds via msg.value; ERC-20 (USDC etc.) needs approve + pull.
  const doFund = async () => {
    const v = parseUnits(fund || "0", dec);
    if (nativeReward) {
      tx.run({ address: bounty!, abi: bountyAbi, functionName: "fundProgram", args: [programId, v], value: v });
    } else {
      if (!address) return;
      const ok = await approve.ensure(program.rewardToken, address, bounty!, v);
      if (!ok) return;
      tx.run({ address: bounty!, abi: bountyAbi, functionName: "fundProgram", args: [programId, v] });
    }
  };

  const doBond = async () => {
    if (!bugToken || !address) return;
    const amt = parseEther(bond || "0"); // $BUG is 18-decimal
    const ok = await approve.ensure(bugToken, address, bounty!, amt);
    if (!ok) return;
    tx.run({ address: bounty!, abi: bountyAbi, functionName: "bondProgram", args: [programId, amt] });
  };

  const setStatus = (next: number) =>
    tx.run({ address: bounty!, abi: bountyAbi, functionName: "setStatus", args: [programId, next] });

  const doScope = () => {
    if (!scopeText.trim() || !scopeURI.trim()) return;
    const h = keccak256(new TextEncoder().encode(scopeText));
    tx.run({ address: bounty!, abi: bountyAbi, functionName: "setScope", args: [programId, h, scopeURI.trim()] });
  };

  const doWithdraw = () => {
    tx.run({ address: bounty!, abi: bountyAbi, functionName: "withdrawPool", args: [programId, address!, parseUnits(wd || "0", dec)] });
  };

  const doSetTier = (sevIndex: number, value: string) => {
    tx.run({ address: bounty!, abi: bountyAbi, functionName: "setPayoutTier", args: [programId, sevIndex, parseUnits(value || "0", dec)] });
  };

  return (
    <Card className="border-bug-dim/40 p-5">
      <div className="flex items-center justify-between">
        <SectionTitle>Client control panel</SectionTitle>
        <span className="text-[11px] text-mist">owner only · {sym} escrow</span>
      </div>

      {/* Lifecycle */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        {program.status === 0 && (
          <Button variant="primary" disabled={!canLive || tx.busy} onClick={() => setStatus(1)}>
            go live
          </Button>
        )}
        {program.status === 1 && (
          <Button variant="ghost" disabled={tx.busy} onClick={() => setStatus(2)}>
            pause
          </Button>
        )}
        {program.status === 2 && (
          <Button variant="primary" disabled={tx.busy} onClick={() => setStatus(1)}>
            resume
          </Button>
        )}
        {program.status !== 3 && (
          <Button
            variant="danger"
            disabled={tx.busy}
            onClick={() => {
              if (confirm("Close permanently? This cannot be undone.")) setStatus(3);
            }}
          >
            close
          </Button>
        )}
        {program.status === 3 && pending === 0n && program.bond > 0n && (
          <Button
            variant="ghost"
            disabled={tx.busy}
            onClick={() => tx.run({ address: bounty!, abi: bountyAbi, functionName: "reclaimProgramBond", args: [programId, address!] })}
          >
            reclaim {fmtAmount(program.bond, 18, "$BUG")} bond
          </Button>
        )}
      </div>

      {program.status === 0 && (
        <ul className="mt-4 space-y-1 text-xs">
          {checklist.map((c) => (
            <li key={c.label} className={c.ok ? "text-bug" : "text-mist"}>
              {c.ok ? "✓" : "○"} {c.label}
            </li>
          ))}
        </ul>
      )}

      {/* Fund / bond / withdraw */}
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <div className="rounded border border-line bg-ink p-4">
          <Field label={`Fund escrow (${sym})`} hint={nativeReward ? "Adds reward funds. Anyone can top up." : "Approves + deposits the ERC-20 reward."}>
            <div className="flex gap-2">
              <Input type="number" min="0" step="0.001" value={fund} onChange={(e) => setFund(e.target.value)} placeholder="0.0" />
              <Button variant="primary" disabled={tx.busy || !fund} onClick={doFund}>
                {approve.state === "approving" ? "approving…" : "fund"}
              </Button>
            </div>
          </Field>
        </div>

        <div className="rounded border border-line bg-ink p-4">
          <Field label="Post $BUG bond" hint={bugToken ? "Slashable good-faith bond. Approve + deposit." : "Requires $BUG token (set on deploy)."}>
            <div className="flex gap-2">
              <Input type="number" min="0" step="1" value={bond} onChange={(e) => setBond(e.target.value)} placeholder="0" disabled={!bugToken} />
              <Button variant="primary" disabled={tx.busy || !bond || !bugToken} onClick={doBond}>
                {approve.state === "approving" ? "approving…" : "bond"}
              </Button>
            </div>
          </Field>
        </div>

        <div className="rounded border border-line bg-ink p-4">
          <Field label={`Withdraw free (${fmtAmount(freePool, dec, sym)})`} hint="Only escrow not reserved for open reports.">
            <div className="flex gap-2">
              <Input type="number" min="0" step="0.001" value={wd} onChange={(e) => setWd(e.target.value)} placeholder="0.0" />
              <Button variant="ghost" disabled={tx.busy || !wd} onClick={doWithdraw}>
                withdraw
              </Button>
            </div>
          </Field>
        </div>
      </div>

      {/* Tiers (only mutable with nothing pending) */}
      <div className="mt-6 rounded border border-line bg-ink p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs text-chalk">Payout tiers ({sym})</span>
          {pending > 0n && <span className="text-[11px] text-warn">locked while {String(pending)} report(s) open</span>}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {SEV.map((s, i) => (
            <div key={s}>
              <div className="text-[11px] text-mist">
                {s} · now {fmtAmount(tiers[i + 1], dec)}
              </div>
              <div className="mt-1 flex gap-1">
                <Input
                  type="number"
                  min="0"
                  step="0.001"
                  value={tierEdit[s]}
                  disabled={pending > 0n}
                  onChange={(e) => setTierEdit((t) => ({ ...t, [s]: e.target.value }))}
                  placeholder="set"
                />
                <Button variant="ghost" className="px-2" disabled={pending > 0n || tx.busy || !tierEdit[s]} onClick={() => doSetTier(i + 1, tierEdit[s])}>
                  ✓
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Scope update */}
      <details className="mt-6 rounded border border-line bg-ink p-4">
        <summary className="cursor-pointer text-xs text-chalk">Update scope document</summary>
        <div className="mt-4 space-y-3">
          <Textarea rows={5} value={scopeText} onChange={(e) => setScopeText(e.target.value)} placeholder="Paste the new scope + safe-harbour text…" />
          <Input value={scopeURI} onChange={(e) => setScopeURI(e.target.value)} placeholder="https://…/scope.txt" />
          <Button variant="ghost" disabled={tx.busy || !scopeText.trim() || !scopeURI.trim()} onClick={doScope}>
            hash & update scope
          </Button>
        </div>
      </details>

      {(tx.error || approve.error) && <p className="mt-4 text-xs text-red-400">{tx.error ?? approve.error}</p>}
      {tx.hash && (
        <a className="mt-3 block text-xs text-bug underline" href={explorer.tx(tx.hash)}>
          view last transaction ↗
        </a>
      )}
    </Card>
  );
}
