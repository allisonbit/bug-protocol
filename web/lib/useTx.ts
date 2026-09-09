"use client";

import { useCallback, useState } from "react";
import { useWriteContract, usePublicClient } from "wagmi";
import type { Abi } from "viem";

export type TxState = "idle" | "signing" | "pending" | "success" | "error";

/**
 * One-shot contract write with receipt confirmation. Returns a `run` you call
 * with the write args, plus reactive state for buttons and inline status.
 * Callers pass an `onDone` to refetch reads after confirmation.
 */
export function useTx(onDone?: () => void) {
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const [state, setState] = useState<TxState>("idle");
  const [hash, setHash] = useState<`0x${string}` | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (args: {
      address: `0x${string}`;
      abi: Abi;
      functionName: string;
      args?: readonly unknown[];
      value?: bigint;
    }) => {
      setError(null);
      setHash(null);
      setState("signing");
      try {
        const h = await writeContractAsync(args as Parameters<typeof writeContractAsync>[0]);
        setHash(h);
        setState("pending");
        await publicClient?.waitForTransactionReceipt({ hash: h });
        setState("success");
        onDone?.();
        return h;
      } catch (e: unknown) {
        setState("error");
        setError(humanizeError(e));
        return null;
      }
    },
    [writeContractAsync, publicClient, onDone],
  );

  const reset = useCallback(() => {
    setState("idle");
    setHash(null);
    setError(null);
  }, []);

  return { run, reset, state, hash, error, busy: state === "signing" || state === "pending" };
}

/** Pulls the useful line out of a viem/wallet error blob. */
export function humanizeError(e: unknown): string {
  if (!e) return "Unknown error";
  const msg = e instanceof Error ? e.message : String(e);
  // Prefer a revert reason if present.
  const revert = msg.match(/reverted with (?:the following reason:\s*)?([^\n]+)/i);
  if (revert) return revert[1].trim();
  const custom = msg.match(/Error: ([A-Za-z]+)\(/);
  if (custom) return `Reverted: ${custom[1]}`;
  if (/User rejected|denied|rejected the request/i.test(msg)) return "Transaction rejected in wallet";
  if (/insufficient funds/i.test(msg)) return "Insufficient funds for gas";
  // First sentence, capped.
  return msg.split("\n")[0].slice(0, 200);
}
