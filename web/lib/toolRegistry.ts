"use client";

import { useChainId, useReadContracts } from "wagmi";
import { chainMeta } from "./chains";
import { toolRegistryAbi } from "./toolRegistry.abi";

// Re-export the pure ABI/enums/types so existing `@/lib/toolRegistry` imports
// keep resolving; the data itself lives in the server-safe ./toolRegistry.abi.
export * from "./toolRegistry.abi";

/**
 * ToolRegistry — the on-chain source of truth for the community tool
 * marketplace. Publisher, checksum, metadata URI, stake and versions live here;
 * a Supabase mirror indexes the same rows for fast search. `address` is null on
 * chains where the registry isn't deployed yet — callers gate on `isDeployed`,
 * exactly like `useBounty`. Browsing works off the mirror pre-deployment;
 * publishing (which stakes $BUG) needs the contract live.
 */
export function useToolRegistry() {
  const chainId = useChainId();
  const meta = chainMeta(chainId);
  return { chainId, meta, address: meta.toolRegistry, isDeployed: meta.toolRegistry !== null };
}

/** Registry-wide params for the publish form and admin views. */
export function useRegistryMeta() {
  const { address: registry } = useToolRegistry();
  const base = { address: registry ?? undefined, abi: toolRegistryAbi } as const;
  const { data } = useReadContracts({
    contracts: [
      { ...base, functionName: "nextToolId" },
      { ...base, functionName: "minStake" },
      { ...base, functionName: "flagRewardBps" },
      { ...base, functionName: "bugToken" },
      { ...base, functionName: "arbiter" },
    ],
    query: { enabled: !!registry },
  });
  const val = <T,>(i: number) => (data?.[i]?.status === "success" ? (data[i].result as T) : undefined);
  return {
    nextToolId: val<bigint>(0),
    minStake: val<bigint>(1),
    flagRewardBps: val<bigint>(2),
    bugToken: val<`0x${string}`>(3),
    arbiter: val<`0x${string}`>(4),
  };
}
