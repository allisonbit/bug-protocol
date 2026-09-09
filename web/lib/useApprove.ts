"use client";

import { useCallback, useState } from "react";
import { usePublicClient, useWriteContract } from "wagmi";
import { maxUint256, type Address } from "viem";
import { erc20Abi } from "./erc20";
import { humanizeError } from "./useTx";

/**
 * Ensures `spender` has at least `amount` allowance of `token` from `owner`,
 * sending an approve (to max) only when the current allowance is short. Used
 * before any $BUG bond or ERC-20 reward funding call.
 */
export function useApprove() {
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [state, setState] = useState<"idle" | "checking" | "approving" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const ensure = useCallback(
    async (token: Address, owner: Address, spender: Address, amount: bigint): Promise<boolean> => {
      setError(null);
      if (!publicClient) return false;
      try {
        setState("checking");
        const current = (await publicClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "allowance",
          args: [owner, spender],
        })) as bigint;
        if (current >= amount) {
          setState("ready");
          return true;
        }
        setState("approving");
        const hash = await writeContractAsync({
          address: token,
          abi: erc20Abi,
          functionName: "approve",
          args: [spender, maxUint256],
        });
        await publicClient.waitForTransactionReceipt({ hash });
        setState("ready");
        return true;
      } catch (e) {
        setState("error");
        setError(humanizeError(e));
        return false;
      }
    },
    [publicClient, writeContractAsync],
  );

  return { ensure, state, error };
}
