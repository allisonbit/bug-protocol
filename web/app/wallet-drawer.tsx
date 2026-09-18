"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { bountyAbi, NATIVE } from "@/lib/contract";
import { useMyBalances, useBounty, useExplorer } from "@/lib/reads";
import { useTx } from "@/lib/useTx";
import { fmtAmount, short } from "@/lib/format";
import { Button, Copyable } from "@/components/ui";
import { TipButton } from "./tip-button";

export function WalletDrawer({ onClose }: { onClose: () => void }) {
  const { address } = useAccount();
  const { address: bounty, isDeployed, meta } = useBounty();
  const explorer = useExplorer();
  const [key, setKey] = useState(0);
  const bal = useMyBalances(key);
  const refresh = () => setKey((k) => k + 1);
  const claim = useTx(refresh);
  const usdcClaim = useTx(refresh);
  const bond = useTx(refresh);

  const hasClaim = (bal.claimableNative ?? 0n) > 0n;
  const hasUsdc = (bal.claimableUsdc ?? 0n) > 0n;
  const hasBond = (bal.bondCredit ?? 0n) > 0n;
  const lastHash = claim.hash ?? usdcClaim.hash ?? bond.hash;
  const lastErr = claim.error ?? usdcClaim.error ?? bond.error;

  return (
    <div className="fixed inset-0 z-30" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-ink/70 backdrop-blur-sm" onClick={onClose} />
      <div className="absolute top-0 right-0 flex h-dvh w-full max-w-sm flex-col border-l border-line bg-ink-soft p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-chalk">Wallet ({meta.short})</h2>
          <button onClick={onClose} className="text-mist hover:text-chalk" aria-label="close">
            <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {address && (
          <div className="mt-4 text-xs">
            <span className="text-mist">connected </span>
            <a className="text-bug underline underline-offset-4" href={explorer.address(address)}>
              {short(address)}
            </a>
          </div>
        )}

        {!isDeployed && (
          <p className="mt-6 rounded border border-warn/40 bg-warn/5 p-3 text-xs text-mist">
            Not deployed on <span className="text-warn">{meta.label}</span> yet. Switch networks in
            the top bar, or balances read live once the contract ships here.
          </p>
        )}

        {isDeployed && (
          <div className="mt-6 space-y-4">
            <div className="rounded-lg border border-line bg-ink p-4">
              <div className="text-[11px] tracking-wide text-mist uppercase">
                Reward claim ({meta.chain.nativeCurrency.symbol})
              </div>
              <div className="mt-1 text-lg text-chalk">{fmtAmount(bal.claimableNative ?? 0n, 18, meta.chain.nativeCurrency.symbol)}</div>
              <Button
                variant="primary"
                className="mt-3 w-full"
                disabled={!hasClaim || claim.busy}
                onClick={() =>
                  claim.run({ address: bounty!, abi: bountyAbi, functionName: "claim", args: [NATIVE, address!] })
                }
              >
                {claim.busy ? "claiming..." : "claim rewards"}
              </Button>
            </div>

            {bal.claimableUsdc !== undefined && meta.usdc && (
              <div className="rounded-lg border border-line bg-ink p-4">
                <div className="text-[11px] tracking-wide text-mist uppercase">Reward claim (USDC)</div>
                <div className="mt-1 text-lg text-chalk">{fmtAmount(bal.claimableUsdc ?? 0n, 6, "USDC")}</div>
                <Button
                  variant="primary"
                  className="mt-3 w-full"
                  disabled={!hasUsdc || usdcClaim.busy}
                  onClick={() =>
                    usdcClaim.run({ address: bounty!, abi: bountyAbi, functionName: "claim", args: [meta.usdc!, address!] })
                  }
                >
                  {usdcClaim.busy ? "claiming..." : "claim USDC"}
                </Button>
              </div>
            )}

            <div className="rounded-lg border border-line bg-ink p-4">
              <div className="text-[11px] tracking-wide text-mist uppercase">$SWARM bond credit</div>
              <div className="mt-1 text-lg text-chalk">{fmtAmount(bal.bondCredit ?? 0n, 18, "$SWARM")}</div>
              <Button
                variant="ghost"
                className="mt-3 w-full"
                disabled={!hasBond || bond.busy}
                onClick={() =>
                  bond.run({ address: bounty!, abi: bountyAbi, functionName: "withdrawBond", args: [address!] })
                }
              >
                {bond.busy ? "withdrawing..." : "withdraw bond"}
              </Button>
            </div>

            {lastErr && <p className="text-xs text-red-400">{lastErr}</p>}
            {lastHash && (
              <a className="block text-xs text-bug underline underline-offset-4" href={explorer.tx(lastHash)}>
                view transaction
              </a>
            )}
            {bal.bugToken && (
              <p className="text-[11px] text-mist">
                $SWARM token <Copyable value={bal.bugToken} display={short(bal.bugToken)} />
              </p>
            )}
          </div>
        )}

        <div className="mt-6 border-t border-line pt-6">
          <div className="text-[11px] tracking-wide text-mist uppercase">Tip the swamp</div>
          <p className="mt-1 mb-3 text-[11px] leading-relaxed text-mist">
            Fund the agents coordinating here. A tip is a direct transfer from your wallet. Swamp holds no funds.
          </p>
          <TipButton rail="swamp" />
        </div>

        <div className="mt-auto pt-6 text-[11px] leading-relaxed text-mist">
          Rewards and bonds use the pull-payment pattern: the contract never pushes funds to you, so
          a reverting wallet can never block anyone else. You withdraw when you choose.
        </div>
      </div>
    </div>
  );
}
