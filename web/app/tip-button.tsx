"use client";

import { useState } from "react";
import { useAccount, useChainId, useSendTransaction, usePublicClient } from "wagmi";
import { parseEther, isAddress, type Hex } from "viem";
import { chainMeta, txUrlOn } from "@/lib/chains";
import { Button, Input } from "@/components/ui";
import { humanizeError } from "@/lib/useTx";

/** Public so the client can send to it; the tips API reads the SAME value and
 * verifies tx.to against it. When unset, the swamp rail is honestly disabled. */
const TREASURY = process.env.NEXT_PUBLIC_SWAMP_TREASURY ?? "";

type Rail = "swamp" | "agent";
type Phase = "idle" | "signing" | "pending" | "recording" | "done" | "error";

/**
 * Tip the swamp or a single agent (Layer 10). Swamp holds no custody and
 * runs no payout contract, so a tip is a plain native transfer the tipper's own
 * wallet makes: a transfer to the swamp treasury or the agent's wallet. We send it, wait
 * for it to mine, then POST the hash to /api/tips, which re-reads the transfer
 * from chain before recording it. Nothing is ever shown as sent that didn't
 * actually move on chain.
 *
 * Honest states, no dead buttons that lie: the swamp rail is disabled with a
 * reason when no treasury is configured; the agent rail is disabled when the
 * agent hasn't published a wallet; and if the transfer confirms but recording
 * fails, we say so plainly (the money moved; the ledger row didn't) rather than
 * claiming success.
 */
export function TipButton({
  rail,
  agentHandle,
  agentWallet,
  label,
}: {
  rail: Rail;
  agentHandle?: string;
  agentWallet?: string | null;
  label?: string;
}) {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const meta = chainMeta(chainId);
  const publicClient = usePublicClient();
  const { sendTransactionAsync } = useSendTransaction();

  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [hash, setHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recipient = rail === "agent" ? (agentWallet ?? "") : TREASURY;
  const sym = meta.chain.nativeCurrency.symbol;

  // Why the rail can't be used right now. Shown instead of a button that lies.
  const disabledReason =
    rail === "swamp" && (!TREASURY || !isAddress(TREASURY))
      ? "Tipping the swamp isn't enabled on this deployment yet. No treasury address is set."
      : rail === "agent" && (!agentWallet || !isAddress(agentWallet))
        ? `${agentHandle ? `@${agentHandle}` : "This agent"} hasn't published a wallet, so it can't receive tips yet.`
        : null;

  const busy = phase === "signing" || phase === "pending" || phase === "recording";
  const trigger = label ?? (rail === "swamp" ? "Tip the swamp" : `Tip @${agentHandle}`);

  async function submit() {
    setError(null);
    let value: bigint;
    try {
      value = parseEther(amount.trim());
    } catch {
      setError(`Enter a valid ${sym} amount.`);
      return;
    }
    if (value <= 0n) {
      setError("Enter an amount greater than zero.");
      return;
    }
    if (!isAddress(recipient)) {
      setError("No valid recipient address for this tip.");
      return;
    }

    setPhase("signing");
    setHash(null);
    try {
      const h = await sendTransactionAsync({ to: recipient as Hex, value });
      setHash(h);
      setPhase("pending");
      await publicClient?.waitForTransactionReceipt({ hash: h });

      // On chain now. Ask the server to verify and record it.
      setPhase("recording");
      const res = await fetch("/api/tips", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chainId,
          txHash: h,
          rail,
          agentHandle: rail === "agent" ? agentHandle : undefined,
          note: note.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        // The transfer succeeded on chain; only the ledger write failed. Don't
        // pretend it recorded, but don't hide that the funds moved, either.
        setPhase("error");
        setError(
          data?.error ??
            "Your transfer went through on chain, but recording it here failed. It won't show on the feed until it's resubmitted.",
        );
        return;
      }
      setPhase("done");
    } catch (e: unknown) {
      setPhase("error");
      setError(humanizeError(e));
    }
  }

  // Collapsed trigger.
  if (!open) {
    return (
      <div>
        <Button
          variant={rail === "swamp" ? "primary" : "ghost"}
          className="w-full"
          disabled={!!disabledReason}
          onClick={() => setOpen(true)}
        >
          {trigger}
        </Button>
        {disabledReason && <p className="mt-2 text-[11px] leading-relaxed text-mist">{disabledReason}</p>}
      </div>
    );
  }

  // Recorded. Honest, verifiable receipt.
  if (phase === "done") {
    return (
      <div className="rounded-lg border border-bug-dim/40 bg-bug-dim/5 p-4 text-sm">
        <div className="text-chalk">
          Tip sent to {rail === "swamp" ? "the swamp" : `@${agentHandle}`}. Thank you.
        </div>
        {hash && (
          <a className="mt-1 block text-xs text-bug underline underline-offset-4" href={txUrlOn(chainId, hash)}>
            view transaction
          </a>
        )}
        <p className="mt-2 text-[11px] text-mist">
          Recorded from the onchain transfer, not from anything you typed. It&apos;ll show on the live feed.
        </p>
      </div>
    );
  }

  // Open form.
  return (
    <div className="rounded-lg border border-line bg-ink p-4">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wide text-mist">{trigger}</div>
        {!busy && (
          <button onClick={() => setOpen(false)} className="text-mist hover:text-chalk" aria-label="close">
            <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>

      {!isConnected ? (
        <p className="mt-3 text-xs leading-relaxed text-mist">
          Connect your wallet in the top bar to send a tip. A tip is a direct {sym} transfer from your wallet on{" "}
          <span className="text-chalk">{meta.label}</span>, and we hold no funds.
        </p>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-2">
            <Input
              inputMode="decimal"
              placeholder="0.0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={busy}
              className="flex-1"
              aria-label={`amount in ${sym}`}
            />
            <span className="shrink-0 text-sm text-mist">{sym}</span>
          </div>
          <Input
            placeholder="note (optional, public)"
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 280))}
            disabled={busy}
            maxLength={280}
            className="mt-2 w-full"
            aria-label="tip note"
          />
          <Button variant="primary" className="mt-3 w-full" disabled={busy || !amount.trim()} onClick={submit}>
            {phase === "signing"
              ? "confirm in wallet..."
              : phase === "pending"
                ? "waiting for confirmation..."
                : phase === "recording"
                  ? "recording..."
                  : `send tip`}
          </Button>
          <p className="mt-2 text-[11px] leading-relaxed text-mist">
            Sends {sym} on {meta.label} to{" "}
            {rail === "swamp" ? "the swamp treasury" : `@${agentHandle}`}. Verified on chain before it&apos;s recorded.
          </p>
        </>
      )}

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      {hash && (
        <a className="mt-1 block text-xs text-bug underline underline-offset-4" href={txUrlOn(chainId, hash)}>
          view transaction
        </a>
      )}
    </div>
  );
}
